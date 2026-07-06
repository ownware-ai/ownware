#!/usr/bin/env node
/**
 * Postinstall: re-target native modules to Electron's ABI (BUGS #9 root cause).
 *
 * The desktop gateway ALWAYS runs under Electron (`ELECTRON_RUN_AS_NODE=1`, both
 * dev — `electron/main/gateway-supervisor.ts` + `dev-watcher.ts` — and prod), so
 * `better-sqlite3` / `node-pty` must be compiled for Electron's `NODE_MODULE_VERSION`
 * (e.g. 145), NOT the system Node's (e.g. 147). A fresh `bun install` builds them
 * for the Node ABI; without this step the gateway boots fine at first but the very
 * next restart (a dev-watcher recompile, an app update, a crash, a reboot) hits
 * `__GATEWAY_FATAL__: compiled against NODE_MODULE_VERSION 147, requires 145` and
 * crash-loops until the supervisor gives up — the app is then dead with no recovery.
 * The desktop client's `preelectron:dev` hook fixes this at launch, but only at launch; a
 * mid-session install would re-introduce the drift. Pinning it on EVERY install
 * closes that window.
 *
 * SAFE FOR THE BYO-CLOUD / CI PATH: that packaging runs the gateway under plain
 * Node with no Electron, where the Node-ABI native is exactly what's wanted. When
 * the desktop client's Electron isn't installed, this is a clean no-op. It is also NON-FATAL —
 * a failed rebuild must never break `bun install`; it warns and exits 0, leaving
 * `bun run rebuild:electron` (and `preelectron:dev`) as the fallbacks.
 *
 * Idempotent: `rebuild-native-for-electron.sh` is itself idempotent.
 */

import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))

// The desktop client's Electron (the runtime the gateway is spawned under). Same path the
// rebuild script uses to detect the version + ABI. Absent → Node/cloud context.
const electronDir = join(__dirname, '..', '..', 'studio', 'node_modules', 'electron')

if (!existsSync(electronDir)) {
  console.log(
    '[postinstall] Desktop-client Electron not present — skipping electron-rebuild (native stays at the Node ABI, correct for the cloud/Node gateway).',
  )
  process.exit(0)
}

console.log('[postinstall] Re-targeting native modules to Electron ABI (the gateway runs under Electron)…')
const res = spawnSync('bash', [join(__dirname, 'rebuild-native-for-electron.sh')], {
  stdio: 'inherit',
})

if (res.status !== 0) {
  // NON-FATAL: never break the install. preelectron:dev + a manual
  // `bun run rebuild:electron` are the fallbacks.
  console.warn(
    '[postinstall] ⚠ electron-rebuild did not complete — run `bun run rebuild:electron` in packages/cortex before launching the app.',
  )
}

process.exit(0)
