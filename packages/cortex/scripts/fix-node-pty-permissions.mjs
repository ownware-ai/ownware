#!/usr/bin/env node
/**
 * Postinstall fix: Bun (and some npm configurations) strip the
 * execute bit from `node-pty`'s `spawn-helper` binary during install,
 * causing `pty.spawn(...)` to fail with
 *
 *   Error: posix_spawnp failed.
 *
 * This script re-applies `chmod 0755` to every `spawn-helper` binary
 * found under node-pty's `prebuilds/*`. Safe to run on any platform —
 * no-op when node-pty or its prebuilds directory is absent.
 *
 * Plain .mjs (no TS, no deps) so it runs under whatever `node` the
 * consumer's package manager uses — this executes on `npm install` of
 * published @ownware/cortex, not just inside this repo.
 */

import { chmodSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'

/** node-pty may be hoisted to the consumer's root node_modules; resolve
 *  it the way Node would instead of assuming `../node_modules`. */
function findPrebuildsDir() {
  try {
    const require = createRequire(import.meta.url)
    const pkgJson = require.resolve('node-pty/package.json')
    return join(dirname(pkgJson), 'prebuilds')
  } catch {
    return null // node-pty not installed — no-op.
  }
}

function fixPlatformDir(platformDir) {
  const helperPath = join(platformDir, 'spawn-helper')
  try {
    const st = statSync(helperPath)
    // Skip if already executable for owner.
    if ((st.mode & 0o100) !== 0) return
    chmodSync(helperPath, 0o755)
    console.log(`[node-pty] fixed exec bit on ${helperPath}`)
  } catch {
    // spawn-helper absent for this platform (e.g. win32 only has pty.node).
  }
}

function main() {
  const prebuildsDir = findPrebuildsDir()
  if (!prebuildsDir) return
  let entries
  try {
    entries = readdirSync(prebuildsDir)
  } catch {
    // no prebuilds directory — no-op.
    return
  }
  for (const entry of entries) {
    const full = join(prebuildsDir, entry)
    let isDir = false
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue
    fixPlatformDir(full)
  }
}

main()
