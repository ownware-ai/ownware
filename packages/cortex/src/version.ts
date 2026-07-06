/**
 * Cortex version constant.
 *
 * Manually mirrored from `package.json`. Drift is caught by
 * `tests/unit/version.test.ts` — that test reads the package's own
 * `package.json` and asserts equality, so bumping the package
 * version without updating this file fails CI.
 *
 * Why a constant and not a runtime fs read: this value is consumed
 * by the gateway's `/app/version` handler, which ships inside the
 * bundled gateway (`bun build --outfile dist/gateway-bundle.mjs`).
 * The bundle is moved into Electron's `Contents/Resources/cortex/`
 * at packaging time, with no guarantee that walking up from the
 * bundle file location lands on a readable `package.json`. A
 * constant survives bundling.
 */
export const CORTEX_VERSION = '0.1.0'
