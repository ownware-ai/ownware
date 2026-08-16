import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HumanInTheLoop, type LoomEvent, type Session } from '@ownware/loom'
import { __resetMasterKeyCacheForTests } from '../../../src/connector/credentials/vault.js'
import type { DelegatedPrincipal } from '../../../src/gateway/auth/scoped-principal.js'
import { principalContinuityKey } from '../../../src/gateway/idempotency.js'
import { OwnwareGateway } from '../../../src/gateway/server.js'

const CREDENTIAL_SECRET = 'sk-ant-STO05-PLAINTEXT-NEVER-PERSIST-77bca1'
const PERMISSION_INPUT_SECRET = 'STO05_PERMISSION_INPUT_NEVER_ON_WIRE_6c0c'
const IDEMPOTENCY_KEY = '50000000-0000-4000-8000-000000000005'

class ApprovalJourneySession {
  readonly sessionId = 'sto05-security-authority-journey'

  constructor(private readonly hitl: HumanInTheLoop) {}

  async *submitMessage(): AsyncGenerator<LoomEvent, unknown> {
    yield { type: 'turn.start', turnIndex: 0, timestamp: Date.now() }
    yield {
      type: 'permission.request',
      turnIndex: 0,
      requestId: 'sto05_permission',
      toolName: 'send_email',
      input: { body: PERMISSION_INPUT_SECRET },
      reason: 'Contract action requires approval',
    }
    const approved = await this.hitl.requestApproval({
      id: 'sto05_permission',
      name: 'send_email',
      input: { body: PERMISSION_INPUT_SECRET },
    })
    yield {
      type: 'permission.response',
      turnIndex: 0,
      requestId: 'sto05_permission',
      granted: approved,
    }
    yield {
      type: 'text.delta',
      turnIndex: 0,
      text: approved ? 'Approved security journey.' : 'Denied security journey.',
    }
    yield {
      type: 'turn.end',
      turnIndex: 0,
      stopReason: 'end_turn',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        model: 'test',
        costUsd: 0,
      },
      timestamp: Date.now(),
    }
  }

  abort(): void {
    this.hitl.denyAll()
  }
}

async function readSseUntil(
  response: Response,
  predicate: (event: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const reader = response.body!.getReader()
  let buffered = ''
  const deadline = Date.now() + 5_000
  try {
    while (Date.now() < deadline) {
      let boundary = buffered.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffered.slice(0, boundary)
        buffered = buffered.slice(boundary + 2)
        const data = frame.split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n')
        if (data !== '') {
          const event = JSON.parse(data) as Record<string, unknown>
          if (predicate(event)) return event
        }
        boundary = buffered.indexOf('\n\n')
      }
      const remaining = deadline - Date.now()
      const chunk = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('SSE event deadline exceeded')),
          remaining,
        )
        void reader.read().then(
          (result) => {
            clearTimeout(timeout)
            resolve(result)
          },
          (error: unknown) => {
            clearTimeout(timeout)
            reject(error)
          },
        )
      })
      if (chunk.done) throw new Error('SSE closed before expected event')
      buffered += new TextDecoder().decode(chunk.value)
    }
    throw new Error('SSE event deadline exceeded')
  } finally {
    await reader.cancel().catch(() => {})
  }
}

