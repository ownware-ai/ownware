/**
 * `ownware profile` — the profile lifecycle as one consistent noun group, so
 * building, inspecting, editing, and removing agents all read the same way:
 *
 *   ownware profile new <name> [--model <m>] [--description <d>] [--open]
 *   ownware profile list
 *   ownware profile show <name>
 *   ownware profile set  <name> [--model <m>] [--description <d>]
 *   ownware profile open <name>
 *   ownware profile remove <name> [--yes]
 *
 * `new/set/remove/open` operate on YOUR ./profiles — the bundled marketplace
 * profiles are read-only and never touched. The mutating helpers
 * (scaffold/set/remove/info) are pure and separated from console wiring so
 * they're unit-testable without a tty.
 */

import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { createInterface } from 'node:readline'
import { ProfileSchema } from '../profile/schema.js'
import { ProfileRegistry } from '../profile/registry.js'
import { initProfile, printInitResult, type InitOptions } from './init.js'
import { findProfilesDir, localProfilesDir } from './profiles-dir.js'

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
}

// ---------------------------------------------------------------------------
// Name safety — a profile name becomes a directory, so it must never escape
// ./profiles (path traversal) or carry separators.
// ---------------------------------------------------------------------------

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i

export function assertValidName(name: string): void {
  if (!name || name.includes('..') || !NAME_RE.test(name)) {
    throw new Error(
      `invalid profile name "${name}" — use letters, digits, dash or underscore (e.g. "sales-bot")`,
    )
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested; no console, no tty)
// ---------------------------------------------------------------------------

export type ScaffoldOptions = InitOptions

/** Create `./profiles/<name>`. Throws on a bad name. */
export function scaffoldProfile(cwd: string, name: string, opts: ScaffoldOptions = {}) {
  assertValidName(name)
  return initProfile(cwd, name, opts)
}

export interface ProfileFieldPatch {
  readonly model?: string
  readonly description?: string
}

/**
 * Apply a field patch to `./profiles/<name>/agent.json`, validating the
 * result against ProfileSchema BEFORE writing. Writes the minimal, mutated
 * JSON (not the schema-defaulted output) so the file stays hand-editable.
 * Returns the changed keys.
 */
export function setProfileFields(cwd: string, name: string, patch: ProfileFieldPatch): string[] {
  assertValidName(name)
  const agentPath = join(localProfilesDir(cwd), name, 'agent.json')
  if (!existsSync(agentPath)) {
    throw new Error(
      `no editable profile "${name}" in ${localProfilesDir(cwd)} — create one with \`ownware profile new ${name}\``,
    )
  }
  const raw = JSON.parse(readFileSync(agentPath, 'utf8')) as Record<string, unknown>
  const changed: string[] = []
  if (patch.model !== undefined) {
    raw.model = patch.model
    changed.push('model')
  }
  if (patch.description !== undefined) {
    raw.description = patch.description
    changed.push('description')
  }
  if (changed.length === 0) {
    throw new Error('nothing to set — pass --model and/or --description')
  }
  // Validation only: throws on an invalid config, but we persist `raw` so the
  // file doesn't balloon with every schema default.
  ProfileSchema.parse(raw)
  writeFileSync(agentPath, `${JSON.stringify(raw, null, 2)}\n`)
  return changed
}

/** Delete `./profiles/<name>`. Local only — the bundled marketplace is never
 *  removable. Throws if the directory isn't there. Returns the removed path. */
export function removeProfile(cwd: string, name: string): string {
  assertValidName(name)
  const dir = join(localProfilesDir(cwd), name)
  if (!existsSync(dir)) {
    throw new Error(`no profile "${name}" in ${localProfilesDir(cwd)}`)
  }
  rmSync(dir, { recursive: true, force: true })
  return dir
}

export interface ProfileInfo {
  readonly name: string
  readonly dir: string
  readonly model?: string
  readonly description?: string
  readonly files: string[]
}

/** Summarize a profile directory: config highlights + which files exist. */
export function profileInfo(dir: string): ProfileInfo {
  const agentPath = join(dir, 'agent.json')
  if (!existsSync(agentPath)) throw new Error(`no agent.json in ${dir}`)
  const cfg = JSON.parse(readFileSync(agentPath, 'utf8')) as {
    name?: string
    model?: string
    description?: string
  }
  const known = ['agent.json', 'SOUL.md', 'AGENTS.md', 'skills', 'tools']
  const files = known.filter((f) => existsSync(join(dir, f)))
  return {
    name: cfg.name ?? dir.split(/[/\\]/).pop() ?? '(unknown)',
    dir,
    ...(cfg.model !== undefined ? { model: cfg.model } : {}),
    ...(cfg.description !== undefined ? { description: cfg.description } : {}),
    files,
  }
}

// ---------------------------------------------------------------------------
// Side-effecting helpers (folder open, confirm)
// ---------------------------------------------------------------------------

/** Open a folder in the OS file manager. Non-blocking, detached, never throws. */
export function openFolder(target: string): boolean {
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'explorer' : 'xdg-open'
  try {
    const child = spawn(cmd, [target], { stdio: 'ignore', detached: true })
    child.on('error', () => {}) // swallow async spawn errors (e.g. no opener)
    child.unref()
    return true
  } catch {
    return false
  }
}

async function confirm(question: string): Promise<boolean> {
  // Non-interactive (piped/CI) must never silently delete — refuse instead.
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise<string>((res) => rl.question(question, res))
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
}

// ---------------------------------------------------------------------------
// Console handlers (per subcommand)
// ---------------------------------------------------------------------------

/** Shared list — `ownware profile list` AND `ownware profiles` both land here. */
export async function listProfilesCmd(cwd = process.cwd()): Promise<void> {
  const dir = findProfilesDir(cwd)
  const registry = new ProfileRegistry()
  await registry.discover(dir)
  const profiles = registry.list()

  if (profiles.length === 0) {
    console.log(
      `${c.yellow}No profiles in ${dir}${c.reset} — create one with \`ownware profile new <name>\`.`,
    )
    return
  }

  console.log(`\n${c.bold}Profiles${c.reset} ${c.dim}(${dir})${c.reset}\n`)
  for (const p of profiles) {
    const ro = p.readOnly ? ` ${c.dim}(read-only)${c.reset}` : ''
    const tags = p.tags?.length ? ` ${c.dim}[${p.tags.join(', ')}]${c.reset}` : ''
    console.log(`  ${c.cyan}${p.name}${c.reset}${ro}${tags}`)
    if (p.description) console.log(`  ${c.dim}${p.description}${c.reset}`)
    console.log()
  }
}

function parseFlags(argv: string[]): {
  positional: string[]
  flags: Map<string, string | boolean>
} {
  const positional: string[] = []
  const flags = new Map<string, string | boolean>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--open') flags.set('open', true)
    else if (a === '--yes' || a === '-y') flags.set('yes', true)
    else if (a.startsWith('--')) flags.set(a.slice(2), argv[++i] ?? '')
    else positional.push(a)
  }
  return { positional, flags }
}

