/**
 * OwnwareClient — unit tests against an in-process fake gateway.
 *
 * Pins the transport contract without booting cortex:
 *   - request shapes (paths, bodies, Bearer header on EVERY call)
 *   - streamReply's termination rules (the root SSE never closes)
 *   - the seq/since resume cursor
 *   - error propagation on non-OK responses
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { OwnwareClient, OwnwareError } from '../client.js'

interface Seen {
  method: string
  url: string
  auth: string | undefined
  idempotencyKey: string | undefined
  body: string
}

let server: Server
let baseUrl: string
const seen: Seen[] = []

/** SSE frames the fake gateway plays for any events request. */
let sseScript: Array<Record<string, unknown>> = []

beforeAll(async () => {
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    seen.push({
      method: req.method ?? '',
      url: req.url ?? '',
      auth: req.headers.authorization,
      idempotencyKey: req.headers['idempotency-key'] as string | undefined,
      body: Buffer.concat(chunks).toString('utf8'),
    })

    const url = req.url ?? ''
    if (url === '/api/v1/auth/delegations') {
      res.writeHead(201, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
        token: 'delegated.jwt.token',
        principal: {
          kind: 'delegated',
          tokenId: '9139eb73-c93f-4a7d-a042-bc07a108c251',
          delegateId: 'browser-1',
          workspaceId: 'ws_1',
          profileId: 'assistant',
          purpose: 'support',
          operations: ['gateway.capabilities'],
          issuedAt: 1,
          expiresAt: 901,
        },
      }))
      return
    }
    if (url === '/api/v1/candidates/validate') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        valid: true,
        candidateId: `sha256:${'a'.repeat(64)}`,
        profileName: 'portable',
        fileCount: 1,
        totalBytes: 19,
        findings: [],
      }))
      return
    }
    if (url === '/api/v1/sources' && req.method === 'POST') {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        sourceId: '51515151-abab-4515-8515-515151515151',
        ...input,
        revision: 1,
        currentVersionId: null,
        health: {
          registration: 'pending', inspection: 'not_started',
          preparation: 'not_requested', access: 'available',
          freshness: 'unknown', conflict: 'none', deletion: 'active',
        },
        createdAt: 100,
        updatedAt: 100,
      }))
      return
    }
    if (url === '/api/v1/sources?limit=10&cursor=50505050-abab-4505-8505-505050505050') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ items: [], nextCursor: null }))
      return
    }
    if (url === '/api/v1/sources/51515151-abab-4515-8515-515151515151') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        sourceId: '51515151-abab-4515-8515-515151515151',
        kind: 'file',
        label: 'Approved guide',
        classification: 'internal',
        authority: 'supporting_reference',
        audiencePolicyRef: 'audience.support-team',
        sensitivityPolicyRef: 'sensitivity.internal',
        purposePolicyRef: 'purpose.customer-support',
        retentionPolicyRef: 'retention.standard',
        freshnessPolicyRef: 'freshness.monthly',
        revision: 1,
        currentVersionId: null,
        health: {
          registration: 'pending', inspection: 'not_started',
          preparation: 'not_requested', access: 'available',
          freshness: 'unknown', conflict: 'none', deletion: 'active',
        },
        createdAt: 100,
        updatedAt: 100,
      }))
      return
    }
    if (url === '/api/v1/candidates/stage') {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { candidateId: string }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        candidateId: input.candidateId,
        profileName: 'portable',
        state: 'ready',
        ready: true,
        idempotent: false,
        code: null,
        fileCount: 1,
        totalBytes: 19,
      }))
      return
    }
    if (url === '/api/v1/candidates/activate') {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        candidateId: string
        expectedActiveCandidateId: string | null
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        state: 'active',
        changed: true,
        candidateId: input.candidateId,
        previousCandidateId: input.expectedActiveCandidateId,
        activeCandidateId: input.candidateId,
        code: null,
      }))
      return
    }
    if (url === '/api/v1/candidates/rollback') {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        candidateId: string
        expectedActiveCandidateId: string
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        state: 'rolled_back',
        changed: true,
        candidateId: input.candidateId,
        previousCandidateId: input.expectedActiveCandidateId,
        activeCandidateId: input.candidateId,
        code: null,
      }))
      return
    }
    if (/^\/api\/v1\/profiles\/[^/]+\/(pause|resume)$/.test(url)) {
      const expected = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        expectedDeploymentRevision: number
      }
      const state = url.endsWith('/pause') ? 'paused' : 'active'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        state,
        changed: true,
        profileId: 'portable',
        activeCandidateId: `sha256:${'a'.repeat(64)}`,
        deploymentRevision: expected.expectedDeploymentRevision + 1,
        routingState: state,
        health: 'healthy',
        healthObservedAt: 123,
        activeRunCount: state === 'paused' ? 1 : 0,
      }))
      return
    }
    if (/^\/api\/v1\/profile-candidates\/[^/]+$/.test(url)) {
      const candidateId = `sha256:${'a'.repeat(64)}`
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(req.method === 'DELETE' ? {
        candidateId,
        profileId: 'portable',
        state: 'deleted',
        deleted: true,
        idempotent: false,
        code: null,
      } : {
        candidateId,
        profileId: 'portable',
        state: 'ready',
        ready: true,
        fileCount: 1,
        totalBytes: 19,
        code: null,
        createdAt: 100,
        updatedAt: 100,
        deletedAt: null,
        deletionEligible: true,
        deletionBlockedBy: null,
      }))
      return
    }
    if (url === '/api/v1/profiles/portable/candidates') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ profileId: 'portable', items: [{
        candidateId: `sha256:${'a'.repeat(64)}`,
        profileId: 'portable',
        state: 'ready',
        ready: true,
        fileCount: 1,
        totalBytes: 19,
        code: null,
        createdAt: 100,
        updatedAt: 100,
        deletedAt: null,
        deletionEligible: true,
        deletionBlockedBy: null,
      }] }))
      return
    }
    if (url === '/api/v1/profiles/portable/deployment') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        profileId: 'portable',
        activeCandidateId: `sha256:${'a'.repeat(64)}`,
        deploymentRevision: 5,
        routingState: 'active',
        health: 'healthy',
        healthObservedAt: 123,
        activeRunCount: 0,
        updatedAt: 123,
      }))
      return
    }
    if (/\/api\/v1\/auth\/delegations\/[^/]+\/revoke$/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ tokenId: '9139eb73-c93f-4a7d-a042-bc07a108c251', revoked: true }))
      return
    }
    if (url.startsWith('/limited/api/v1/models')) {
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '12',
        'x-ownware-correlation-id': 'e5f8caa8-c15a-48ea-9462-ec3cccfb0579',
      })
      res.end(JSON.stringify({
        error: 'rate_limited',
        message: 'Too many requests. Please slow down.',
        category: 'rate_limit',
        correlationId: 'e5f8caa8-c15a-48ea-9462-ec3cccfb0579',
        retryAfter: 12,
      }))
      return
    }
    if (url === '/api/v1/run') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ threadId: 't_1', agentId: 'root', model: 'ollama:llama3.2', status: 'running' }))
      return
    }
    if (/\/agents\/root\/events/.test(url) || /\/api\/v1\/runs\/[^/]+\/events/.test(url)) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(':keepalive\n\n')
      for (const ev of sseScript) res.write(`data: ${JSON.stringify(ev)}\n\n`)
      // Leave the socket open — the root SSE never closes; the CLIENT
      // must decide the reply is finished and hang up.
      return
    }
    if (/\/api\/v1\/runs\/[^/]+\/permissions\/[^/]+\/decision$/.test(url)) {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        runId: '88888888-8888-4888-8888-888888888888',
        requestId: 'permission_1',
        ...body,
      }))
      return
    }
    if (/\/api\/v1\/runs\/[^/]+\/cancel$/.test(url)) {
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        runId: '88888888-8888-4888-8888-888888888888',
        status: 'cancel_requested',
        terminal: false,
        outcomeKnown: true,
        cancellation: 'requested',
      }))
      return
    }
    if (/\/resume$/.test(url) || /\/abort$/.test(url)) {
      if (url.includes('/threads/missing/')) {
        res.writeHead(404, {
          'content-type': 'application/json',
          'x-ownware-correlation-id': 'a778770d-d2ca-4b59-a5de-fd4fec13f541',
        })
        res.end(JSON.stringify({
          error: 'not_found',
          message: 'Thread not found',
          category: 'not_found',
          correlationId: 'a778770d-d2ca-4b59-a5de-fd4fec13f541',
        }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    if (url.startsWith('/api/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ id: 'ollama:llama3.2', provider: 'ollama', hasCredentials: true, default: true }]))
      return
    }
    if (url.startsWith('/api/v1/capabilities')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        contract: { name: 'ownware.gateway', major: 1, revision: '0.3.0' },
        capabilities: [
          { id: 'gateway.capabilities', version: 1 },
          { id: 'runs.start', version: 2 },
        ],
      }))
      return
    }
    if (url.startsWith('/api/v1/health')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', version: '0.0.0' }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'nope' }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(() => {
  server.close()
})

function client(): OwnwareClient {
  return new OwnwareClient({ baseUrl, token: 'tok123' })
}

describe('request shapes', () => {
  it('run() POSTs the body and returns the full result', async () => {
    const result = await client().run({
      profileId: 'assistant',
      prompt: 'hi',
      threadId: 't_1',
      model: 'x:y',
      attachments: [{ filename: 'note.txt', mimeType: 'text/plain', data: 'aGk=' }],
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    })
    expect(result.threadId).toBe('t_1')
    expect(result.model).toBe('ollama:llama3.2')
    const last = seen[seen.length - 1]!
    expect(last.method).toBe('POST')
    expect(last.url).toBe('/api/v1/run')
    expect(last.idempotencyKey).toBe('11111111-1111-4111-8111-111111111111')
    expect(JSON.parse(last.body)).toEqual({
      prompt: 'hi', profileId: 'assistant', threadId: 't_1', model: 'x:y',
      attachments: [{ filename: 'note.txt', mimeType: 'text/plain', data: 'aGk=' }],
    })
  })

  it('every call carries the Bearer token — including the SSE request', async () => {
    sseScript = [{ type: 'turn.end', stopReason: 'end_turn', seq: 1 }]
    const events = []
    for await (const ev of client().streamReply('t_1')) events.push(ev)
    for (const call of seen.slice(-1)) expect(call.auth).toBe('Bearer tok123')

    await client().resume('t_1', { action: 'approve', requestId: 'r1' })
    let last = seen[seen.length - 1]!
    expect(last.url).toBe('/api/v1/threads/t_1/resume')
    expect(JSON.parse(last.body)).toEqual({ action: 'approve', requestId: 'r1' })
    expect(last.auth).toBe('Bearer tok123')

    await client().abort('t_1')
    last = seen[seen.length - 1]!
    expect(last.url).toBe('/api/v1/threads/t_1/abort')
    expect(last.auth).toBe('Bearer tok123')

    const models = await client().models()
    expect(models[0]!.id).toBe('ollama:llama3.2')
    expect(seen[seen.length - 1]!.auth).toBe('Bearer tok123')

    const health = await client().health()
    expect(health.status).toBe('ok')
  })

  it('streamReply passes the since cursor on the URL', async () => {
    sseScript = [{ type: 'turn.end', stopReason: 'end_turn', seq: 10 }]
    for await (const _ of client().streamReply('t_1', { since: 7 })) {
      /* drain */
    }
    const sse = seen.filter((s) => s.url.includes('/events')).pop()!
    expect(sse.url).toContain('since=7')
  })

  it('streamReply uses the bounded run route for an immutable run ID', async () => {
    sseScript = [{ type: 'turn.end', stopReason: 'end_turn', seq: 10 }]
    const runId = '88888888-8888-4888-8888-888888888888'
    for await (const _ of client().streamReply(runId, { since: 7 })) {
      /* drain */
    }
    const sse = seen.filter((s) => s.url.includes('/events')).pop()!
    expect(sse.url).toBe(`/api/v1/runs/${runId}/events?since=7`)
  })

  it('a common non-OK response throws a typed safe error with correlation', async () => {
    const bad = new OwnwareClient({ baseUrl })
    const thrown = await bad.resume('missing', { action: 'deny' }).catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(OwnwareError)
    expect(thrown).toMatchObject({
      message: 'Thread not found',
      status: 404,
      code: 'not_found',
      category: 'not_found',
      correlationId: 'a778770d-d2ca-4b59-a5de-fd4fec13f541',
    })
  })

  it('decides one exact run permission request with its operation hash', async () => {
    const runId = '88888888-8888-4888-8888-888888888888'
    const operationHash = 'a'.repeat(64)
    await expect(client().decidePermission(runId, 'permission_1', {
      decision: 'approve',
      operationHash,
    })).resolves.toEqual({ runId, requestId: 'permission_1', decision: 'approve', operationHash })
    const last = seen.at(-1)!
    expect(last.url).toBe(`/api/v1/runs/${runId}/permissions/permission_1/decision`)
    expect(JSON.parse(last.body)).toEqual({ decision: 'approve', operationHash })
  })

  it('requests cancellation for one exact run', async () => {
    const runId = '88888888-8888-4888-8888-888888888888'
    await expect(client().cancel(runId)).resolves.toMatchObject({
      runId,
      status: 'cancel_requested',
      cancellation: 'requested',
    })
    const last = seen.at(-1)!
    expect(last.method).toBe('POST')
    expect(last.url).toBe(`/api/v1/runs/${runId}/cancel`)
    expect(JSON.parse(last.body)).toEqual({})
  })

  it('does not expose an older malformed response body through the thrown error', async () => {
    const older = new OwnwareClient({ baseUrl: `${baseUrl}/older` })
    const thrown = await older.models().catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(OwnwareError)
    expect(thrown).toMatchObject({
      message: 'Ownware request failed',
      status: 404,
      code: 'unknown_error',
      category: 'unknown',
    })
    expect(String(thrown)).not.toContain('nope')
  })

  it('preserves safe retry metadata on a typed rate-limit error', async () => {
    const limited = new OwnwareClient({ baseUrl: `${baseUrl}/limited` })
    const thrown = await limited.models().catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(OwnwareError)
    expect(thrown).toMatchObject({
      status: 429,
      code: 'rate_limited',
      category: 'rate_limit',
      correlationId: 'e5f8caa8-c15a-48ea-9462-ec3cccfb0579',
      retryAfterSeconds: 12,
    })
  })

  it('issues and revokes a delegation through the published owner SDK', async () => {
    const start = seen.length
    const ownware = client()
    const issued = await ownware.issueDelegation({
      delegateId: 'browser-1',
      workspaceId: 'ws_1',
      profileId: 'assistant',
      purpose: 'support',
      operations: ['gateway.capabilities'],
    })
    expect(issued.token).toBe('delegated.jwt.token')
    await ownware.revokeDelegation(issued.principal.tokenId, 'client_removed')

    const calls = seen.slice(start)
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['POST', '/api/v1/auth/delegations'],
      ['POST', '/api/v1/auth/delegations/9139eb73-c93f-4a7d-a042-bc07a108c251/revoke'],
    ])
    expect(JSON.parse(calls[0]!.body)).toEqual({
      delegateId: 'browser-1',
      workspaceId: 'ws_1',
      profileId: 'assistant',
      purpose: 'support',
      operations: ['gateway.capabilities'],
    })
  })

  it('validates bounded candidate bytes through the published SDK', async () => {
    const contentBase64 = Buffer.from('{"name":"portable"}').toString('base64')
    await expect(client().validateCandidate({
      files: [{ path: 'agent.json', contentBase64 }],
    })).resolves.toMatchObject({
      valid: true,
      candidateId: `sha256:${'a'.repeat(64)}`,
      profileName: 'portable',
      findings: [],
    })
    const last = seen.at(-1)!
    expect(last.method).toBe('POST')
    expect(last.url).toBe('/api/v1/candidates/validate')
    expect(last.auth).toBe('Bearer tok123')
    expect(JSON.parse(last.body)).toEqual({
      files: [{ path: 'agent.json', contentBase64 }],
    })
  })

  it('registers, lists, and reads only scoped source manifests', async () => {
    const ownware = client()
    const registered = await ownware.registerSource({
      kind: 'file',
      label: 'Approved guide',
      classification: 'internal',
      authority: 'supporting_reference',
      audiencePolicyRef: 'audience.support-team',
      sensitivityPolicyRef: 'sensitivity.internal',
      purposePolicyRef: 'purpose.customer-support',
      retentionPolicyRef: 'retention.standard',
      freshnessPolicyRef: 'freshness.monthly',
      idempotencyKey: '51515151-abab-4515-8515-515151515151',
    })
    expect(registered).toMatchObject({
      sourceId: '51515151-abab-4515-8515-515151515151',
      currentVersionId: null,
      health: { registration: 'pending' },
    })
    expect(seen.at(-1)).toMatchObject({
      method: 'POST',
      url: '/api/v1/sources',
      idempotencyKey: '51515151-abab-4515-8515-515151515151',
    })
    expect(JSON.parse(seen.at(-1)!.body)).not.toHaveProperty('idempotencyKey')

    await expect(ownware.sources({
      limit: 10,
      cursor: '50505050-abab-4505-8505-505050505050',
    })).resolves.toEqual({ items: [], nextCursor: null })
    expect(seen.at(-1)!.url).toBe(
      '/api/v1/sources?limit=10&cursor=50505050-abab-4505-8505-505050505050',
    )

    await expect(ownware.source(registered.sourceId)).resolves.toMatchObject({
      sourceId: registered.sourceId,
      label: 'Approved guide',
    })
    expect(seen.at(-1)!.url).toBe(
      '/api/v1/sources/51515151-abab-4515-8515-515151515151',
    )
  })

  it('stages exact candidate bytes through the published SDK', async () => {
    const candidateId = `sha256:${'a'.repeat(64)}`
    const contentBase64 = Buffer.from('{"name":"portable"}').toString('base64')
    await expect(client().stageCandidate({
      candidateId,
      files: [{ path: 'agent.json', contentBase64 }],
    })).resolves.toMatchObject({
      candidateId,
      state: 'ready',
      ready: true,
      idempotent: false,
    })
    const last = seen.at(-1)!
    expect(last.url).toBe('/api/v1/candidates/stage')
    expect(JSON.parse(last.body)).toEqual({
      candidateId,
      files: [{ path: 'agent.json', contentBase64 }],
    })
  })

  it('activates one ready candidate with an explicit compare-and-set expectation', async () => {
    const candidateId = `sha256:${'a'.repeat(64)}`
    await expect(client().activateCandidate({
      profileId: 'portable',
      candidateId,
      expectedActiveCandidateId: null,
    })).resolves.toMatchObject({
      state: 'active',
      changed: true,
      previousCandidateId: null,
      activeCandidateId: candidateId,
    })
    const last = seen.at(-1)!
    expect(last.url).toBe('/api/v1/candidates/activate')
    expect(JSON.parse(last.body)).toEqual({
      profileId: 'portable',
      candidateId,
      expectedActiveCandidateId: null,
    })
  })

  it('rolls back to one named candidate with an explicit active expectation', async () => {
    const previous = `sha256:${'b'.repeat(64)}`
    const candidateId = `sha256:${'a'.repeat(64)}`
    await expect(client().rollbackCandidate({
      profileId: 'portable',
      candidateId,
      expectedActiveCandidateId: previous,
    })).resolves.toMatchObject({
      state: 'rolled_back',
      changed: true,
      previousCandidateId: previous,
      activeCandidateId: candidateId,
    })
    expect(seen.at(-1)!.url).toBe('/api/v1/candidates/rollback')
  })

  it('pauses and resumes a profile with exact revision and idempotency headers', async () => {
    const ownware = client()
    await expect(ownware.pauseProfile({
      profileId: 'portable',
      expectedDeploymentRevision: 3,
      idempotencyKey: '78787878-7878-4878-8878-787878787878',
    })).resolves.toMatchObject({
      state: 'paused', deploymentRevision: 4, activeRunCount: 1,
    })
    expect(seen.at(-1)).toMatchObject({
      url: '/api/v1/profiles/portable/pause',
      idempotencyKey: '78787878-7878-4878-8878-787878787878',
    })
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ expectedDeploymentRevision: 3 })

    await expect(ownware.resumeProfile({
      profileId: 'portable',
      expectedDeploymentRevision: 4,
      idempotencyKey: 'abababab-abab-4bab-8bab-abababababab',
    })).resolves.toMatchObject({
      state: 'active', deploymentRevision: 5, health: 'healthy',
    })
    expect(seen.at(-1)).toMatchObject({
      url: '/api/v1/profiles/portable/resume',
      idempotencyKey: 'abababab-abab-4bab-8bab-abababababab',
    })
  })

  it('reads bounded candidate/deployment status and deletes by opaque identity', async () => {
    const ownware = client()
    const candidateId = `sha256:${'a'.repeat(64)}`
    await expect(ownware.candidate(candidateId)).resolves.toMatchObject({
      candidateId, state: 'ready', deletionEligible: true,
    })
    expect(seen.at(-1)!.url).toContain('/api/v1/profile-candidates/sha256%3A')
    await expect(ownware.candidates('portable')).resolves.toMatchObject({
      profileId: 'portable', items: [{ candidateId }],
    })
    await expect(ownware.deployment('portable')).resolves.toMatchObject({
      activeCandidateId: candidateId, deploymentRevision: 5, health: 'healthy',
    })
    await expect(ownware.deleteCandidate(candidateId)).resolves.toMatchObject({
      candidateId, state: 'deleted', deleted: true,
    })
    expect(seen.at(-1)!.method).toBe('DELETE')
  })

  it('capabilities() returns typed available, unavailable and incompatible states before mutation', async () => {
    const start = seen.length
    const ownware = client()

    await expect(ownware.capabilities({
      requiredMajor: 1,
      requiredCapabilities: { 'runs.start': 1 },
    })).resolves.toMatchObject({ status: 'available' })

    await expect(ownware.capabilities({
      requiredMajor: 1,
      requiredCapabilities: { 'runs.events': 1 },
    })).resolves.toEqual({
      status: 'unavailable',
      missing: ['runs.events'],
      contract: { name: 'ownware.gateway', major: 1, revision: '0.3.0' },
      capabilities: [
        { id: 'gateway.capabilities', version: 1 },
        { id: 'runs.start', version: 2 },
      ],
    })

    await expect(ownware.capabilities({ requiredMajor: 2 })).resolves.toEqual({
      status: 'incompatible',
      expectedMajor: 2,
      actualMajor: 1,
      contract: { name: 'ownware.gateway', major: 1, revision: '0.3.0' },
    })

    const calls = seen.slice(start)
    expect(calls).toHaveLength(3)
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
    expect(calls.every((call) => call.url === '/api/v1/capabilities')).toBe(true)
  })

  it('treats an older Gateway without discovery as unavailable, not compatible', async () => {
    const older = new OwnwareClient({ baseUrl: `${baseUrl}/older`, token: 'tok123' })

    await expect(older.capabilities({
      requiredCapabilities: { 'runs.start': 1 },
    })).resolves.toEqual({
      status: 'unavailable',
      missing: ['gateway.capabilities'],
    })
  })
})