describe('STO05 storage security authority journey', () => {
  let directory: string
  let gateway: OwnwareGateway | undefined
  let previousMasterKey: string | undefined

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cortex-sto05-journey-'))
    const profileDir = join(directory, 'profiles', 'mini')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'agent.json'), JSON.stringify({
      name: 'mini',
      model: 'test:model',
      tools: { preset: 'none' },
    }))
    previousMasterKey = process.env['OWNWARE_MASTER_KEY']
    process.env['OWNWARE_MASTER_KEY'] = 'ef'.repeat(32)
    __resetMasterKeyCacheForTests()
  })

  afterEach(async () => {
    await gateway?.stop().catch(() => {})
    gateway = undefined
    if (previousMasterKey === undefined) delete process.env['OWNWARE_MASTER_KEY']
    else process.env['OWNWARE_MASTER_KEY'] = previousMasterKey
    __resetMasterKeyCacheForTests()
    await rm(directory, { recursive: true, force: true })
  })

  function createGateway(): OwnwareGateway {
    return new OwnwareGateway({
      port: 0,
      profilesDir: join(directory, 'profiles'),
      dataDir: join(directory, 'data'),
      dbPath: join(directory, 'ownware.db'),
      tls: false,
      disableAuth: false,
      disableAccessLog: true,
      disableRateLimit: true,
      disableSourceWorker: true,
    })
  }

  it('stores encrypted credential, approves once, restarts and preserves audit/idempotency/principal truth', async () => {
    const consoleSpies = [
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'log').mockImplementation(() => {}),
    ]
    try {
      gateway = createGateway()
      await gateway.start()
      const ownerToken = gateway.token
      const ownerHeaders = {
        authorization: `Bearer ${ownerToken}`,
        'content-type': 'application/json',
      }

      const credentialResponse = await fetch(
        `http://127.0.0.1:${gateway.port}/api/v1/credentials`,
        {
          method: 'POST',
          headers: ownerHeaders,
          body: JSON.stringify({
            name: 'STO05 Anthropic credential',
            value: CREDENTIAL_SECRET,
            category: 'llm',
            authType: 'api-key',
            variableName: 'ANTHROPIC_API_KEY',
            source: 'manual',
          }),
        },
      )
      expect(credentialResponse.status).toBe(201)
      const credentialBody = await credentialResponse.json() as {
        credential: { readonly id: string }
      }
      expect(JSON.stringify(credentialBody)).not.toContain(CREDENTIAL_SECRET)

      const workspacePath = join(directory, 'workspace')
      await mkdir(workspacePath)
      const workspace = await gateway.state.createWorkspace(workspacePath, 'STO05 journey')
      const delegationResponse = await fetch(
        `http://127.0.0.1:${gateway.port}/api/v1/auth/delegations`,
        {
          method: 'POST',
          headers: ownerHeaders,
          body: JSON.stringify({
            delegateId: 'sto05-delegate',
            workspaceId: workspace.id,
            profileId: 'mini',
            purpose: 'storage_contract',
            operations: ['runs.events', 'runs.resume', 'runs.snapshot', 'runs.start'],
          }),
        },
      )
      expect(delegationResponse.status).toBe(201)
      const delegation = await delegationResponse.json() as {
        token: string
        principal: DelegatedPrincipal
      }
      const principalKey = principalContinuityKey(delegation.principal)
      const thread = await gateway.state.createDelegatedThread(
        'mini',
        workspace.id,
        principalKey,
      )

      const opaqueHandle = await gateway.credentialResolver.resolve('ANTHROPIC_API_KEY', {
        agentId: 'root',
        sessionId: 'sto05-session',
        threadId: thread.id,
        toolName: 'contract-tool',
      })
      expect(JSON.stringify(opaqueHandle)).not.toContain(CREDENTIAL_SECRET)

      const runInput = {
        profileId: 'mini',
        threadId: thread.id,
        workspaceId: workspace.id,
        prompt: 'Run the bounded STO05 approval journey.',
      }
      const claim = await gateway.runIdempotency.claim({
        principalKey,
        operation: 'runs.start',
        key: IDEMPOTENCY_KEY,
        input: runInput,
      })
      expect(claim.kind).toBe('claimed')
      if (claim.kind !== 'claimed') throw new Error('journey idempotency claim failed')
      const run = await gateway.runStore.create({
        threadId: thread.id,
        workspaceId: workspace.id,
        profileId: 'mini',
        model: 'test:model',
        timeoutMs: 60_000,
        startSeq: 0,
      })
      await gateway.runIdempotency.linkRun(claim.recordId, run.runId)
      await gateway.runIdempotency.complete({
        principalKey,
        operation: 'runs.start',
        key: IDEMPOTENCY_KEY,
        statusCode: 200,
        result: {
          runId: run.runId,
          threadId: thread.id,
          agentId: 'root',
          profileId: 'mini',
          candidateId: null,
          model: 'test:model',
          status: 'running',
          timeoutMs: 60_000,
        },
      })

      const hitl = new HumanInTheLoop({ timeoutMs: 10_000 })
      hitl.onApprovalNeeded(() => {})
      const session = new ApprovalJourneySession(hitl) as unknown as Session
      gateway.state.setSession(thread.id, session)
      gateway.state.setRuntime(thread.id, { session, hitl, zoneManager: null })
      const handle = gateway.runner.start({
        runId: run.runId,
        threadId: thread.id,
        profileId: 'mini',
        model: 'test:model',
        permissionPolicyRevision: 'a'.repeat(64),
        prompt: runInput.prompt,
      })

      const delegatedHeaders = { authorization: `Bearer ${delegation.token}` }
      const eventsResponse = await fetch(
        `http://127.0.0.1:${gateway.port}/api/v1/runs/${run.runId}/events`,
        { headers: delegatedHeaders },
      )
      expect(eventsResponse.status).toBe(200)
      const permission = await readSseUntil(
        eventsResponse,
        event => event['type'] === 'permission.request',
      )
      expect(permission).toMatchObject({
        requestId: 'sto05_permission',
        toolName: 'send_email',
      })
      expect(permission['operationHash']).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.stringify(permission)).not.toContain(PERMISSION_INPUT_SECRET)

      const decisionResponse = await fetch(
        `http://127.0.0.1:${gateway.port}/api/v1/runs/${run.runId}` +
          '/permissions/sto05_permission/decision',
        {
          method: 'POST',
          headers: { ...delegatedHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({
            decision: 'approve',
            operationHash: permission['operationHash'],
          }),
        },
      )
      expect(decisionResponse.status).toBe(200)
      await handle.done
      expect(await gateway.runStore.get(run.runId)).toMatchObject({
        status: 'succeeded',
        terminal: true,
      })

      const credentialRowsBeforeRestart = gateway.state.rawDbHandle.prepare(`
        SELECT c.id, c.name, c.encrypted_value, c.hint, a.event_type, a.detail
        FROM credentials c
        LEFT JOIN credential_audit_log a ON a.credential_id = c.id
        WHERE c.id = ?
      `).all(credentialBody.credential.id)
      expect(JSON.stringify(credentialRowsBeforeRestart)).not.toContain(CREDENTIAL_SECRET)

      await gateway.stop()
      gateway = createGateway()
      await gateway.start()
      expect(gateway.token).toBe(ownerToken)

      const baseUrl = `http://127.0.0.1:${gateway.port}`
      const replayResponse = await fetch(`${baseUrl}/api/v1/run`, {
        method: 'POST',
        headers: {
          ...delegatedHeaders,
          'content-type': 'application/json',
          'idempotency-key': IDEMPOTENCY_KEY,
        },
        body: JSON.stringify(runInput),
      })
      expect(replayResponse.status).toBe(200)
      expect(replayResponse.headers.get('idempotency-replayed')).toBe('true')
      await expect(replayResponse.json()).resolves.toMatchObject({
        runId: run.runId,
        threadId: thread.id,
      })

      const snapshotResponse = await fetch(`${baseUrl}/api/v1/runs/${run.runId}`, {
        headers: delegatedHeaders,
      })
      expect(snapshotResponse.status).toBe(200)
      await expect(snapshotResponse.json()).resolves.toMatchObject({
        runId: run.runId,
        status: 'succeeded',
        terminal: true,
        outcomeKnown: true,
      })
      expect(await gateway.state.securityRepositories.threadBindings.allows(
        thread.id,
        principalKey,
      )).toBe(true)
      expect(await gateway.state.securityRepositories.principals.find(
        delegation.principal.tokenId,
      )).toMatchObject({ tokenId: delegation.principal.tokenId, revokedAt: null })

      const auditResponse = await fetch(
        `${baseUrl}/api/v1/credentials/${credentialBody.credential.id}/audit`,
        { headers: { authorization: `Bearer ${gateway.token}` } },
      )
      expect(auditResponse.status).toBe(200)
      const auditBody = await auditResponse.json()
      expect(JSON.stringify(auditBody)).toContain('resolve')
      expect(JSON.stringify(auditBody)).not.toContain(CREDENTIAL_SECRET)
      const metadataResponse = await fetch(
        `${baseUrl}/api/v1/credentials/${credentialBody.credential.id}`,
        { headers: { authorization: `Bearer ${gateway.token}` } },
      )
      expect(metadataResponse.status).toBe(200)
      expect(await metadataResponse.text()).not.toContain(CREDENTIAL_SECRET)

      const durableRows = gateway.state.rawDbHandle.prepare(`
        SELECT c.encrypted_value, c.hint, a.detail, i.result_json
        FROM credentials c
        LEFT JOIN credential_audit_log a ON a.credential_id = c.id
        LEFT JOIN run_idempotency i ON i.idempotency_key = ?
        WHERE c.id = ?
      `).all(IDEMPOTENCY_KEY, credentialBody.credential.id)
      expect(JSON.stringify(durableRows)).not.toContain(CREDENTIAL_SECRET)
      expect(JSON.stringify(durableRows)).not.toContain(PERMISSION_INPUT_SECRET)
      const capturedLogs = consoleSpies.flatMap(spy => spy.mock.calls).join(' ')
      expect(capturedLogs).not.toContain(CREDENTIAL_SECRET)
      expect(capturedLogs).not.toContain(PERMISSION_INPUT_SECRET)
    } finally {
      for (const spy of consoleSpies) spy.mockRestore()
    }
  }, 15_000)
})