async function newProfileCmd(cwd: string, argv: string[]): Promise<void> {
  const { positional, flags } = parseFlags(argv)
  const name = positional[0]
  if (!name) throw new Error('ownware profile new <name> — a name is required')

  const opts: ScaffoldOptions = {
    ...(flags.has('model') ? { model: String(flags.get('model')) } : {}),
    ...(flags.has('description') ? { description: String(flags.get('description')) } : {}),
  }

  const result = scaffoldProfile(cwd, name, opts)
  printInitResult(result)
  if (flags.get('open')) {
    openFolder(result.profileDir)
    console.log(`  Opened ${result.profileDir}`)
    console.log()
  }
}

async function showProfileCmd(cwd: string, name: string): Promise<void> {
  assertValidName(name)
  const root = findProfilesDir(cwd)
  const registry = new ProfileRegistry()
  await registry.discover(root)
  const entry = registry.list().find((p) => p.name === name)
  if (!entry) {
    throw new Error(`profile "${name}" not found in ${root} — see \`ownware profile list\``)
  }
  const info = profileInfo(entry.path)
  console.log(
    `\n${c.bold}${c.cyan}${info.name}${c.reset}${entry.readOnly ? ` ${c.dim}(read-only)${c.reset}` : ''}`,
  )
  if (info.description) console.log(`${c.dim}${info.description}${c.reset}`)
  console.log()
  console.log(`  model:  ${info.model ?? `${c.dim}(default)${c.reset}`}`)
  console.log(`  path:   ${info.dir}`)
  console.log(`  files:  ${info.files.join(', ')}`)
  console.log()
  if (!entry.readOnly) {
    console.log(
      `  ${c.dim}Edit:${c.reset} ownware profile open ${name}   ${c.dim}·${c.reset}   ownware profile set ${name} --model <m>`,
    )
    console.log(`  ${c.dim}Run: ${c.reset} ownware run ${name} "hello"`)
    console.log()
  }
}

