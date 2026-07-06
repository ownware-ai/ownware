/**
 * OwnwareClient against a REAL OwnwareGateway — the contract test.
 *
 * Boots @ownware/cortex (dev dependency) with temp profilesDir + dataDir
 * (per the gateway test-isolation rule: never touch ~/.ownware) and drives
 * the whole surface through the published client: health, models, run,
 * streamReply to a terminal event, abort. A fake Loom provider stands
 * in for "a key is saved" — no network, no LLM.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OwnwareGateway } from '@ownware/cortex'
import { listProviders, registerProvider, unregisterProvider } from '@ownware/loom'
import type { ProviderAdapter } from '@ownware/loom'
import { OwnwareClient } from '../client.js'

let gateway: OwnwareGateway
let ownware: OwnwareClient
let dir: string

beforeAll(async () => {
  process.env['OWNWARE_SKIP_MCP_REGISTRY'] = '1'
  dir = await mkdtemp(join(tmpdir(), 'ownware-client-it-'))
  const profilesDir = join(dir, 'profiles')
  const profileDir = join(profilesDir, 'test-agent')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'agent.json'), JSON.stringify({ name: 'test-agent' }))

  for (const name of listProviders()) unregisterProvider(name)
  registerProvider({ name: 'openai' } as unknown as ProviderAdapter)

  gateway = new OwnwareGateway({
    port: 0,
    profilesDir,
    dataDir: join(dir, 'data'),
    tls: false,
    disableAuth: false, // exercise the client's Bearer handling for real
  })
  await gateway.start()
  ownware = new OwnwareClient({ baseUrl: `http://127.0.0.1:${gateway.port}`, token: gateway.token })
}, 20_000)

afterAll(async () => {
  await gateway.stop()
  await rm(dir, { recursive: true, force: true })
  for (const name of listProviders()) unregisterProvider(name)
})

describe('OwnwareClient ⇄ OwnwareGateway', () => {
  it('health() answers without auth trouble', async () => {
    const health = await ownware.health()
    expect(health.status).toBe('ok')
  })

  it('models() returns the catalog with hasCredentials booleans', async () => {
    const models = await ownware.models()
    expect(models.length).toBeGreaterThan(0)
    expect(models.every((m) => typeof m.id === 'string')).toBe(true)
    expect(models.every((m) => typeof m.hasCredentials === 'boolean')).toBe(true)
  })

  it('auth is REAL: a tokenless client is rejected, the tokened one is not', async () => {
    const anonymous = new OwnwareClient({ baseUrl: `http://127.0.0.1:${gateway.port}` })
    await expect(anonymous.models()).rejects.toThrow(/401/)
  })

  it('run() starts a run and streamReply() reaches a terminal event', async () => {
    const result = await ownware.run({ profileId: 'test-agent', prompt: 'hello' })
    expect(result.threadId).toMatch(/^thread_/)
    // The gateway dispatched the fake provider's catalog default —
    // the keyless-fallback path in action, visible through the SDK.
    expect(result.model).toBe('openai:gpt-5.5')

    // The fake provider has no stream() — the run dies immediately and
    // the stream MUST surface that as a terminal event instead of
    // hanging forever (the exact bug hand-rolled clients hit).
    const types: string[] = []
    for await (const ev of ownware.streamReply(result.threadId)) types.push(ev.type)
    expect(types.length).toBeGreaterThan(0)
    expect(['done', 'error']).toContain(types[types.length - 1])
  }, 20_000)

  it('abort() lands (idempotent even after the run ended)', async () => {
    const { threadId } = await ownware.run({ profileId: 'test-agent', prompt: 'hi again' })
    await expect(ownware.abort(threadId)).resolves.toBeUndefined()
  })
})
