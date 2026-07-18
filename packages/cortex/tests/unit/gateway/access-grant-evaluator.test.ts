import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import {
  AccessGrantEvaluator,
  type AccessEvaluationContext,
} from '../../../src/gateway/access-grant-evaluator.js'
import {
  AccessGrantStore,
  type AccessAutonomy,
  type CreateAccessGrantInput,
} from '../../../src/gateway/access-grant-store.js'

let dir: string
let database: CortexDatabase
let grants: AccessGrantStore
let evaluator: AccessGrantEvaluator

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'access-grant-evaluator-'))
  database = new CortexDatabase(join(dir, 'ownware.db'))
  grants = new AccessGrantStore(database.rawMainHandle)
  evaluator = new AccessGrantEvaluator(grants)
})

afterEach(async () => {
  database.close()
  await rm(dir, { recursive: true, force: true })
})

describe('AccessGrantEvaluator', () => {
  it('allows one complete match and returns only safe cache identity', () => {
    const grant = grants.create(grantInput(), 100)
    expect(evaluator.evaluate(context(), 500)).toEqual({
      decision: 'allow',
      code: 'grant_matched',
      evaluatorVersion: 'access_grant.v1',
      grantId: grant.grantId,
      grantRevision: 1,
      expiresAt: 1_000,
    })
  })

  it('collapses every scope, consent, and autonomy mismatch to one safe denial', () => {
    grants.create(grantInput(), 100)
    const mismatches: AccessEvaluationContext[] = [
      { ...context(), workspaceId: 'workspace.other' },
      { ...context(), profileId: 'other' },
      { ...context(), subjectId: 'person.synthetic-2' },
      { ...context(), purpose: 'billing' },
      { ...context(), channel: 'email.primary' },
      { ...context(), resourceKind: 'data_view' },
      { ...context(), resourceId: '22222222-2222-4222-8222-222222222222' },
      { ...context(), operation: 'source_content.search' },
      { ...context(), fieldScope: { mode: 'list', ids: ['field.3'] } },
      { ...context(), rowScope: { mode: 'list', ids: ['row.3'] } },
      { ...context(), consent: { state: 'recorded', evidenceId: 'consent.other' } },
      { ...context(), autonomy: 'act' },
    ]
    for (const mismatch of mismatches) {
      expect(evaluator.evaluate(mismatch, 500)).toEqual({
        decision: 'deny',
        code: 'no_matching_grant',
        evaluatorVersion: 'access_grant.v1',
      })
    }
  })

  it('enforces effective time, expiry, and append-only revocation immediately', () => {
    const grant = grants.create(grantInput(), 100)
    expect(evaluator.evaluate(context(), 99)).toMatchObject({
      decision: 'deny', code: 'no_matching_grant',
    })
    expect(evaluator.evaluate(context(), 100)).toMatchObject({ decision: 'allow' })
    expect(evaluator.evaluate(context(), 1_000)).toMatchObject({
      decision: 'deny', code: 'no_matching_grant',
    })
    expect(evaluator.evaluate(context(), 500)).toMatchObject({ decision: 'allow' })
    grants.revoke({
      grantId: grant.grantId,
      workspaceId: grant.workspaceId,
      profileId: grant.profileId,
      expectedRevision: 1,
    }, 501)
    expect(evaluator.evaluate(context(), 501)).toEqual({
      decision: 'deny',
      code: 'no_matching_grant',
      evaluatorVersion: 'access_grant.v1',
    })
  })

  it('applies hard-floor denial before storage under every permission and autonomy mode', () => {
    for (const permissionMode of ['auto', 'ask', 'deny', 'allowlist'] as const) {
      for (const autonomy of ['observe', 'recommend', 'draft', 'act'] as const) {
        expect(evaluator.evaluate({
          ...context(),
          autonomy,
          permissionMode,
          hardFloor: { decision: 'deny', ruleId: 'safety.no_external_send' },
        }, 500)).toEqual({
          decision: 'deny',
          code: 'hard_floor_denied',
          evaluatorVersion: 'access_grant.v1',
        })
      }
    }
    database.rawMainHandle.exec('DROP TABLE access_grant_revisions')
    for (const permissionMode of ['auto', 'ask', 'deny', 'allowlist'] as const) {
      for (const autonomy of ['observe', 'recommend', 'draft', 'act'] as const) {
        expect(evaluator.evaluate({
          ...context(),
          permissionMode,
          autonomy,
          hardFloor: { decision: 'deny', ruleId: 'safety.storage_unavailable' },
        }, 500)).toMatchObject({
          decision: 'deny', code: 'hard_floor_denied',
        })
      }
    }
  })

  it('prefers a bounded lower-autonomy match deterministically', () => {
    grants.create({
      ...grantInput(),
      fieldScope: { mode: 'all' },
      rowScope: { mode: 'all' },
      autonomyCeiling: 'act',
      expiresAt: 900,
    }, 100)
    const bounded = grants.create(grantInput(), 101)
    expect(evaluator.evaluate(context(), 500)).toMatchObject({
      decision: 'allow',
      grantId: bounded.grantId,
      grantRevision: 1,
    })
  })

  it('fails closed on malformed trusted context without querying grants', () => {
    const invalid = {
      ...context(),
      subjectId: 'person\nother',
    }
    database.rawMainHandle.exec('DROP TABLE access_grant_revisions')
    expect(evaluator.evaluate(invalid, 500)).toEqual({
      decision: 'deny',
      code: 'context_invalid',
      evaluatorVersion: 'access_grant.v1',
    })
  })

  it('rejects ambiguous empty and whole-resource scope requests', () => {
    grants.create(grantInput(), 100)
    expect(evaluator.evaluate({
      ...context(),
      fieldScope: { mode: 'list', ids: [] },
    }, 500)).toMatchObject({ decision: 'deny', code: 'context_invalid' })
    expect(evaluator.evaluate({
      ...context(),
      fieldScope: { mode: 'all' },
    }, 500)).toMatchObject({ decision: 'deny', code: 'no_matching_grant' })
  })

  it('unions positive grants while revoking each identity independently', () => {
    const first = grants.create(grantInput(), 100)
    const second = grants.create(grantInput(), 101)
    grants.revoke({
      grantId: first.grantId,
      workspaceId: first.workspaceId,
      profileId: first.profileId,
      expectedRevision: 1,
    }, 500)
    expect(evaluator.evaluate(context(), 500)).toMatchObject({
      decision: 'allow', grantId: second.grantId,
    })
    grants.revoke({
      grantId: second.grantId,
      workspaceId: second.workspaceId,
      profileId: second.profileId,
      expectedRevision: 1,
    }, 501)
    expect(evaluator.evaluate(context(), 501)).toMatchObject({
      decision: 'deny', code: 'no_matching_grant',
    })
  })

  it('supports explicit whole-resource, nullable-channel, and no-consent fences', () => {
    const autonomyLevels = ['observe', 'recommend', 'draft', 'act'] as const
    for (const autonomyCeiling of autonomyLevels) {
      grants.create({
        ...grantInput(),
        channel: null,
        fieldScope: { mode: 'all' },
        rowScope: { mode: 'all' },
        consent: { state: 'not_required' },
        autonomyCeiling,
      }, 100)
      for (const autonomy of autonomyLevels) {
        const decision = evaluator.evaluate({
          ...context(),
          channel: null,
          fieldScope: { mode: 'all' },
          rowScope: { mode: 'all' },
          consent: { state: 'not_required' },
          autonomy,
        }, 500)
        const expectedAllow = autonomyLevels.indexOf(autonomy) <=
          autonomyLevels.indexOf(autonomyCeiling)
        expect(decision.decision).toBe(expectedAllow ? 'allow' : 'deny')
      }
      const current = grants.findLiveCandidates({
        workspaceId: 'workspace.test',
        profileId: 'assistant',
        subjectId: 'person.synthetic-1',
        purpose: 'customer_support',
        channel: null,
        resourceKind: 'source_resource',
        resourceId: '11111111-1111-4111-8111-111111111111',
        operation: 'source_content.read',
      }, 500).find((grant) => grant.autonomyCeiling === autonomyCeiling)!
      grants.revoke({
        grantId: current.grantId,
        workspaceId: current.workspaceId,
        profileId: current.profileId,
        expectedRevision: 1,
      }, 501)
    }
  })

  it('evaluates a generated cross-scope matrix with exactly one complete match', () => {
    grants.create(grantInput(), 100)
    const dimensions: Array<Array<Partial<AccessEvaluationContext>>> = [
      [{ workspaceId: 'workspace.test' }, { workspaceId: 'workspace.other' }],
      [{ profileId: 'assistant' }, { profileId: 'other' }],
      [{ subjectId: 'person.synthetic-1' }, { subjectId: 'person.synthetic-2' }],
      [{ purpose: 'customer_support' }, { purpose: 'billing' }],
      [{ channel: 'web.primary' }, { channel: null }],
      [{ resourceKind: 'source_resource' }, { resourceKind: 'data_view' }],
      [
        { resourceId: '11111111-1111-4111-8111-111111111111' },
        { resourceId: '22222222-2222-4222-8222-222222222222' },
      ],
      [{ operation: 'source_content.read' }, { operation: 'source_content.search' }],
      [
        { fieldScope: { mode: 'list', ids: ['field.1'] } },
        { fieldScope: { mode: 'list', ids: ['field.3'] } },
      ],
      [
        { rowScope: { mode: 'list', ids: ['row.1'] } },
        { rowScope: { mode: 'list', ids: ['row.3'] } },
      ],
      [
        { consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' } },
        { consent: { state: 'not_required' } },
      ],
      [{ autonomy: 'draft' }, { autonomy: 'act' }],
    ]
    let cases: Array<Partial<AccessEvaluationContext>> = [{}]
    for (const dimension of dimensions) {
      cases = cases.flatMap((current) => dimension.map((entry) => ({
        ...current,
        ...entry,
      })))
    }
    let allowed = 0
    for (const overrides of cases) {
      const decision = evaluator.evaluate({ ...context(), ...overrides }, 500)
      if (decision.decision === 'allow') allowed += 1
      else expect(decision.code).toBe('no_matching_grant')
    }
    expect(cases).toHaveLength(4_096)
    expect(allowed).toBe(1)
  })

  it('fails closed when a persisted current revision is logically corrupt', () => {
    const grant = grants.create(grantInput(), 100)
    database.rawMainHandle.pragma('ignore_check_constraints = ON')
    database.rawMainHandle.prepare(`
      INSERT INTO access_grant_revisions
      SELECT grant_id, 2, workspace_id, profile_id, state, subject_id, purpose,
        channel, resource_kind, resource_id, operation, field_scope_mode,
        field_ids_json, row_scope_mode, row_ids_json, consent_state,
        consent_evidence_id, 'corrupt', effective_at, expires_at, issued_by,
        200, revoked_at
      FROM access_grant_revisions WHERE grant_id = ? AND revision = 1
    `).run(grant.grantId)
    database.rawMainHandle.prepare(`
      UPDATE access_grants SET current_revision = 2 WHERE grant_id = ?
    `).run(grant.grantId)
    database.rawMainHandle.pragma('ignore_check_constraints = OFF')
    expect(evaluator.evaluate(context(), 500)).toEqual({
      decision: 'deny',
      code: 'grant_state_invalid',
      evaluatorVersion: 'access_grant.v1',
    })
  })

  it('fails closed with a safe code when live grant state is unavailable', () => {
    database.rawMainHandle.exec('DROP TABLE access_grant_revisions')
    expect(evaluator.evaluate(context(), 500)).toEqual({
      decision: 'deny',
      code: 'grant_state_invalid',
      evaluatorVersion: 'access_grant.v1',
    })
  })
})

function grantInput(): CreateAccessGrantInput {
  return {
    workspaceId: 'workspace.test',
    profileId: 'assistant',
    subjectId: 'person.synthetic-1',
    purpose: 'customer_support',
    channel: 'web.primary',
    resourceKind: 'source_resource',
    resourceId: '11111111-1111-4111-8111-111111111111',
    operation: 'source_content.read',
    fieldScope: { mode: 'list', ids: ['field.1', 'field.2'] },
    rowScope: { mode: 'list', ids: ['row.1', 'row.2'] },
    consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' },
    autonomyCeiling: 'draft',
    effectiveAt: 100,
    expiresAt: 1_000,
    issuedBy: 'owner.synthetic',
  }
}

function context(autonomy: AccessAutonomy = 'draft'): AccessEvaluationContext {
  return {
    workspaceId: 'workspace.test',
    profileId: 'assistant',
    subjectId: 'person.synthetic-1',
    purpose: 'customer_support',
    channel: 'web.primary',
    resourceKind: 'source_resource',
    resourceId: '11111111-1111-4111-8111-111111111111',
    operation: 'source_content.read',
    fieldScope: { mode: 'list', ids: ['field.1'] },
    rowScope: { mode: 'list', ids: ['row.1'] },
    consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' },
    autonomy,
    permissionMode: 'auto',
    hardFloor: { decision: 'allow' },
  }
}