async function setProfileCmd(cwd: string, argv: string[]): Promise<void> {
  const { positional, flags } = parseFlags(argv)
  const name = positional[0]
  if (!name) throw new Error('ownware profile set <name> [--model <m>] [--description <d>]')

  const patch: ProfileFieldPatch = {
    ...(flags.has('model') ? { model: String(flags.get('model')) } : {}),
    ...(flags.has('description') ? { description: String(flags.get('description')) } : {}),
  }
  const changed = setProfileFields(cwd, name, patch)
  console.log(`${c.green}✓${c.reset} updated ${name}: ${changed.join(', ')}`)
  console.log(`  ${c.dim}ownware run ${name} "hello"${c.reset}`)
}

async function openProfileCmd(cwd: string, name: string): Promise<void> {
  assertValidName(name)
  const local = join(localProfilesDir(cwd), name)
  if (existsSync(local)) {
    openFolder(local)
    console.log(`Opened ${local}`)
    return
  }
  // Fall back to a read-only bundled profile's location if that's what they meant.
  const root = findProfilesDir(cwd)
  const registry = new ProfileRegistry()
  await registry.discover(root)
  const entry = registry.list().find((p) => p.name === name)
  if (!entry) throw new Error(`profile "${name}" not found — see \`ownware profile list\``)
  openFolder(entry.path)
  console.log(`Opened ${entry.path}${entry.readOnly ? ' (read-only)' : ''}`)
}

async function removeProfileCmd(cwd: string, name: string, yes: boolean): Promise<void> {
  assertValidName(name)
  const dir = join(localProfilesDir(cwd), name)
  if (!existsSync(dir)) throw new Error(`no profile "${name}" in ${localProfilesDir(cwd)}`)
  if (!yes) {
    const ok = await confirm(
      `${c.yellow}Remove${c.reset} profile "${name}" at ${dir}? This deletes the folder. [y/N] `,
    )
    if (!ok) {
      console.log('Aborted.')
      return
    }
  }
  removeProfile(cwd, name)
  console.log(`${c.green}✓${c.reset} removed ${dir}`)
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function usage(): string {
  return `${c.bold}ownware profile${c.reset} — build and manage your agents

  ownware profile new <name> [--model <m>] [--description <d>] [--open]
  ownware profile list
  ownware profile show <name>
  ownware profile set  <name> [--model <m>] [--description <d>]
  ownware profile open <name>
  ownware profile remove <name> [--yes]`
}

export async function profileCommand(argv: string[], cwd = process.cwd()): Promise<void> {
  const [sub, ...rest] = argv
  try {
    switch (sub) {
      case 'new':
      case 'create':
      case 'add':
        await newProfileCmd(cwd, rest)
        return
      case undefined:
      case 'list':
      case 'ls':
        await listProfilesCmd(cwd)
        return
      case 'show':
      case 'info':
        if (!rest[0]) throw new Error('ownware profile show <name>')
        await showProfileCmd(cwd, rest[0])
        return
      case 'set':
      case 'edit':
        await setProfileCmd(cwd, rest)
        return
      case 'open':
        if (!rest[0]) throw new Error('ownware profile open <name>')
        await openProfileCmd(cwd, rest[0])
        return
      case 'remove':
      case 'rm':
      case 'delete': {
        if (!rest[0]) throw new Error('ownware profile remove <name>')
        const yes = rest.includes('--yes') || rest.includes('-y')
        await removeProfileCmd(cwd, rest[0], yes)
        return
      }
      case 'help':
      case '--help':
      case '-h':
        console.log(usage())
        return
      default:
        console.error(`unknown subcommand "${sub}"\n\n${usage()}`)
        process.exit(1)
    }
  } catch (err) {
    console.error(`${c.red}Error:${c.reset} ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
