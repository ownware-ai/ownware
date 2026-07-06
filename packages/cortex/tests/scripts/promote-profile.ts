#!/usr/bin/env bun
/**
 * promote-profile — write a user fork back into the shipped builtin.
 *
 * Profiles you edit in the client app are copy-on-write forked into
 * `~/.ownware/profiles/<name>/` (your local data); the shipped templates
 * in `packages/cortex/profiles/<name>/` (the repo) stay untouched. When
 * you've designed an agent in the app and want it to SHIP to everyone,
 * run this to copy the fork's authored files back into the builtin.
 *
 *   bun run scripts/promote-profile.ts <profile-name>
 *
 * Copies agent.json + SOUL.md + AGENTS.md (when present). Review the diff
 * and commit — the repo is the source of truth for shipped agents.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { copyFile, readFile } from 'node:fs/promises'

const name = process.argv[2]
if (name === undefined || name.length === 0) {
  console.error('usage: bun run scripts/promote-profile.ts <profile-name>')
  process.exit(1)
}

const forkDir = join(homedir(), '.ownware', 'profiles', name)
const builtinDir = join(import.meta.dir, '..', 'profiles', name)

if (!existsSync(forkDir)) {
  console.error(`No fork found at ${forkDir} — nothing to promote.`)
  process.exit(1)
}
if (!existsSync(builtinDir)) {
  console.error(
    `No builtin at ${builtinDir}. promote-profile only updates existing ` +
      `builtins; create the builtin folder first to ship a brand-new agent.`,
  )
  process.exit(1)
}

const files = ['agent.json', 'SOUL.md', 'AGENTS.md'] as const
let copied = 0
for (const f of files) {
  const src = join(forkDir, f)
  if (existsSync(src)) {
    await copyFile(src, join(builtinDir, f))
    console.log(`  ✓ ${f}`)
    copied++
  }
}

// Guard against the model-picker-saved-a-label smell (e.g. "Haiku 4.5"
// instead of "openrouter:haiku-4.5"): a provider id always has a ":".
try {
  const cfg = JSON.parse(await readFile(join(builtinDir, 'agent.json'), 'utf8')) as {
    model?: string
  }
  if (typeof cfg.model === 'string' && !cfg.model.includes(':')) {
    console.warn(
      `  ⚠ model "${cfg.model}" looks like a display name, not a ` +
        `provider:id — fix it in the builtin before committing.`,
    )
  }
} catch {
  /* JSON parse is best-effort; the copy already succeeded. */
}

console.log(
  `\n✓ promoted ${name} (${copied.toString()} file(s)) fork → builtin.\n` +
    `  Review the diff and commit. Then remove the fork (DELETE /api/v1/profiles/${name}\n` +
    `  or delete ~/.ownware/profiles/${name}) so the builtin shows.`,
)
