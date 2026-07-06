#!/usr/bin/env node
/**
 * Postinstall fix: ensure @vscode/ripgrep's `rg` binary exists.
 *
 * The package's own postinstall script (`lib/postinstall.js`) downloads
 * the per-platform ripgrep binary from microsoft/ripgrep-prebuilt. Bun
 * only runs postinstalls for packages listed in `trustedDependencies`,
 * and even then doesn't always re-trigger after the package is already
 * unpacked in the content-addressed cache.
 *
 * This script is the safety net: it checks whether `bin/rg` exists at
 * the resolved package path, and runs the package's own postinstall if
 * missing. Idempotent — no-op when the binary is already there. Safe
 * to call on any platform.
 *
 * Without this, ripgrep-backed tools (search.ts, grep) silently fail
 * in production with "ENOENT: no such file or directory, /…/bin/rg".
 */

import { existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RIPGREP_PKG_DIR = join(
  __dirname,
  '..',
  'node_modules',
  '@vscode',
  'ripgrep',
)
const BIN_PATH = join(RIPGREP_PKG_DIR, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg')
const POSTINSTALL = join(RIPGREP_PKG_DIR, 'lib', 'postinstall.js')

function alreadyHasBinary(): boolean {
  if (!existsSync(BIN_PATH)) return false
  try {
    const st = statSync(BIN_PATH)
    return st.size > 1024 // sanity — real binary is multi-MB; 0/tiny means broken
  } catch {
    return false
  }
}

function runPostinstall(): void {
  if (!existsSync(POSTINSTALL)) {
    console.warn(
      `[cortex/ensure-ripgrep] ${POSTINSTALL} not found — skipping. ` +
      `Install @vscode/ripgrep first.`,
    )
    return
  }
  console.log('[cortex/ensure-ripgrep] downloading rg binary…')
  const res = spawnSync(process.execPath, [POSTINSTALL], {
    cwd: RIPGREP_PKG_DIR,
    stdio: 'inherit',
  })
  if (res.status !== 0) {
    console.warn(
      `[cortex/ensure-ripgrep] postinstall exited ${res.status}. ` +
      `Ripgrep tools may fail at runtime. Network blocked?`,
    )
  }
}

if (alreadyHasBinary()) {
  // No-op success path — common case after the first successful install.
  process.exit(0)
}

runPostinstall()
