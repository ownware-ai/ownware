import { defineConfig } from 'vitest/config'
import { realpathSync } from 'fs'
import { tmpdir } from 'os'

// Resolve the OS temp dir through realpath so the allow list works on macOS,
// where `tmpdir()` reports `/var/folders/...` but the kernel hands files out
// at `/private/var/folders/...`. Vite-node's default `server.fs` sandbox
// only permits the workspace root, so dynamic `import()` of a tmpfile (e.g.
// `loadCustomTools` against a `createTempProfile` dir) fails with
// "Cannot find module ..." otherwise. This is a test-only path —
// production runs through real Node which has no such restriction.
const TMP_REALPATH = realpathSync(tmpdir())

export default defineConfig({
  test: {
    root: '.',
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.contract.ts',
      'tests/**/*.journey.ts',
      'tests/**/*.stress.ts',
      'src/**/__tests__/**/*.test.ts',
    ],
    globals: true,
    environment: 'node',
    setupFiles: ['tests/setup/env.ts'],
    testTimeout: 30_000,
  },
  server: {
    fs: {
      // Allow vite-node to dynamic-import test-fixture files from the OS
      // temp dir (see comment above on TMP_REALPATH).
      allow: ['.', TMP_REALPATH],
    },
  },
})
