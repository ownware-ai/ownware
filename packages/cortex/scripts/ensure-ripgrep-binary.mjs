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
 *
 * Plain .mjs (no TS, no deps) so it runs under whatever `node` the
 * consumer's package manager uses — this executes on `npm install` of
 * published @ownware/cortex, not just inside this repo.
 */

import { existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

/** @vscode/ripgrep may be hoisted to the consumer's root node_modules;
 *  resolve it the way Node would instead of assuming `../node_modules`. */
function findRipgrepPkgDir() {
  try {
    const require = createRequire(import.meta.url)
    return dirname(require.resolve('@vscode/ripgrep/package.json'))
  } catch {
    return null // not installed — nothing to ensure.
  }
}

const RIPGREP_PKG_DIR = findRipgrepPkgDir()
if (RIPGREP_PKG_DIR === null) process.exit(0)

const BIN_PATH = join(RIPGREP_PKG_DIR, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg')
const POSTINSTALL = join(RIPGREP_PKG_DIR, 'lib', 'postinstall.js')

function alreadyHasBinary() {
  if (!existsSync(BIN_PATH)) return false
  try {
    const st = statSync(BIN_PATH)
    return st.size > 1024 // sanity — real binary is multi-MB; 0/tiny means broken
  } catch {
    return false
  }
}

function runPostinstall() {
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
