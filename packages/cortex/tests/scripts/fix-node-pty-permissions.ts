#!/usr/bin/env node
/**
 * Postinstall fix: Bun (and some npm configurations) strip the
 * execute bit from `node-pty`'s `spawn-helper` binary during install,
 * causing `pty.spawn(...)` to fail with
 *
 *   Error: posix_spawnp failed.
 *
 * This script re-applies `chmod 0755` to every `spawn-helper` binary
 * found under `node_modules/node-pty/prebuilds/*`. Safe to run on any
 * platform — no-op when no prebuilds directory exists.
 */

import { chmodSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const PREBUILDS_DIR = join(
  import.meta.dirname,
  '..',
  'node_modules',
  'node-pty',
  'prebuilds',
)

function fixPlatformDir(platformDir: string): void {
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

function main(): void {
  let entries: string[]
  try {
    entries = readdirSync(PREBUILDS_DIR)
  } catch {
    // node-pty not installed (or moved) — no-op.
    return
  }
  for (const entry of entries) {
    const full = join(PREBUILDS_DIR, entry)
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
