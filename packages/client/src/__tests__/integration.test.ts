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
import { createHash } from 'node:crypto'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OwnwareGateway } from '@ownware/cortex'
import { listProviders, registerProvider, unregisterProvider } from '@ownware/loom'
import type { ProviderAdapter } from '@ownware/loom'
import { OwnwareClient, OwnwareError } from '../client.js'

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
  it('negotiates the published contract before a dependent call', async () => {
    const negotiation = await ownware.capabilities({
      requiredMajor: 1,
      requiredCapabilities: { 'runs.start': 1, 'runs.events': 1 },
    })
    expect(negotiation).toMatchObject({ status: 'available' })
    if (negotiation.status !== 'available') throw new Error('expected available capabilities')
    expect(negotiation.limits).toMatchObject({
      jsonBodyBytes: 10 * 1024 * 1024,
      candidateUpload: {
        maxFiles: 1_000,
        maxDecodedBytes: 6 * 1024 * 1024,
        maxPathCharacters: 256,
      },
      sourceList: { maxPageSize: 100 },
      idempotencyRetentionSeconds: 7 * 24 * 60 * 60,
      rateLimit: { enabled: true, runStarts: 10 },
    })
    await expect(ownware.models()).resolves.not.toHaveLength(0)

    await expect(ownware.capabilities({ requiredMajor: 2 })).resolves.toMatchObject({
      status: 'incompatible',
      expectedMajor: 2,
      actualMajor: 1,
    })
  })

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
    const thrown = await anonymous.models().catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(OwnwareError)
    expect(thrown).toMatchObject({
      status: 401,
      code: 'unauthorized',
      category: 'auth',
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
  })

  it('owner delegates one capability and revocation is immediate', async () => {
    const workspace = gateway.state.createWorkspace(dir, 'Client delegation')
    const issued = await ownware.issueDelegation({
      delegateId: 'client-integration',
      workspaceId: workspace.id,
      profileId: 'test-agent',
      purpose: 'contract-test',
      operations: ['gateway.capabilities'],
    })
    const delegated = new OwnwareClient({
      baseUrl: `http://127.0.0.1:${gateway.port}`,
      token: issued.token,
    })
    await expect(delegated.capabilities({ requiredMajor: 1 })).resolves.toMatchObject({
      status: 'available',
    })

    await ownware.revokeDelegation(issued.principal.tokenId, 'client_removed')
    const thrown = await delegated.capabilities().catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(OwnwareError)
    expect(thrown).toMatchObject({ status: 401, code: 'principal_revoked' })
  })

  it('a delegated validator validates portable bytes without registering a profile', async () => {
    const before = (await gateway.registry.list()).length
    const workspace = gateway.state.createWorkspace(join(dir, 'candidate-workspace'), 'Client candidate validation')
    const issued = await ownware.issueDelegation({
      delegateId: 'client-candidate-validator',
      workspaceId: workspace.id,
      profileId: 'test-agent',
      purpose: 'validate-portable-agent-kit',
      operations: [
        'candidates.validate', 'candidates.stage', 'candidates.activate', 'candidates.rollback',
        'candidates.read', 'candidates.list',
        'profiles.pause', 'profiles.resume',
        'profiles.deployment.read', 'profiles.list',
      ],
    })
    const delegated = new OwnwareClient({
      baseUrl: `http://127.0.0.1:${gateway.port}`,
      token: issued.token,
    })
    const result = await delegated.validateCandidate({
      files: [{
        path: 'agent.json',
        contentBase64: Buffer.from('{"name":"test-agent"}').toString('base64'),
      }],
    })
    expect(result).toMatchObject({
      valid: true,
      candidateId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      profileName: 'test-agent',
      findings: [],
    })
    await expect(delegated.stageCandidate({
      candidateId: result.candidateId!,
      files: [{
        path: 'agent.json',
        contentBase64: Buffer.from('{"name":"test-agent"}').toString('base64'),
      }],
    })).resolves.toMatchObject({
      candidateId: result.candidateId,
      state: 'ready',
      ready: true,
      idempotent: false,
    })
    await expect(delegated.activateCandidate({
      profileId: 'test-agent',
      candidateId: result.candidateId!,
      expectedActiveCandidateId: null,
    })).resolves.toMatchObject({
      state: 'active',
      changed: true,
      activeCandidateId: result.candidateId,
    })
    await expect(delegated.rollbackCandidate({
      profileId: 'test-agent',
      candidateId: result.candidateId!,
      expectedActiveCandidateId: result.candidateId!,
    })).resolves.toMatchObject({
      state: 'rolled_back',
      changed: false,
      activeCandidateId: result.candidateId,
    })
    await expect(delegated.candidate(result.candidateId!)).resolves.toMatchObject({
      candidateId: result.candidateId, state: 'ready', ready: true,
    })
    await expect(delegated.candidates('test-agent')).resolves.toMatchObject({
      profileId: 'test-agent', items: [expect.objectContaining({ candidateId: result.candidateId })],
    })
    await expect(delegated.deployment('test-agent')).resolves.toMatchObject({
      activeCandidateId: result.candidateId, deploymentRevision: 1,
    })
    await expect(delegated.profiles()).resolves.toEqual([expect.objectContaining({
      id: 'test-agent', activeCandidateId: result.candidateId,
    })])
    await expect(delegated.pauseProfile({
      profileId: 'test-agent',
      expectedDeploymentRevision: 1,
      idempotencyKey: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
    })).resolves.toMatchObject({
      state: 'paused', deploymentRevision: 2,
    })
    await expect(delegated.resumeProfile({
      profileId: 'test-agent',
      expectedDeploymentRevision: 2,
      idempotencyKey: 'dededede-dede-4ede-8ede-dededededede',
    })).resolves.toMatchObject({
      state: 'active', deploymentRevision: 3, health: 'healthy',
    })
    await expect(ownware.run({ profileId: 'test-agent', prompt: 'candidate pin proof' }))
      .resolves.toMatchObject({ candidateId: result.candidateId })
    expect((await gateway.registry.list()).length).toBe(before)
  })

  it('a delegated client registers and reads one safe source manifest', async () => {
    const workspace = gateway.state.createWorkspace(join(dir, 'source-workspace'), 'Client source')
    const issued = await ownware.issueDelegation({
      delegateId: 'client-source-registration',
      workspaceId: workspace.id,
      profileId: 'test-agent',
      purpose: 'customer-support',
      operations: [
        'sources.register', 'sources.list', 'sources.read',
        'source_uploads.create', 'source_uploads.write', 'source_uploads.complete',
        'source_versions.read',
      ],
    })
    const delegated = new OwnwareClient({
      baseUrl: `http://127.0.0.1:${gateway.port}`,
      token: issued.token,
    })
    const input = {
      kind: 'file' as const,
      label: 'Approved client guide',
      classification: 'internal' as const,
      authority: 'supporting_reference' as const,
      audiencePolicyRef: 'audience.support-team',
      sensitivityPolicyRef: 'sensitivity.internal',
      purposePolicyRef: 'purpose.customer-support',
      retentionPolicyRef: 'retention.standard',
      freshnessPolicyRef: 'freshness.monthly',
      idempotencyKey: '52525252-abab-4525-8525-525252525252',
    }
    const source = await delegated.registerSource(input)
    expect(source).toMatchObject({
      label: input.label,
      currentVersionId: null,
      health: { registration: 'pending', freshness: 'unknown' },
    })
    await expect(delegated.registerSource(input)).resolves.toMatchObject({
      sourceId: source.sourceId,
    })
    await expect(delegated.sources()).resolves.toEqual({
      items: [source],
      nextCursor: null,
    })
    await expect(delegated.source(source.sourceId)).resolves.toEqual(source)

    const bytes = Buffer.from('sdk immutable source')
    const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const upload = await delegated.createSourceUploadSession(source.sourceId, {
      expectedBytes: bytes.length,
      expectedChecksum: checksum,
      declaredMediaType: 'text/plain',
      filename: 'sdk-source.txt',
      idempotencyKey: '56565656-abab-4565-8565-565656565656',
    })
    await expect(delegated.writeSourceUploadChunk(upload.uploadId, {
      offset: 0, checksum, bytes,
    })).resolves.toMatchObject({ offset: bytes.length, chunkCount: 1, replayed: false })
    const completed = await delegated.completeSourceUpload(upload.uploadId)
    expect(completed).toMatchObject({
      sourceId: source.sourceId,
      checksum,
      verifiedMediaType: 'text/plain',
      replayed: false,
    })
    await expect(delegated.sourceVersion(
      source.sourceId, completed.sourceVersionId,
    )).resolves.toMatchObject({ sourceVersionId: completed.sourceVersionId, checksum })
  })

  it('run() starts a run and streamReply() reaches a terminal event', async () => {
    const result = await ownware.run({ profileId: 'test-agent', prompt: 'hello' })
    expect(result.threadId).toMatch(/^thread_/)
    // The gateway dispatched the fake provider's catalog default —
    // the keyless-fallback path in action, visible through the SDK.
    expect(result.model).toBe('openai:gpt-5.5')
    expect(result.timeoutMs).toBe(30 * 60 * 1000)
    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/)
    const snapshot = await ownware.runSnapshot(result.runId!)
    expect(snapshot).toMatchObject({
      runId: result.runId,
      threadId: result.threadId,
      profileId: 'test-agent',
    })

    // The fake provider has no stream() — the run dies immediately and
    // the stream MUST surface that as a terminal event instead of
    // hanging forever (the exact bug hand-rolled clients hit).
    const types: string[] = []
    for await (const ev of ownware.streamReply(result.runId!)) types.push(ev.type)
    expect(types.length).toBeGreaterThan(0)
    expect(['done', 'error']).toContain(types[types.length - 1])
  }, 20_000)

  it('run() replays one durable idempotency key without creating a second thread', async () => {
    const idempotencyKey = '22222222-2222-4222-8222-222222222222'
    const input = { profileId: 'test-agent', prompt: 'one logical turn', idempotencyKey }
    const before = gateway.state.listThreads(undefined, { limit: 10_000 }).items.length
    const first = await ownware.run(input)
    const second = await ownware.run(input)
    const conflict = await ownware.run({ ...input, prompt: 'different turn' })
      .catch((error: unknown) => error)
    const after = gateway.state.listThreads(undefined, { limit: 10_000 }).items.length
    expect(second.threadId).toBe(first.threadId)
    expect(second.runId).toBe(first.runId)
    expect(conflict).toBeInstanceOf(OwnwareError)
    expect(conflict).toMatchObject({ status: 409, code: 'idempotency_conflict' })
    expect(after).toBe(before + 1)
  })

  it('streams the second turn from its run boundary, never the first terminal event', async () => {
    const first = await ownware.run({
      profileId: 'test-agent',
      prompt: 'first bounded turn',
      idempotencyKey: '99999999-9999-4999-8999-999999999999',
    })
    const firstEvents = []
    for await (const event of ownware.streamReply(first.runId!)) firstEvents.push(event)

    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      if ((await ownware.runSnapshot(first.runId!)).terminal) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const second = await ownware.run({
      profileId: 'test-agent',
      threadId: first.threadId,
      prompt: 'second bounded turn',
      idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })
    const secondEvents = []
    for await (const event of ownware.streamReply(second.runId!)) secondEvents.push(event)

    expect(second.runId).not.toBe(first.runId)
    expect(secondEvents.at(-1)!.seq).toBeGreaterThan(firstEvents.at(-1)!.seq)
  }, 20_000)

  it('cancel() is exact and legacy owner abort remains compatible', async () => {
    const { runId, threadId } = await ownware.run({ profileId: 'test-agent', prompt: 'hi again' })
    const cancellation = await ownware.cancel(runId!)
    expect(cancellation.runId).toBe(runId)
    expect(['requested', 'already_terminal']).toContain(cancellation.cancellation)
    await expect(ownware.abort(threadId)).resolves.toBeUndefined()
  })
})
