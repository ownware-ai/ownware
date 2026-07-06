/**
 * `ownware init` / the scaffold behind `ownware profile new` — drop a starter
 * profile into ./profiles so `ownware run` and `ownware serve` have something to
 * work with. Deliberately NOT a wizard: no prompts, no network, plain text
 * files the user is meant to open and edit.
 *
 * Idempotent: existing files are never overwritten (your edits are the
 * point of the format).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The honest default model the quickstart ships. */
const DEFAULT_MODEL = 'openai:gpt-5.5'

export interface InitOptions {
  /** Model id for agent.json (default: `openai:gpt-5.5`). */
  readonly model?: string
  /** One-line description for agent.json. */
  readonly description?: string
}

/** Title-case a slug for the SOUL.md heading: `sales-bot` → `Sales Bot`. */
function titleCase(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function starterAgentJson(name: string, opts: InitOptions): string {
  return `${JSON.stringify(
    {
      name,
      description:
        opts.description ??
        'A general-purpose assistant: reads and writes files, searches the web, remembers what you tell it.',
      model: opts.model ?? DEFAULT_MODEL,
      tools: {
        preset: 'full',
        deny: ['shell_execute'],
      },
      memory: {
        enabled: true,
        sources: ['AGENTS.md'],
      },
      security: {
        level: 'standard',
        permissionMode: 'ask',
      },
    },
    null,
    2,
  )}\n`
}

function starterSoulMd(name: string): string {
  return `# ${titleCase(name)}

You are a capable, friendly assistant.

- Be concise. Lead with the answer, then the reasoning if it helps.
- When you use a tool, say what you're doing in a few words.
- If you're unsure, say so — never invent facts, links, or file contents.
- Ask before doing anything destructive or hard to reverse.

Make this agent yours: edit this file to change its personality and rules,
and edit \`agent.json\` to change its model, tools, and integrations.
`
}

export interface InitResult {
  readonly name: string
  readonly profileDir: string
  readonly created: readonly string[]
  readonly skipped: readonly string[]
}

/** Scaffold `<cwd>/profiles/<name>/`. Never overwrites existing files. */
export function initProfile(cwd: string, name = 'assistant', opts: InitOptions = {}): InitResult {
  const profileDir = join(cwd, 'profiles', name)
  mkdirSync(profileDir, { recursive: true })

  const files: ReadonlyArray<{ name: string; content: string }> = [
    { name: 'agent.json', content: starterAgentJson(name, opts) },
    { name: 'SOUL.md', content: starterSoulMd(name) },
  ]

  const created: string[] = []
  const skipped: string[] = []
  for (const f of files) {
    const path = join(profileDir, f.name)
    if (existsSync(path)) {
      skipped.push(f.name)
      continue
    }
    writeFileSync(path, f.content)
    created.push(f.name)
  }
  return { name, profileDir, created, skipped }
}

/** Shared "what got created + next steps" print, used by init AND profile new. */
export function printInitResult(result: InitResult): void {
  console.log()
  if (result.created.length > 0) {
    console.log(`  Created ${result.profileDir}`)
    for (const f of result.created) console.log(`    ${f}`)
  }
  if (result.skipped.length > 0) {
    console.log(`  Kept your existing ${result.skipped.join(', ')} (never overwritten)`)
  }
  console.log()
  console.log(`  Talk to it:  ownware run ${result.name} "hello"`)
  console.log(`  Serve it:    ownware serve`)
  console.log()
}

/** `ownware init [name]` — assistant by default; `ownware init <name>` for a named starter. */
export function initCommand(argv: string[] = [], cwd = process.cwd()): void {
  const name = argv.find((a) => !a.startsWith('-')) ?? 'assistant'
  const result = initProfile(cwd, name)
  printInitResult(result)
}
