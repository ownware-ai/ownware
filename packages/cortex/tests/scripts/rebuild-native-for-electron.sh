#!/usr/bin/env bash
#
# Idempotent native-binding rebuild for Electron's Node ABI.
#
# Background: `electron-rebuild` has been observed leaving stale or
# wrong-ABI binaries in `node_modules/better-sqlite3/build/Release/` —
# either because `prebuild-install` cached a binary for a different
# NODE_MODULE_VERSION, or because the rebuild step landed objects but
# didn't relink the final `.node`. The symptom is "ERR_DLOPEN_FAILED:
# compiled against NODE_MODULE_VERSION 141, requires 145" at gateway
# boot, even after running `bun run rebuild:electron`.
#
# This script forces the right state:
#   1. Run `electron-rebuild` for the Electron version the desktop client uses.
#   2. If `bin/<platform>-<arch>-<abi>/<module>.node` exists (a prebuild
#      shipped by the package), copy it over `build/Release/*.node` so
#      whichever path the loader resolves first finds the correct ABI.
#
# Run this BEFORE `bun run electron:dev` if you've previously run
# `bun run rebuild:node` (which rebuilds for the system Node ABI).

set -e
cd "$(dirname "$0")/.."

ELECTRON_VERSION=$(node -p "require('../studio/package.json').devDependencies.electron.replace(/^[\\^~]/, '')" 2>/dev/null || echo "")
if [ -z "$ELECTRON_VERSION" ]; then
  echo "✖ Could not detect Electron version from ../studio/package.json"
  exit 1
fi

ARCH=$(node -p "process.arch")
PLATFORM=$(node -p "process.platform")
# Ask Electron itself what its ABI is, since version → ABI is non-trivial.
ELECTRON_BIN="../studio/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ -f "$ELECTRON_BIN" ]; then
  ABI=$(ELECTRON_RUN_AS_NODE=1 "$ELECTRON_BIN" -p "process.versions.modules" 2>/dev/null || echo "")
else
  ABI=""
fi

echo "▸ Electron ${ELECTRON_VERSION} on ${PLATFORM}-${ARCH} (ABI: ${ABI:-unknown})"

# Step 1: standard electron-rebuild
echo "▸ Running electron-rebuild..."
../studio/node_modules/.bin/electron-rebuild -m . -w better-sqlite3 -w node-pty -v "$ELECTRON_VERSION" 2>&1 | tail -3 || {
  echo "✖ electron-rebuild failed"
  exit 1
}

# Step 2: defensive copy from bin/ prebuild → build/Release if mismatched.
copy_if_mismatch () {
  local module=$1
  local prebuild_path="node_modules/${module}/bin/${PLATFORM}-${ARCH}-${ABI}/${module}.node"
  local target_path="node_modules/${module}/build/Release/${module}.node"

  # node-pty's target is named pty.node not node-pty.node.
  if [ "$module" = "node-pty" ]; then
    target_path="node_modules/node-pty/build/Release/pty.node"
  fi
  # better-sqlite3's target uses underscore.
  if [ "$module" = "better-sqlite3" ]; then
    target_path="node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  fi

  if [ -n "$ABI" ] && [ -f "$prebuild_path" ]; then
    cp -f "$prebuild_path" "$target_path"
    echo "  ✓ ${module}: copied prebuild for ABI ${ABI}"
  fi
}

copy_if_mismatch better-sqlite3
copy_if_mismatch node-pty

echo "✓ Native bindings ready for Electron ${ELECTRON_VERSION}"
