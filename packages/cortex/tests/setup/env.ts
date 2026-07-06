/**
 * Global test setup. Runs before any test file is imported, so env vars
 * are present when Loom's eager provider construction happens at module
 * load time. Without this, importing anything that transitively pulls in
 * @ownware/loom throws "OPENAI_API_KEY missing" at module-resolution
 * time, before any beforeAll hook can run.
 */

/**
 * Dummy-key sentinel: tests that need real LLM calls detect this exact
 * value to know the key is a placeholder and skip themselves. Any string
 * containing `OWNWARE_TEST_DUMMY` counts as "no real key".
 */
const DUMMY = 'OWNWARE_TEST_DUMMY'

if (!process.env['OPENAI_API_KEY']) process.env['OPENAI_API_KEY'] = DUMMY
if (!process.env['ANTHROPIC_API_KEY']) process.env['ANTHROPIC_API_KEY'] = DUMMY
if (!process.env['GOOGLE_API_KEY']) process.env['GOOGLE_API_KEY'] = DUMMY
if (!process.env['OWNWARE_SKIP_MCP_REGISTRY']) process.env['OWNWARE_SKIP_MCP_REGISTRY'] = '1'
// Keep the MCP registry disk cache OUT of the user's real ~/.ownware — its
// default path ignores per-gateway dataDir (it's a machine-global cache),
// so without this override the registry e2e tests write there. A stable
// tmpdir path still lets parallel workers share one warm cache.
if (!process.env['OWNWARE_REGISTRY_CACHE_PATH']) {
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  process.env['OWNWARE_REGISTRY_CACHE_PATH'] = join(tmpdir(), 'ownware-test-mcp-registry-cache.json')
}
// Safety net for the singletons that resolve their storage from env, not
// from a gateway's `dataDir` option (credential vault, master key). With
// this set, no test can ever write into the user's real ~/.ownware even if a
// suite forgets its own isolation.
if (!process.env['OWNWARE_DATA_DIR']) {
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { mkdtempSync } = await import('node:fs')
  process.env['OWNWARE_DATA_DIR'] = mkdtempSync(join(tmpdir(), 'ownware-test-data-'))
}
// Every test gateway serves plain HTTP/1.1 (no browser → no 6-conn stall to
// reproduce; keeps each test's `http://…:${port}` URL working without a
// per-boot self-signed cert). The HTTP/2-over-TLS path (the desktop default)
// is verified separately — see gateway-perf-2026-06-13. A test that WANTS TLS
// can pass `tls: true` explicitly to the gateway.
if (!process.env['OWNWARE_GATEWAY_TLS']) process.env['OWNWARE_GATEWAY_TLS'] = '0'

/** Returns true when a real (non-sentinel) API key is present for the provider. */
export function hasRealKey(name: string): boolean {
  const v = process.env[name]
  if (!v) return false
  if (v.includes(DUMMY)) return false
  return true
}
