import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir } from 'node:fs/promises'
import { createTestGateway, type TestGateway } from '../harness/gateway.js'
import { CANDIDATE_UPLOAD_MAX_BYTES } from '../../../src/gateway/handlers/candidates.js'

function file(path: string, content: string): { path: string; contentBase64: string } {
  return { path, contentBase64: Buffer.from(content, 'utf8').toString('base64') }
}

describe('Contract: side-effect-free candidate validation', () => {
  let gateway: TestGateway

  beforeEach(async () => {
    gateway = await createTestGateway({ disableAuth: false })
  })

  afterEach(async () => {
    await gateway.stop()
  })

  it('lets a delegated validator obtain a deterministic identity without installing or registering', async () => {
    const beforeProfiles = (await gateway.gateway.registry.list()).length
    const workspace = gateway.gateway.state.createWorkspace(gateway.tmpDir, 'Candidate validation')
    const issued = await gateway.client.post('/api/v1/auth/delegations', {
      delegateId: 'candidate-validator',
      workspaceId: workspace.id,
      profileId: 'mini',
      purpose: 'validate-portable-agent-kit',
      operations: ['candidates.validate'],
    })
    expect(issued.status).toBe(201)
    const delegatedToken = (issued.body as { token: string }).token
    const files = [
      file('agent.json', JSON.stringify({ name: 'portable' })),
      file('skills/one.md', '---\nname: one\n---\nOne'),
    ]
    const validate = (candidateFiles: typeof files) => fetch(
      `${gateway.baseUrl}/api/v1/candidates/validate`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${delegatedToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ files: candidateFiles }),
      },
    )

    const first = await validate(files)
    expect(first.status).toBe(200)
    const firstBody = await first.json() as Record<string, unknown>
    expect(firstBody).toMatchObject({
      valid: true,
      profileName: 'portable',
      findings: [],
      fileCount: 2,
    })
    expect(firstBody['candidateId']).toMatch(/^sha256:[0-9a-f]{64}$/)

    const second = await validate([...files].reverse())
    expect(second.status).toBe(200)
    expect((await second.json() as Record<string, unknown>)['candidateId']).toBe(firstBody['candidateId'])
    expect((await gateway.gateway.registry.list()).length).toBe(beforeProfiles)

    const denied = await fetch(`${gateway.baseUrl}/api/v1/capabilities`, {
      headers: { authorization: `Bearer ${delegatedToken}` },
    })
    expect(denied.status).toBe(403)
    await expect(denied.json()).resolves.toMatchObject({ error: 'principal_operation_denied' })
  })

  it('rejects traversal and duplicates before validation', async () => {
    for (const files of [
      [file('../escape', 'x')],
      [file('/absolute', 'x')],
      [file('agent.json', '{}'), file('agent.json', '{}')],
      [file('SKILLS', 'x'), file('skills/one.md', 'x')],
    ]) {
      const response = await fetch(`${gateway.baseUrl}/api/v1/candidates/validate`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${gateway.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ files }),
      })
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ error: 'candidate_upload_invalid' })
    }
  })

  it('rejects decoded-byte overflow before candidate validation', async () => {
    const beforeProfiles = (await gateway.gateway.registry.list()).length
    const response = await fetch(`${gateway.baseUrl}/api/v1/candidates/validate`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gateway.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        files: [{
          path: 'agent.json',
          contentBase64: Buffer.alloc(CANDIDATE_UPLOAD_MAX_BYTES + 1).toString('base64'),
        }],
      }),
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'candidate_upload_invalid' })
    expect((await gateway.gateway.registry.list()).length).toBe(beforeProfiles)
  })

  it('returns a safe finding for unsupported executable code without mutation', async () => {
    const beforeProfiles = (await gateway.gateway.registry.list()).length
    const response = await fetch(`${gateway.baseUrl}/api/v1/candidates/validate`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gateway.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        files: [
          file('agent.json', '{"name":"portable","tools":{"custom":["tools/unsafe.ts"]}}'),
          file('tools/unsafe.ts', 'export default function unsafe() {}'),
        ],
      }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      valid: false,
      candidateId: null,
      findings: [{ code: 'forbidden_custom_code', severity: 'error' }],
    })
    expect((await gateway.gateway.registry.list()).length).toBe(beforeProfiles)
  })

  it('returns safe findings for invalid profile bytes', async () => {
    const response = await fetch(`${gateway.baseUrl}/api/v1/candidates/validate`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gateway.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ files: [file('agent.json', '{ not json }')] }),
    })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(JSON.parse(body)).toMatchObject({
      valid: false,
      candidateId: null,
      findings: [{ code: 'profile_invalid', severity: 'error' }],
    })
    expect(body).not.toContain(gateway.tmpDir)
    expect(body).not.toContain('{ not json }')
  })

  it('stages exact validated bytes idempotently under delegated profile scope without activation', async () => {
    const files = [file('agent.json', '{"name":"mini"}')]
    const validation = await fetch(`${gateway.baseUrl}/api/v1/candidates/validate`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gateway.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ files }),
    })
    const candidateId = (await validation.json() as { candidateId: string }).candidateId
    const workspace = gateway.gateway.state.createWorkspace(
      `${gateway.tmpDir}/stage-workspace`,
      'Candidate stage',
    )
    const issued = await gateway.client.post('/api/v1/auth/delegations', {
      delegateId: 'candidate-stager',
      workspaceId: workspace.id,
      profileId: 'mini',
      purpose: 'stage-portable-agent-kit',
      operations: ['candidates.stage'],
    })
    const delegatedToken = (issued.body as { token: string }).token
    const beforeProfiles = (await gateway.gateway.registry.list()).length
    const stage = () => fetch(`${gateway.baseUrl}/api/v1/candidates/stage`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${delegatedToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ candidateId, files }),
    })

    const first = await stage()
    expect(first.status).toBe(200)
    const firstText = await first.text()
    expect(JSON.parse(firstText)).toMatchObject({
      candidateId,
      profileName: 'mini',
      state: 'ready',
      ready: true,
      idempotent: false,
    })
    expect(firstText).not.toContain(gateway.tmpDir)

    const second = await stage()
    expect(second.status).toBe(200)
    await expect(second.json()).resolves.toMatchObject({ state: 'ready', idempotent: true })
    expect((await gateway.gateway.registry.list()).length).toBe(beforeProfiles)

    const otherFiles = [file('agent.json', '{"name":"other"}')]
    const otherValidation = await fetch(`${gateway.baseUrl}/api/v1/candidates/validate`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gateway.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ files: otherFiles }),
    })
    const otherCandidateId = (await otherValidation.json() as { candidateId: string }).candidateId
    const wrongProfile = await fetch(`${gateway.baseUrl}/api/v1/candidates/stage`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${delegatedToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        candidateId: otherCandidateId,
        files: otherFiles,
      }),
    })
    expect(wrongProfile.status).toBe(403)
    await expect(wrongProfile.json()).resolves.toMatchObject({ error: 'candidate_scope_mismatch' })
  })

  it('runs and catalogs a candidate-only profile without a legacy registry directory', async () => {
    await mkdir(`${gateway.tmpDir}/candidate-only-workspace`, { recursive: true })
    const workspace = gateway.gateway.state.createWorkspace(
      `${gateway.tmpDir}/candidate-only-workspace`,
      'Candidate-only profile',
    )
    const profileId = 'portable-candidate-only'
    expect(gateway.gateway.registry.has(profileId)).toBe(false)
    const files = [file('agent.json', JSON.stringify({ name: profileId }))]
    const ownerHeaders = {
      authorization: `Bearer ${gateway.token}`,
      'content-type': 'application/json',
    }
    const validation = await fetch(`${gateway.baseUrl}/api/v1/candidates/validate`, {
      method: 'POST', headers: ownerHeaders, body: JSON.stringify({ files }),
    })
    const candidateId = (await validation.json() as { candidateId: string }).candidateId
    const stage = await fetch(`${gateway.baseUrl}/api/v1/candidates/stage`, {
      method: 'POST', headers: ownerHeaders, body: JSON.stringify({ candidateId, files }),
    })
    expect(stage.status).toBe(200)
    const issued = await gateway.client.post('/api/v1/auth/delegations', {
      delegateId: 'candidate-only-runner',
      workspaceId: workspace.id,
      profileId,
      purpose: 'run-portable-candidate',
      operations: [
        'candidates.validate', 'candidates.stage', 'candidates.activate',
        'profiles.list', 'runs.start', 'runs.snapshot',
      ],
    })
    expect(issued.status).toBe(201)
    const token = (issued.body as { token: string }).token
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const activation = await fetch(`${gateway.baseUrl}/api/v1/candidates/activate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        profileId, candidateId, expectedActiveCandidateId: null,
      }),
    })
    expect(activation.status).toBe(200)

    const catalog = await fetch(`${gateway.baseUrl}/api/v1/profiles`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(catalog.status).toBe(200)
    await expect(catalog.json()).resolves.toEqual([expect.objectContaining({
      id: profileId, activeCandidateId: candidateId, availability: 'available',
    })])
    const run = await fetch(`${gateway.baseUrl}/api/v1/run`, {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': '56565656-5656-4565-8565-565656565656',
      },
      body: JSON.stringify({
        profileId, workspaceId: workspace.id, prompt: 'candidate only run',
      }),
    })
    expect(run.status).toBe(200)
    await expect(run.json()).resolves.toMatchObject({ profileId, candidateId })
    expect(gateway.gateway.registry.has(profileId)).toBe(false)
  })

  it('compare-and-set activation pins each run and rebuilds a cached thread for the next candidate', async () => {
    await mkdir(`${gateway.tmpDir}/activation-workspace`, { recursive: true })
    const workspace = gateway.gateway.state.createWorkspace(
      `${gateway.tmpDir}/activation-workspace`,
      'Candidate activation',
    )
    const issued = await gateway.client.post('/api/v1/auth/delegations', {
      delegateId: 'candidate-activator',
      workspaceId: workspace.id,
      profileId: 'mini',
      purpose: 'activate-portable-agent-kit',
      operations: [
        'candidates.validate',
        'candidates.stage',
        'candidates.activate',
        'candidates.rollback',
        'candidates.read',
        'candidates.list',
        'candidates.delete',
        'profiles.pause',
        'profiles.resume',
        'profiles.deployment.read',
        'profiles.list',
        'runs.start',
        'runs.snapshot',
        'runs.abort',
      ],
    })
    const token = (issued.body as { token: string }).token
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const prepare = async (timeout: string): Promise<string> => {
      const files = [file('agent.json', JSON.stringify({ name: 'mini', execution: { timeout } }))]
      const validated = await fetch(`${gateway.baseUrl}/api/v1/candidates/validate`, {
        method: 'POST', headers, body: JSON.stringify({ files }),
      })
      const candidateId = (await validated.json() as { candidateId: string }).candidateId
      const staged = await fetch(`${gateway.baseUrl}/api/v1/candidates/stage`, {
        method: 'POST', headers, body: JSON.stringify({ candidateId, files }),
      })
      expect(staged.status).toBe(200)
      await expect(staged.json()).resolves.toMatchObject({ state: 'ready' })
      return candidateId
    }
    const activate = async (candidateId: string, expected: string | null) => fetch(
      `${gateway.baseUrl}/api/v1/candidates/activate`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          profileId: 'mini',
          candidateId,
          expectedActiveCandidateId: expected,
        }),
      },
    )
    const firstCandidate = await prepare('10s')
    const secondCandidate = await prepare('20s')
    const unusedCandidate = await prepare('30s')
    const firstActivation = await activate(firstCandidate, null)
    expect(firstActivation.status).toBe(200)
    await expect(firstActivation.json()).resolves.toMatchObject({
      state: 'active', activeCandidateId: firstCandidate, previousCandidateId: null,
    })

    const firstRun = await fetch(`${gateway.baseUrl}/api/v1/run`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': '12121212-1212-4212-8212-121212121212' },
      body: JSON.stringify({ profileId: 'mini', workspaceId: workspace.id, prompt: 'first candidate' }),
    })
    expect(firstRun.status).toBe(200)
    const first = await firstRun.json() as { runId: string; threadId: string; candidateId: string; timeoutMs: number }
    expect(first).toMatchObject({ candidateId: firstCandidate, timeoutMs: 10_000 })

    const secondActivation = await activate(secondCandidate, firstCandidate)
    expect(secondActivation.status).toBe(200)
    await expect(secondActivation.json()).resolves.toMatchObject({
      state: 'active', previousCandidateId: firstCandidate, activeCandidateId: secondCandidate,
    })
    const pinned = await fetch(`${gateway.baseUrl}/api/v1/runs/${first.runId}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(pinned.status).toBe(200)
    await expect(pinned.json()).resolves.toMatchObject({ candidateId: firstCandidate })
    const firstCancellation = await fetch(
      `${gateway.baseUrl}/api/v1/runs/${first.runId}/cancel`,
      { method: 'POST', headers, body: '{}' },
    )
    expect(firstCancellation.status).toBe(202)

    const deadline = Date.now() + 5_000
    while (gateway.gateway.runner.isRunning(first.threadId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(gateway.gateway.runner.isRunning(first.threadId)).toBe(false)
    const secondRun = await fetch(`${gateway.baseUrl}/api/v1/run`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': '34343434-3434-4434-8434-343434343434' },
      body: JSON.stringify({
        profileId: 'mini',
        workspaceId: workspace.id,
        threadId: first.threadId,
        prompt: 'second candidate',
      }),
    })
    expect(secondRun.status).toBe(200)
    const second = await secondRun.json() as {
      runId: string; threadId: string; candidateId: string; timeoutMs: number
    }
    expect(second).toMatchObject({
      candidateId: secondCandidate,
      timeoutMs: 20_000,
    })

    const stale = await activate(firstCandidate, null)
    expect(stale.status).toBe(409)
    await expect(stale.json()).resolves.toMatchObject({
      error: 'candidate_activation_conflict',
      activeCandidateId: secondCandidate,
    })

    const rollback = await fetch(`${gateway.baseUrl}/api/v1/candidates/rollback`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        profileId: 'mini',
        candidateId: firstCandidate,
        expectedActiveCandidateId: secondCandidate,
      }),
    })
    expect(rollback.status).toBe(200)
    await expect(rollback.json()).resolves.toMatchObject({
      state: 'rolled_back',
      changed: true,
      previousCandidateId: secondCandidate,
      activeCandidateId: firstCandidate,
      deploymentRevision: 3,
    })
    const staleRollback = await fetch(`${gateway.baseUrl}/api/v1/candidates/rollback`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        profileId: 'mini',
        candidateId: secondCandidate,
        expectedActiveCandidateId: secondCandidate,
      }),
    })
    expect(staleRollback.status).toBe(409)
    await expect(staleRollback.json()).resolves.toMatchObject({
      error: 'candidate_rollback_conflict',
      activeCandidateId: firstCandidate,
    })

    const missingIdempotency = await fetch(`${gateway.baseUrl}/api/v1/profiles/mini/pause`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ expectedDeploymentRevision: 3 }),
    })
    expect(missingIdempotency.status).toBe(400)
    await expect(missingIdempotency.json()).resolves.toMatchObject({
      error: 'idempotency_key_required',
    })
    const wrongProfilePause = await fetch(`${gateway.baseUrl}/api/v1/profiles/other/pause`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': '67676767-6767-4767-8767-676767676767' },
      body: JSON.stringify({ expectedDeploymentRevision: 3 }),
    })
    expect(wrongProfilePause.status).toBe(403)
    await expect(wrongProfilePause.json()).resolves.toMatchObject({
      error: 'candidate_scope_mismatch',
    })

    const pauseKey = '78787878-7878-4878-8878-787878787878'
    const pause = await fetch(`${gateway.baseUrl}/api/v1/profiles/mini/pause`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': pauseKey },
      body: JSON.stringify({ expectedDeploymentRevision: 3 }),
    })
    expect(pause.status).toBe(200)
    await expect(pause.json()).resolves.toMatchObject({
      state: 'paused', routingState: 'paused', changed: true,
      activeCandidateId: firstCandidate, deploymentRevision: 4,
      activeRunCount: expect.any(Number),
    })

    const replayedPause = await fetch(`${gateway.baseUrl}/api/v1/profiles/mini/pause`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': pauseKey },
      body: JSON.stringify({ expectedDeploymentRevision: 3 }),
    })
    expect(replayedPause.status).toBe(200)
    expect(replayedPause.headers.get('idempotency-replayed')).toBe('true')
    await expect(replayedPause.json()).resolves.toMatchObject({ deploymentRevision: 4 })

    const blocked = await fetch(`${gateway.baseUrl}/api/v1/run`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': '89898989-8989-4898-8898-898989898989' },
      body: JSON.stringify({ profileId: 'mini', workspaceId: workspace.id, prompt: 'must not run' }),
    })
    expect(blocked.status).toBe(409)
    await expect(blocked.json()).resolves.toMatchObject({
      error: 'profile_paused', deploymentRevision: 4,
    })

    const stalePause = await fetch(`${gateway.baseUrl}/api/v1/profiles/mini/pause`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': '90909090-9090-4090-8090-909090909090' },
      body: JSON.stringify({ expectedDeploymentRevision: 3 }),
    })
    expect(stalePause.status).toBe(409)
    await expect(stalePause.json()).resolves.toMatchObject({
      error: 'deployment_conflict', deploymentRevision: 4, routingState: 'paused',
    })

    const resume = await fetch(`${gateway.baseUrl}/api/v1/profiles/mini/resume`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'abababab-abab-4bab-8bab-abababababab' },
      body: JSON.stringify({ expectedDeploymentRevision: 4 }),
    })
    expect(resume.status).toBe(200)
    await expect(resume.json()).resolves.toMatchObject({
      state: 'active', routingState: 'active', changed: true,
      deploymentRevision: 5, health: 'healthy',
    })

    const deployment = await fetch(`${gateway.baseUrl}/api/v1/profiles/mini/deployment`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(deployment.status).toBe(200)
    await expect(deployment.json()).resolves.toMatchObject({
      profileId: 'mini', activeCandidateId: firstCandidate,
      deploymentRevision: 5, routingState: 'active', health: 'healthy',
      activeRunCount: expect.any(Number),
    })
    const publicProfiles = await fetch(`${gateway.baseUrl}/api/v1/profiles`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(publicProfiles.status).toBe(200)
    const publicProfileText = await publicProfiles.text()
    const publicProfileList = JSON.parse(publicProfileText) as Array<Record<string, unknown>>
    expect(publicProfileList).toEqual([expect.objectContaining({
      id: 'mini', availability: 'available', activeCandidateId: firstCandidate,
      deploymentRevision: 5, health: 'healthy',
    })])
    expect(publicProfileText).not.toContain(gateway.tmpDir)
    expect(publicProfileText).not.toContain('soulMd')
    expect(publicProfileText).not.toContain('config')
    const candidates = await fetch(`${gateway.baseUrl}/api/v1/profiles/mini/candidates`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(candidates.status).toBe(200)
    const candidateText = await candidates.text()
    const candidateList = JSON.parse(candidateText) as { items: Array<Record<string, unknown>> }
    expect(candidateList.items).toHaveLength(3)
    expect(candidateText).not.toContain(gateway.tmpDir)
    expect(candidateText).not.toContain('execution')

    const otherFiles = [file('agent.json', '{"name":"other"}')]
    const otherValidation = await fetch(`${gateway.baseUrl}/api/v1/candidates/validate`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gateway.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ files: otherFiles }),
    })
    const otherCandidate = (await otherValidation.json() as { candidateId: string }).candidateId
    const otherStage = await fetch(`${gateway.baseUrl}/api/v1/candidates/stage`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gateway.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ candidateId: otherCandidate, files: otherFiles }),
    })
    expect(otherStage.status).toBe(200)
    const crossProfile = await fetch(
      `${gateway.baseUrl}/api/v1/profile-candidates/${otherCandidate}`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    expect(crossProfile.status).toBe(404)
    await expect(crossProfile.json()).resolves.toMatchObject({ error: 'candidate_not_found' })

    const deleteCandidate = (candidateId: string) => fetch(
      `${gateway.baseUrl}/api/v1/profile-candidates/${candidateId}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
    )
    const activeDelete = await deleteCandidate(firstCandidate)
    expect(activeDelete.status).toBe(409)
    await expect(activeDelete.json()).resolves.toMatchObject({ error: 'candidate_delete_active' })
    const inUseDelete = await deleteCandidate(secondCandidate)
    expect(inUseDelete.status).toBe(409)
    // Two guards legitimately refuse this delete and which fires first is
    // run-latency dependent: while the pinned run is still in flight the
    // gateway answers `candidate_delete_in_use`; once that run terminates
    // (fast on keyless CI runners) the same candidate is still refused as the
    // rollback-retained previous known-good. Either way the contract holds:
    // the candidate cannot be deleted.
    const inUseBody = (await inUseDelete.json()) as { error: string }
    expect(['candidate_delete_in_use', 'candidate_delete_rollback_retained']).toContain(
      inUseBody.error,
    )
    const secondCancellation = await fetch(
      `${gateway.baseUrl}/api/v1/runs/${second.runId}/cancel`,
      { method: 'POST', headers, body: '{}' },
    )
    expect(secondCancellation.status).toBe(202)
    const secondDeadline = Date.now() + 5_000
    while (gateway.gateway.runner.isRunning(second.threadId) && Date.now() < secondDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(gateway.gateway.runner.isRunning(second.threadId)).toBe(false)
    const rollbackDelete = await deleteCandidate(secondCandidate)
    expect(rollbackDelete.status).toBe(409)
    await expect(rollbackDelete.json()).resolves.toMatchObject({
      error: 'candidate_delete_rollback_retained',
    })
    const deleted = await deleteCandidate(unusedCandidate)
    expect(deleted.status).toBe(200)
    await expect(deleted.json()).resolves.toMatchObject({
      state: 'deleted', deleted: true, idempotent: false,
    })
    const replayedDelete = await deleteCandidate(unusedCandidate)
    expect(replayedDelete.status).toBe(200)
    await expect(replayedDelete.json()).resolves.toMatchObject({
      state: 'deleted', deleted: true, idempotent: true,
    })
    const deletedStatus = await fetch(
      `${gateway.baseUrl}/api/v1/profile-candidates/${unusedCandidate}`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    expect(deletedStatus.status).toBe(200)
    await expect(deletedStatus.json()).resolves.toMatchObject({
      candidateId: unusedCandidate, state: 'deleted', ready: false,
      deletionEligible: false,
    })
  }, 15_000)
})
