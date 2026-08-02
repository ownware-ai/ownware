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
    // PostgreSQL fixtures serialize CREATE/DROP DATABASE through one
    // cluster-catalog lock. A wide full-suite run can therefore spend more
    // than Vitest's 10 s hook default waiting behind other workers even when
    // every individual lifecycle remains healthy. Keep hook and test bounds
    // aligned; the fixture's own active-session leak deadline stays stricter.
    hookTimeout: 30_000,
  },
  server: {
    fs: {
      // Allow vite-node to dynamic-import test-fixture files from the OS
      // temp dir (see comment above on TMP_REALPATH).
      allow: ['.', TMP_REALPATH],
    },
  },
})
