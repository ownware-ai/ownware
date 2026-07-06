#!/usr/bin/env bash
#
# ENV-2 resolution — run DB-backed vitest suites under ELECTRON's node.
#
# Why: better-sqlite3's on-disk build targets Electron's ABI
# (NODE_MODULE_VERSION 145); system node is 147, so DB-backed suites fail to
# load the native module under plain `vitest`. Running vitest through Electron's
# node (ELECTRON_RUN_AS_NODE=1) matches the on-disk ABI. `--pool=threads` keeps
# the test worker IN-PROCESS so it inherits that ABI — a forked node worker would
# revert to 147 and fail to load better-sqlite3. `--no-file-parallelism` keeps it
# single-worker (the DB suites use temp files, not a shared DB, but this is tidy).
#
# Usage:
#   bash scripts/test-db.sh                       # the schedules DB suites
#   bash scripts/test-db.sh tests/unit/foo.test.ts ...   # specific files
#   npm run test:db -- tests/unit/foo.test.ts            # via the npm script
#
set -euo pipefail
cd "$(dirname "$0")/.."                                  # packages/cortex
REPO_ROOT="$(cd ../.. && pwd)"

ELECTRON="$(ls "$REPO_ROOT"/node_modules/.bun/electron@*/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron 2>/dev/null | head -1)"
if [[ -z "${ELECTRON:-}" || ! -x "$ELECTRON" ]]; then
  echo "ENV-2: Electron binary not found under node_modules/.bun/electron@*/. Is electron installed?" >&2
  exit 1
fi

ARGS=("$@")
if [[ ${#ARGS[@]} -eq 0 ]]; then
  ARGS=(
    tests/unit/schedules/store.test.ts
    tests/unit/schedules/runner.test.ts
    tests/unit/schedules/approvals.test.ts
  )
fi

exec env ELECTRON_RUN_AS_NODE=1 "$ELECTRON" \
  node_modules/vitest/vitest.mjs run --pool=threads --no-file-parallelism "${ARGS[@]}"
