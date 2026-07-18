/**
 * Loom version constant.
 *
 * Manually mirrored from `package.json`. Drift is caught by
 * `src/__tests__/unit/version.test.ts` — that test reads the
 * package's own `package.json` and asserts equality, so bumping
 * the package version without updating this file fails CI.
 *
 * Why a constant and not a runtime fs read: this value is consumed
 * by cortex's `/app/version` handler, which ships inside the bundled
 * gateway (`bun build --outfile dist/gateway-bundle.mjs`). Loom is
 * inlined into that bundle with no separate `package.json` at
 * runtime, so an fs lookup would silently fail in packaged Electron
 * builds. A constant survives bundling.
 */
export const VERSION = '0.3.0'
