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
 * The public package list and dependency order live in release-packages.mjs,
 * where tests prove coverage and topological ordering.
 *
 * Usage:
 *   node scripts/publish-packages.mjs            # real publish
 *   node scripts/publish-packages.mjs --dry-run  # pack + validate, publish nothing
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PUBLISH_ORDER, publishTagForVersion } from './release-packages.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')

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

console.log(`\n▶ Publishing ${PUBLISH_ORDER.length} packages${dryRun ? ' (DRY RUN)' : ''}\n`)

let published = 0
let skipped = 0
for (const rel of PUBLISH_ORDER) {
  const dir = resolve(root, rel)
  const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
  const { name, version } = pkg
  const tag = publishTagForVersion(version)
  console.log(`\n── ${name}@${version}  (${rel}, tag: ${tag}) ─────────────────────────────`)

  // Skip versions already on npm so this script is safe to run on any push:
  // it publishes ONLY genuinely-new versions (e.g. right after a version bump),
  // and never errors trying to republish an existing one.
  if (!dryRun && alreadyPublished(name, version)) {
    console.log(`   already on npm — skipping`)
    skipped++
    continue
  }

  const args = ['publish', '--tag', tag]
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