describe('streamReply termination (the root SSE never closes)', () => {
  it('deltas stream, tool_use turn.end continues, terminal turn.end finishes', async () => {
    sseScript = [
      { type: 'text.delta', text: 'Hel', seq: 1 },
      { type: 'turn.end', stopReason: 'tool_use', seq: 2 },
      { type: 'text.delta', text: 'lo', seq: 3 },
      { type: 'turn.end', stopReason: 'end_turn', seq: 4 },
      { type: 'text.delta', text: 'NEVER SEEN', seq: 5 },
    ]
    const got: string[] = []
    let done = false
    for await (const ev of client().streamReply('t_1')) {
      if (ev.type === 'delta') got.push(ev.text)
      if (ev.type === 'done') done = true
    }
    expect(got.join('')).toBe('Hello')
    expect(done).toBe(true)
  })

  it('an error event terminates with type error', async () => {
    sseScript = [
      { type: 'text.delta', text: 'x', seq: 1 },
      { type: 'error', message: 'provider exploded', seq: 2 },
    ]
    const types: string[] = []
    for await (const ev of client().streamReply('t_1')) types.push(ev.type)
    expect(types).toEqual(['delta', 'error'])
  })

  it('events() yields the RAW vocabulary and does not stop at terminal turn.end', async () => {
    sseScript = [
      { type: 'tool.call.start', toolName: 'web_search', seq: 1 },
      { type: 'turn.end', stopReason: 'end_turn', seq: 2 },
      { type: 'permission.request', toolName: 'shell', seq: 3 },
    ]
    const types: string[] = []
    for await (const ev of client().events('t_1')) {
      types.push(ev.type)
      if (types.length === 3) break // raw stream never self-terminates — caller breaks
    }
    expect(types).toEqual(['tool.call.start', 'turn.end', 'permission.request'])
  })
})
