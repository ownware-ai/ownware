// First-run smoke test — boots the quickstart gateway with NO API keys
// and proves the keyless contract: it starts, serves, lists models, and
// shuts down cleanly. Run: `bun run smoke` (after `bun run build`).
//
// This is the onboarding canary: if a change breaks the cold keyless
// boot, this fails before a stranger ever sees it.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// Simulate keyless: strip every provider key for this process.
for (const v of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'COMPOSIO_API_KEY']) {
  delete process.env[v]
}

const { OwnwareGateway } = await import(join(root, 'packages/ownware/dist/index.js'))

const tmp = mkdtempSync(join(tmpdir(), 'ownware-smoke-'))
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

const models = await (await fetch(`${base}/api/v1/models`, { headers: H })).json()
if (!Array.isArray(models) || models.length === 0) fail('models catalog empty')
// Keyless + no local Ollama on CI ⇒ hasCredentials may be all-false —
// that's fine; the field must exist and be honest, not throw.
if (models.some((m) => typeof m.hasCredentials !== 'boolean')) {
  fail('hasCredentials missing from model entries')
}

const profiles = await (await fetch(`${base}/api/v1/profiles`, { headers: H })).json()
if (!profiles.some((p) => p.id === 'assistant')) fail('quickstart profile not discovered')

await gateway.stop()
rmSync(tmp, { recursive: true, force: true })
console.log(`smoke OK — keyless boot, health, ${models.length} models, quickstart profile discovered`)
process.exit(0)
