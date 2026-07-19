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

function sourceDeletionFixture() {
  const counts = {
    immutableOriginals: 1,
    uploadStaging: 0,
    placedCandidates: 0,
    derivedResources: 1,
    dataViews: 0,
    searchIndexes: 0,
    sourceJobs: 2,
    idempotencyReplays: 1,
    retrievalCacheEntries: 0,
  }
  return {
    jobId: '74747474-abab-4747-8747-747474747474',
    sourceId: '51515151-abab-4515-8515-515151515151',
    operation: 'delete_source',
    state: 'queued',
    sourceRevision: 5,
    affected: counts,
    remaining: counts,
    createdAt: 100,
    updatedAt: 100,
    terminalAt: null,
  }
}

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
          subjectId: 'person.synthetic-1',
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
    if (url === '/api/v1/connections?limit=2&cursor=40404040-abab-4404-8404-404040404040') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
        items: [{
          connectionId: '30303030-abab-4303-8303-303030303030',
          capabilityId: 'calendar',
          status: 'connected',
          recovery: 'none',
          changedAt: 1_000,
          expiresAt: null,
          lastVerifiedAt: 2_000,
        }],
        nextCursor: null,
        accessPolicy: 'separate_grant_required',
      }))
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
    if (/^\/api\/v1\/sources\/[^/]+\/versions\/[^/]+\/(jobs|preparations)$/.test(url)) {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        jobId: '61616161-abab-4616-8616-616161616161',
        sourceId: '51515151-abab-4515-8515-515151515151',
        sourceVersionId: '52525252-abab-4525-8525-525252525252',
        ...input,
        implementationVersion: input.operation === 'extract_text'
          ? 'text_extraction.v1'
          : input.operation === 'prepare_data_view'
            ? 'csv_data_view.v1' : 'inspect_format.v1',
        resourceId: null,
        dataViewId: null,
        state: 'queued',
        attempt: 0,
        maxAttempts: 3,
        checkpoint: 0,
        cancelRequestedAt: null,
        outcomeCode: null,
        createdAt: 100,
        updatedAt: 100,
        terminalAt: null,
      }))
      return
    }
    if (/^\/api\/v1\/source-jobs\/[^/]+\/cancel$/.test(url)) {
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        jobId: '61616161-abab-4616-8616-616161616161',
        sourceId: '51515151-abab-4515-8515-515151515151',
        sourceVersionId: '52525252-abab-4525-8525-525252525252',
        operation: 'inspect_format',
        implementationVersion: 'inspect_format.v1',
        resourceId: null,
        dataViewId: null,
        state: 'cancel_requested',
        attempt: 0,
        maxAttempts: 3,
        checkpoint: 0,
        cancelRequestedAt: 101,
        outcomeCode: null,
        createdAt: 100,
        updatedAt: 101,
        terminalAt: null,
        cancellation: 'requested',
      }))
      return
    }
    if (/^\/api\/v1\/source-jobs\/[^/]+$/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        jobId: '61616161-abab-4616-8616-616161616161',
        sourceId: '51515151-abab-4515-8515-515151515151',
        sourceVersionId: '52525252-abab-4525-8525-525252525252',
        operation: 'inspect_format',
        implementationVersion: 'inspect_format.v1',
        resourceId: null,
        dataViewId: null,
        state: 'queued',
        attempt: 0,
        maxAttempts: 3,
        checkpoint: 0,
        cancelRequestedAt: null,
        outcomeCode: null,
        createdAt: 100,
        updatedAt: 100,
        terminalAt: null,
      }))
      return
    }
    if (/^\/api\/v1\/source-data-views\/[^/]+$/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        dataViewId: '64646464-abab-4646-8646-646464646464',
        jobId: '61616161-abab-4616-8616-616161616161',
        sourceId: '51515151-abab-4515-8515-515151515151',
        sourceVersionId: '52525252-abab-4525-8525-525252525252',
        implementationVersion: 'csv_data_view.v1', sourceRevision: 1,
        sourceChecksum: `sha256:${'a'.repeat(64)}`,
        artifactChecksum: `sha256:${'b'.repeat(64)}`,
        artifactByteCount: 128, fieldCount: 2, rowCount: 1,
        fields: [
          { fieldId: `field.${'c'.repeat(32)}`, ordinal: 0, label: 'name' },
          { fieldId: `field.${'d'.repeat(32)}`, ordinal: 1, label: 'formula' },
        ],
        classification: 'internal', authority: 'supporting_reference',
        audiencePolicyRef: 'audience.support',
        sensitivityPolicyRef: 'sensitivity.internal',
        purposePolicyRef: 'purpose.support', retentionPolicyRef: 'retention.standard',
        freshnessPolicyRef: 'freshness.monthly', freshness: 'current',
        createdAt: 100, staleAt: null,
      }))
      return
    }
    if (/^\/api\/v1\/source-data-views\/[^/]+\/access-grants$/.test(url)) {
      res.writeHead(201, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
        grantId: '65656565-abab-4656-8656-656565656565',
        revision: 1, mutation: 'created', acceptedAt: 100,
      }))
      return
    }
    if (/^\/api\/v1\/source-data-views\/[^/]+\/query$/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
        dataViewId: '64646464-abab-4646-8646-646464646464',
        sourceId: '51515151-abab-4515-8515-515151515151',
        sourceVersionId: '52525252-abab-4525-8525-525252525252',
        sourceRevision: 1,
        sourceChecksum: `sha256:${'a'.repeat(64)}`,
        artifactChecksum: `sha256:${'b'.repeat(64)}`,
        freshness: 'current', classification: 'internal',
        authority: 'supporting_reference',
        implementationVersion: 'csv_data_view_selection.v1',
        rowOffset: 0, requestedRowCount: 1, returnedRowCount: 1,
        totalRowCount: 1, complete: true,
        fields: [{ fieldId: `field.${'c'.repeat(32)}`, ordinal: 0, label: 'name' }],
        rows: [{ rowId: `row.${'d'.repeat(32)}`, ordinal: 0, values: ['Ada'] }],
        observedAt: 101,
      }))
      return
    }
    if (/^\/api\/v1\/source-resources\/[^/]+$/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        resourceId: '62626262-abab-4626-8626-626262626262',
        jobId: '61616161-abab-4616-8616-616161616161',
        sourceId: '51515151-abab-4515-8515-515151515151',
        sourceVersionId: '52525252-abab-4525-8525-525252525252',
        kind: 'text_extraction', operation: 'extract_text',
        implementationVersion: 'text_extraction.v1', sourceRevision: 1,
        sourceChecksum: `sha256:${'a'.repeat(64)}`,
        resourceChecksum: `sha256:${'a'.repeat(64)}`,
        byteStart: 0, byteEnd: 10, byteCount: 10,
        classification: 'internal', authority: 'supporting_reference',
        audiencePolicyRef: 'audience.support',
        sensitivityPolicyRef: 'sensitivity.internal',
        purposePolicyRef: 'purpose.support', retentionPolicyRef: 'retention.standard',
        freshnessPolicyRef: 'freshness.monthly', coverage: 'complete',
        freshness: 'current', createdAt: 100, staleAt: null,
      }))
      return
    }
    if (/^\/api\/v1\/source-resources\/[^/]+\/access-grants$/.test(url)) {
      res.writeHead(201, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
        grantId: '63636363-abab-4636-8636-636363636363',
        revision: 1, mutation: 'created', acceptedAt: 100,
      }))
      return
    }
    if (/^\/api\/v1\/source-resources\/[^/]+\/content$/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
        resourceId: '62626262-abab-4626-8626-626262626262',
        sourceId: '51515151-abab-4515-8515-515151515151',
        sourceVersionId: '52525252-abab-4525-8525-525252525252',
        sourceRevision: 1,
        sourceChecksum: `sha256:${'a'.repeat(64)}`,
        resourceChecksum: `sha256:${'a'.repeat(64)}`,
        freshness: 'current', classification: 'internal',
        authority: 'supporting_reference', text: 'guide',
        byteStart: 0, byteEnd: 5, byteCount: 5, totalByteCount: 20,
        observedAt: 101,
      }))
      return
    }
    if (/^\/api\/v1\/source-resources\/[^/]+\/content\/search$/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
        resourceId: '62626262-abab-4626-8626-626262626262',
        sourceId: '51515151-abab-4515-8515-515151515151',
        sourceVersionId: '52525252-abab-4525-8525-525252525252',
        sourceRevision: 1,
        sourceChecksum: `sha256:${'a'.repeat(64)}`,
        resourceChecksum: `sha256:${'a'.repeat(64)}`,
        freshness: 'current', classification: 'internal',
        authority: 'supporting_reference', status: 'complete',
        matchMode: 'exact_utf8', truncated: false, totalByteCount: 20,
        observedAt: 101,
        matches: [{
          evidenceId: `sha256:${'b'.repeat(64)}`, text: 'guide',
          byteStart: 0, byteEnd: 5, matchByteStart: 0, matchByteEnd: 5,
        }],
      }))
      return
    }
    if (url === '/api/v1/access-grants?limit=10&cursor=63636363-abab-4636-8636-636363636363') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ items: [], nextCursor: null }))
      return
    }
    if (/^\/api\/v1\/access-grants\/[^/]+\/revoke$/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
        grantId: '63636363-abab-4636-8636-636363636363',
        revision: 2, mutation: 'revoked', acceptedAt: 102,
      }))
      return
    }
    if (/^\/api\/v1\/access-grants\/[^/]+$/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
        grantId: '63636363-abab-4636-8636-636363636363', revision: 1,
        state: 'active', workspaceId: 'ws_1', profileId: 'assistant',
        subjectId: 'person.synthetic-1', purpose: 'customer_support',
        channel: 'web.primary', resourceKind: 'source_resource',
        resourceId: '62626262-abab-4626-8626-626262626262',
        operation: 'source_content.read', fieldScope: { mode: 'all' },
        rowScope: { mode: 'all' },
        consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' },
        autonomyCeiling: 'observe', effectiveAt: 100, expiresAt: 160,
        issuedBy: 'install_owner', revisionCreatedAt: 100, revokedAt: null,
      }))
      return
    }
    if (/^\/api\/v1\/sources\/[^/]+\/deletions$/.test(url)) {
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify(sourceDeletionFixture()))
      return
    }
    if (/^\/api\/v1\/source-deletions\/[^/]+\/cancel$/.test(url)) {
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ...sourceDeletionFixture(), state: 'cancel_requested', cancellation: 'requested',
      }))
      return
    }
    if (/^\/api\/v1\/source-deletions\/[^/]+\/retry$/.test(url)) {
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ...sourceDeletionFixture(), retry: 'queued' }))
      return
    }
    if (/^\/api\/v1\/source-deletions\/[^/]+$/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(sourceDeletionFixture()))
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
    if (url === '/refresh-conflict/api/v1/source-uploads/old-upload/complete') {
      res.writeHead(409, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        error: 'source_upload_refresh_conflict',
        message: 'Source changed after this upload session was created.',
        category: 'invalid_request',
        correlationId: 'b638e764-8391-4c51-a5dc-3df1b1cb42cb',
        actualRevision: 7,
        actualCurrentVersionId: '70707070-abab-4707-8707-707070707070',
        privateObjectKey: '/private/source-canary',
      }))
      return
    }
    if (url === '/quota/api/v1/sources') {
      res.writeHead(409, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        error: 'source_quota_exceeded',
        message: 'Source quota does not allow this operation.',
        category: 'invalid_request',
        resourceClass: 'source_storage_bytes',
        currentUsage: 999,
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

  it('preserves only validated actual identity on a stale source refresh', async () => {
    const refreshing = new OwnwareClient({ baseUrl: `${baseUrl}/refresh-conflict` })
    const thrown = await refreshing.completeSourceUpload('old-upload')
      .catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(OwnwareError)
    expect(thrown).toMatchObject({
      status: 409,
      code: 'source_upload_refresh_conflict',
      actualRevision: 7,
      actualCurrentVersionId: '70707070-abab-4707-8707-707070707070',
    })
    expect(thrown).not.toHaveProperty('privateObjectKey')
    expect(String(thrown)).not.toContain('/private/source-canary')
  })

  it('preserves only the closed source quota resource class', async () => {
    const quota = new OwnwareClient({ baseUrl: `${baseUrl}/quota`, token: 'test-token' })
    const error = await quota.registerSource({
      kind: 'file', label: 'Quota source', classification: 'internal',
      authority: 'supporting_reference', audiencePolicyRef: 'audience.test',
      sensitivityPolicyRef: 'sensitivity.test', purposePolicyRef: 'purpose.test',
      retentionPolicyRef: 'retention.test', freshnessPolicyRef: 'freshness.test',
      idempotencyKey: '35353535-abab-4535-8535-353535353535',
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(OwnwareError)
    expect(error).toMatchObject({
      code: 'source_quota_exceeded', resourceClass: 'source_storage_bytes',
    })
    expect(error).not.toHaveProperty('currentUsage')
  })

  it('issues and revokes a delegation through the published owner SDK', async () => {
    const start = seen.length
    const ownware = client()
    const issued = await ownware.issueDelegation({
      delegateId: 'browser-1',
      subjectId: 'person.synthetic-1',
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
      subjectId: 'person.synthetic-1',
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

  it('lists only the bounded owner connection projection', async () => {
    await expect(client().connections({
      limit: 2,
      cursor: '40404040-abab-4404-8404-404040404040',
    })).resolves.toEqual({
      items: [{
        connectionId: '30303030-abab-4303-8303-303030303030',
        capabilityId: 'calendar',
        status: 'connected',
        recovery: 'none',
        changedAt: 1_000,
        expiresAt: null,
        lastVerifiedAt: 2_000,
      }],
      nextCursor: null,
      accessPolicy: 'separate_grant_required',
    })
    expect(seen.at(-1)).toMatchObject({
      method: 'GET',
      url: '/api/v1/connections?limit=2&cursor=40404040-abab-4404-8404-404040404040',
      auth: 'Bearer tok123',
    })
  })

  it('creates, reads, and requests cancellation of one exact source job', async () => {
    const ownware = client()
    const sourceId = '51515151-abab-4515-8515-515151515151'
    const sourceVersionId = '52525252-abab-4525-8525-525252525252'
    const job = await ownware.createSourceJob(sourceId, sourceVersionId, {
      operation: 'inspect_format',
      idempotencyKey: '61616161-abab-4616-8616-616161616161',
    })
    expect(job).toMatchObject({ sourceId, sourceVersionId, state: 'queued' })
    expect(seen.at(-1)).toMatchObject({
      method: 'POST',
      url: `/api/v1/sources/${sourceId}/versions/${sourceVersionId}/jobs`,
      idempotencyKey: '61616161-abab-4616-8616-616161616161',
    })
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ operation: 'inspect_format' })

    await expect(ownware.sourceJob(job.jobId)).resolves.toMatchObject({
      jobId: job.jobId, state: 'queued',
    })
    await expect(ownware.cancelSourceJob(job.jobId)).resolves.toMatchObject({
      jobId: job.jobId, state: 'cancel_requested', cancellation: 'requested',
    })
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({})
  })

  it('requests text preparation separately and reads its safe resource manifest', async () => {
    const ownware = client()
    const sourceId = '51515151-abab-4515-8515-515151515151'
    const sourceVersionId = '52525252-abab-4525-8525-525252525252'
    const prepared = await ownware.createSourcePreparation(sourceId, sourceVersionId, {
      operation: 'extract_text',
      idempotencyKey: '62626262-abab-4626-8626-626262626262',
    })
    expect(prepared).toMatchObject({
      operation: 'extract_text', implementationVersion: 'text_extraction.v1', resourceId: null,
    })
    expect(seen.at(-1)).toMatchObject({
      method: 'POST',
      url: `/api/v1/sources/${sourceId}/versions/${sourceVersionId}/preparations`,
      idempotencyKey: '62626262-abab-4626-8626-626262626262',
    })
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ operation: 'extract_text' })

    const resourceId = '62626262-abab-4626-8626-626262626262'
    await expect(ownware.sourceResource(resourceId)).resolves.toMatchObject({
      resourceId, freshness: 'current', kind: 'text_extraction',
    })
    expect(seen.at(-1)!.url).toBe(`/api/v1/source-resources/${resourceId}`)
  })

  it('requests Data View preparation through the same typed job method', async () => {
    const ownware = client()
    const sourceId = '51515151-abab-4515-8515-515151515151'
    const sourceVersionId = '52525252-abab-4525-8525-525252525252'
    const prepared = await ownware.createSourcePreparation(sourceId, sourceVersionId, {
      operation: 'prepare_data_view',
      idempotencyKey: '63636363-abab-4636-8636-636363636363',
    })
    expect(prepared).toMatchObject({
      operation: 'prepare_data_view',
      implementationVersion: 'csv_data_view.v1',
      resourceId: null,
      dataViewId: null,
    })
    expect(seen.at(-1)).toMatchObject({
      method: 'POST',
      url: `/api/v1/sources/${sourceId}/versions/${sourceVersionId}/preparations`,
      idempotencyKey: '63636363-abab-4636-8636-636363636363',
    })
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ operation: 'prepare_data_view' })
  })

  it('reads one content-free Data View manifest through its dedicated method', async () => {
    const ownware = client()
    const dataViewId = '64646464-abab-4646-8646-646464646464'
    await expect(ownware.sourceDataView(dataViewId)).resolves.toMatchObject({
      dataViewId,
      implementationVersion: 'csv_data_view.v1',
      fieldCount: 2,
      rowCount: 1,
      fields: [
        { ordinal: 0, label: 'name' },
        { ordinal: 1, label: 'formula' },
      ],
      freshness: 'current',
      staleAt: null,
    })
    expect(seen.at(-1)).toMatchObject({
      method: 'GET',
      url: `/api/v1/source-data-views/${dataViewId}`,
    })
  })

  it('creates an exact Data View query grant and queries without a caller-supplied subject', async () => {
    const ownware = client()
    const dataViewId = '64646464-abab-4646-8646-646464646464'
    const fieldId = `field.${'c'.repeat(32)}`
    const rowId = `row.${'d'.repeat(32)}`

    await expect(ownware.createDataViewQueryGrant(dataViewId, {
      subjectId: 'delegate.synthetic-1', purpose: 'customer_support',
      channel: 'web.primary', consent: { state: 'not_required' },
      fieldIds: [fieldId], rowOffset: 0, rowCount: 1, ttlSeconds: 60,
      idempotencyKey: '65656565-abab-4656-8656-656565656565',
    })).resolves.toEqual({
      grantId: '65656565-abab-4656-8656-656565656565',
      revision: 1, mutation: 'created', acceptedAt: 100,
    })
    expect(seen.at(-1)).toMatchObject({
      method: 'POST',
      url: `/api/v1/source-data-views/${dataViewId}/access-grants`,
      idempotencyKey: '65656565-abab-4656-8656-656565656565',
    })
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({
      subjectId: 'delegate.synthetic-1', purpose: 'customer_support',
      channel: 'web.primary', consent: { state: 'not_required' },
      fieldIds: [fieldId], rowOffset: 0, rowCount: 1, ttlSeconds: 60,
    })

    await expect(ownware.querySourceDataView(dataViewId, {
      consent: { state: 'not_required' }, fieldIds: [fieldId],
      rowOffset: 0, rowCount: 1,
    })).resolves.toMatchObject({
      dataViewId, implementationVersion: 'csv_data_view_selection.v1',
      complete: true,
      fields: [{ fieldId, ordinal: 0, label: 'name' }],
      rows: [{ rowId, ordinal: 0, values: ['Ada'] }],
    })
    expect(seen.at(-1)).toMatchObject({
      method: 'POST', url: `/api/v1/source-data-views/${dataViewId}/query`,
    })
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({
      consent: { state: 'not_required' }, fieldIds: [fieldId],
      rowOffset: 0, rowCount: 1,
    })
    expect(seen.at(-1)!.body).not.toContain('subjectId')
  })

  it('manages grants and reads protected content through exact request shapes', async () => {
    const ownware = client()
    const resourceId = '62626262-abab-4626-8626-626262626262'
    const grantId = '63636363-abab-4636-8636-636363636363'
    await expect(ownware.createAccessGrant(resourceId, {
      subjectId: 'person.synthetic-1', purpose: 'customer_support',
      channel: 'web.primary',
      consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' },
      ttlSeconds: 60,
      idempotencyKey: '64646464-abab-4646-8646-646464646464',
    })).resolves.toEqual({ grantId, revision: 1, mutation: 'created', acceptedAt: 100 })
    expect(seen.at(-1)).toMatchObject({
      method: 'POST',
      url: `/api/v1/source-resources/${resourceId}/access-grants`,
      idempotencyKey: '64646464-abab-4646-8646-646464646464',
    })
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({
      subjectId: 'person.synthetic-1', purpose: 'customer_support',
      channel: 'web.primary',
      consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' },
      ttlSeconds: 60,
    })

    await expect(ownware.accessGrant(grantId)).resolves.toMatchObject({
      grantId, operation: 'source_content.read', state: 'active',
    })
    await expect(ownware.accessGrants({ limit: 10, cursor: grantId })).resolves.toEqual({
      items: [], nextCursor: null,
    })

    const readInputWithLegacySubject = {
      subjectId: 'person.synthetic-1',
      consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' },
      byteStart: 0, byteEnd: 5,
    } as const
    await expect(ownware.readSourceContent(resourceId, readInputWithLegacySubject))
      .resolves.toMatchObject({ resourceId, text: 'guide', byteCount: 5 })
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({
      consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' },
      byteStart: 0, byteEnd: 5,
    })

    await expect(ownware.createAccessGrant(resourceId, {
      operation: 'source_content.search',
      subjectId: 'person.synthetic-1', purpose: 'customer_support',
      channel: 'web.primary', consent: { state: 'not_required' }, ttlSeconds: 60,
      idempotencyKey: '66666666-abab-4666-8666-666666666666',
    })).resolves.toMatchObject({ mutation: 'created' })
    expect(JSON.parse(seen.at(-1)!.body)).toMatchObject({
      operation: 'source_content.search',
    })

    const searchInputWithLegacySubject = {
      subjectId: 'person.synthetic-1',
      consent: { state: 'not_required' },
      query: 'guide', matchMode: 'exact_utf8', maxMatches: 10, contextBytes: 32,
    } as const
    await expect(ownware.searchSourceContent(resourceId, searchInputWithLegacySubject))
      .resolves.toMatchObject({
        resourceId, status: 'complete', matches: [{ text: 'guide' }],
      })
    expect(seen.at(-1)!.url).toBe(`/api/v1/source-resources/${resourceId}/content/search`)
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({
      consent: { state: 'not_required' },
      query: 'guide', matchMode: 'exact_utf8', maxMatches: 10, contextBytes: 32,
    })

    await expect(ownware.revokeAccessGrant(grantId, {
      expectedRevision: 1,
      idempotencyKey: '65656565-abab-4656-8656-656565656565',
    })).resolves.toEqual({ grantId, revision: 2, mutation: 'revoked', acceptedAt: 102 })
    expect(seen.at(-1)).toMatchObject({
      url: `/api/v1/access-grants/${grantId}/revoke`,
      idempotencyKey: '65656565-abab-4656-8656-656565656565',
    })
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ expectedRevision: 1 })
  })

  it('creates, reads, cancels, and retries source deletion through exact request shapes', async () => {
    const ownware = client()
    const created = await ownware.createSourceDeletion('source/id', {
      expectedRevision: 4,
      idempotencyKey: '74747474-abab-4747-8747-747474747474',
    })
    expect(created).toMatchObject({ operation: 'delete_source', state: 'queued' })
    expect(seen.at(-1)).toMatchObject({
      method: 'POST',
      url: '/api/v1/sources/source%2Fid/deletions',
      idempotencyKey: '74747474-abab-4747-8747-747474747474',
    })
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ expectedRevision: 4 })

    await expect(ownware.sourceDeletion('job/id')).resolves.toMatchObject({
      jobId: created.jobId, state: 'queued',
    })
    expect(seen.at(-1)!.url).toBe('/api/v1/source-deletions/job%2Fid')

    await expect(ownware.cancelSourceDeletion('job/id')).resolves.toMatchObject({
      state: 'cancel_requested', cancellation: 'requested',
    })
    expect(seen.at(-1)!.url).toBe('/api/v1/source-deletions/job%2Fid/cancel')
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({})

    await expect(ownware.retrySourceDeletion('job/id')).resolves.toMatchObject({
      state: 'queued', retry: 'queued',
    })
    expect(seen.at(-1)!.url).toBe('/api/v1/source-deletions/job%2Fid/retry')
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({})
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
