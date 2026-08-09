// First-run smoke test — boots the quickstart gateway with NO API keys
// and proves the keyless contract: it starts, serves the canonical Provider
// Hub model authority, and shuts down cleanly. Run: `bun run smoke` (after
// `bun run build`).
//
// This is the onboarding canary: if a change breaks the cold keyless
// boot, this fails before a stranger ever sees it.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tmp = mkdtempSync(join(tmpdir(), 'ownware-smoke-'))

// Simulate keyless: strip every provider key for this process.
for (const v of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'COMPOSIO_API_KEY']) {
  delete process.env[v]
}
// Module-level stores resolve OWNWARE_DATA_DIR lazily, independently of the
// gateway's `dataDir` option. Set both to the same disposable directory before
// importing any Ownware package so this smoke can never read or migrate the
// operator's real ~/.ownware credential vault.
process.env.OWNWARE_DATA_DIR = join(tmp, 'data')

const { OwnwareGateway } = await import(join(root, 'packages/ownware/dist/index.js'))

const gateway = new OwnwareGateway({
  port: 0,
  tls: false,
  profilesDir: join(root, 'examples/quickstart/profiles'),
  dataDir: join(tmp, 'data'),
})

const fail = (msg) => {
  console.error(`SMOKE FAIL: ${msg}`)
  process.exit(1)
}

await gateway.start().catch((e) => fail(`keyless boot crashed: ${e.message}`))
const H = { Authorization: `Bearer ${gateway.token}` }
const base = `http://localhost:${gateway.port}`

const health = await (await fetch(`${base}/api/v1/health`, { headers: H })).json()
if (health.status !== 'ok') fail(`health returned ${JSON.stringify(health)}`)

const modelPage = await (
  await fetch(`${base}/api/v1/provider-hub/models?limit=200`, { headers: H })
).json()
if (!Array.isArray(modelPage.items) || modelPage.items.length === 0) {
  fail('Provider Hub models catalog empty')
}
// Keyless + no local Ollama on CI ⇒ credentialed may be all-false —
// that's fine; the authoritative availability field must exist and be honest.
if (modelPage.items.some((item) => typeof item.model?.availability?.credentialed !== 'boolean')) {
  fail('Provider Hub credentialed availability missing from model entries')
}

const profiles = await (await fetch(`${base}/api/v1/profiles`, { headers: H })).json()
if (!profiles.some((p) => p.id === 'assistant')) fail('quickstart profile not discovered')

await gateway.stop()
rmSync(tmp, { recursive: true, force: true })
console.log(`smoke OK — keyless boot, health, ${modelPage.page.total} Provider Hub models, quickstart profile discovered`)
process.exit(0)
