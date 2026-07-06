#!/usr/bin/env node
/**
 * Publish the Ownware packages to npm, in dependency (topological) order.
 *
 * WHY a script and not `changeset publish`: `changeset publish` shells out to
 * `npm publish`, which ships the literal `workspace:*` protocol in dependency
 * ranges — installs then break. `bun publish` rewrites `workspace:*` to the
 * concrete version. So we drive `bun publish` per package here, in the order
 * each package's internal deps must already exist on npm.
 *
 * Order: loom & client have no internal deps → shuttle needs client →
 *        cortex needs loom (+ optional shuttle) → ownware needs cortex + loom.
 *
 * Usage:
 *   node scripts/publish-packages.mjs            # real publish
 *   node scripts/publish-packages.mjs --dry-run  # pack + validate, publish nothing
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')

// Publish order — each package's internal deps are published before it.
const ORDER = [
  'packages/loom',
  'packages/client',
  'adapters/shuttle',
  'packages/cortex',
  'packages/ownware',
]

/** Is this exact name@version already on npm? (idempotency guard) */
function alreadyPublished(name, version) {
  try {
    const out = execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out === version
  } catch {
    return false // `npm view` exits non-zero when the version doesn't exist → not published
  }
}

console.log(`\n▶ Publishing ${ORDER.length} packages${dryRun ? ' (DRY RUN)' : ''}\n`)

let published = 0
let skipped = 0
for (const rel of ORDER) {
  const dir = resolve(root, rel)
  const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
  const { name, version } = pkg
  console.log(`\n── ${name}@${version}  (${rel}) ─────────────────────────────`)

  // Skip versions already on npm so this script is safe to run on any push:
  // it publishes ONLY genuinely-new versions (e.g. right after a version bump),
  // and never errors trying to republish an existing one.
  if (!dryRun && alreadyPublished(name, version)) {
    console.log(`   already on npm — skipping`)
    skipped++
    continue
  }

  const args = ['publish']
  if (dryRun) args.push('--dry-run')
  execFileSync('bun', args, { cwd: dir, stdio: 'inherit' })
  published++
}

console.log(
  dryRun
    ? '\n✅ Dry run complete — nothing was published.\n'
    : `\n✅ Done — ${published} published, ${skipped} already on npm.` +
        (published ? ' Verify: npm i -g ownware && ownware --version\n' : '\n'),
)
