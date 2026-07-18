import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import {
  ACCESS_GRANT_MAX_TTL_SECONDS,
  ACCESS_GRANT_MIN_TTL_SECONDS,
  AccessGrantStore,
  AccessGrantStoreError,
  type CreateAccessGrantInput,
  type CreateImmediateAccessGrantInput,
} from '../../../src/gateway/access-grant-store.js'
import { SourceJobStore } from '../../../src/gateway/source-job-store.js'
import { SourceStore } from '../../../src/gateway/source-store.js'

let dir: string
let database: CortexDatabase
let grants: AccessGrantStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'access-grant-store-'))
  database = new CortexDatabase(join(dir, 'ownware.db'))
  grants = new AccessGrantStore(database.rawMainHandle)
})

afterEach(async () => {
  database.close()
  await rm(dir, { recursive: true, force: true })
})

describe('AccessGrantStore', () => {
  it('creates immediate grants at server time within the exported TTL bounds', () => {
    expect(ACCESS_GRANT_MIN_TTL_SECONDS).toBe(60)
    expect(ACCESS_GRANT_MAX_TTL_SECONDS).toBe(30 * 24 * 60 * 60)

    const minimum = grants.createImmediate({
      ...immediateGrantInput(),
      ttlSeconds: ACCESS_GRANT_MIN_TTL_SECONDS,
      effectiveAt: 1,
      expiresAt: 2,
    } as CreateImmediateAccessGrantInput, 10_000)
    expect(minimum).toMatchObject({
      effectiveAt: 10_000,
      expiresAt: 70_000,
      issuedBy: 'owner.synthetic',
      revisionCreatedAt: 10_000,
    })

    const maximum = grants.createImmediate({
      ...immediateGrantInput(),
      ttlSeconds: ACCESS_GRANT_MAX_TTL_SECONDS,
    }, 20_000)
    expect(maximum.expiresAt).toBe(
      20_000 + ACCESS_GRANT_MAX_TTL_SECONDS * 1_000,
    )
  })

  it('rejects TTLs outside the bounds and timestamp overflow without persistence', () => {
    for (const ttlSeconds of [
      ACCESS_GRANT_MIN_TTL_SECONDS - 1,
      ACCESS_GRANT_MAX_TTL_SECONDS + 1,
      ACCESS_GRANT_MIN_TTL_SECONDS + 0.5,
    ]) {
      expect(() => grants.createImmediate({
        ...immediateGrantInput(), ttlSeconds,
      }, 100)).toThrowError(expect.objectContaining({ code: 'access_grant_invalid' }))
    }
    expect(() => grants.createImmediate({
      ...immediateGrantInput(), ttlSeconds: ACCESS_GRANT_MIN_TTL_SECONDS,
    }, Number.MAX_SAFE_INTEGER)).toThrowError(expect.objectContaining({
      code: 'access_grant_invalid',
    }))
    expect(database.rawMainHandle.prepare(
      'SELECT COUNT(*) AS count FROM access_grants',
    ).get()).toEqual({ count: 0 })
  })

  it('creates one canonical immutable positive revision', () => {
    const grant = grants.create({
      ...grantInput(),
      fieldScope: { mode: 'list', ids: ['field.2', 'field.1', 'field.2'] },
    }, 100)
    expect(grant).toMatchObject({
      grantId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      revision: 1,
      state: 'active',
      fieldScope: { mode: 'list', ids: ['field.1', 'field.2'] },
      rowScope: { mode: 'all' },
      revisionCreatedAt: 100,
      revokedAt: null,
    })
    expect(database.rawMainHandle.prepare(`
      SELECT current_revision FROM access_grants WHERE grant_id = ?
    `).get(grant.grantId)).toEqual({ current_revision: 1 })
    expect(database.rawMainHandle.prepare(`
      SELECT field_ids_json, row_ids_json, state
      FROM access_grant_revisions WHERE grant_id = ? AND revision = 1
    `).get(grant.grantId)).toEqual({
      field_ids_json: '["field.1","field.2"]',
      row_ids_json: '[]',
      state: 'active',
    })
  })

  it('revokes by appending a revision and preserves the original fence', () => {
    const created = grants.create(grantInput(), 100)
    const revoked = grants.revoke({
      grantId: created.grantId,
      workspaceId: created.workspaceId,
      profileId: created.profileId,
      expectedRevision: 1,
    }, 200)
    expect(revoked).toMatchObject({
      grantId: created.grantId,
      revision: 2,
      state: 'revoked',
      revokedAt: 200,
      subjectId: created.subjectId,
      resourceId: created.resourceId,
      fieldScope: created.fieldScope,
    })
    expect(database.rawMainHandle.prepare(`
      SELECT revision, state, revoked_at FROM access_grant_revisions
      WHERE grant_id = ? ORDER BY revision
    `).all(created.grantId)).toEqual([
      { revision: 1, state: 'active', revoked_at: null },
      { revision: 2, state: 'revoked', revoked_at: 200 },
    ])
  })

  it('keeps wrong scope absent and rejects stale or repeated revocation', () => {
    const created = grants.create(grantInput(), 100)
    expect(grants.getCurrentScoped(created.grantId, 'workspace.other', 'assistant'))
      .toBeNull()
    expect(() => grants.revoke({
      grantId: created.grantId,
      workspaceId: 'workspace.other',
      profileId: created.profileId,
      expectedRevision: 1,
    }, 200)).toThrowError(expect.objectContaining({ code: 'access_grant_not_found' }))
    grants.revoke({
      grantId: created.grantId,
      workspaceId: created.workspaceId,
      profileId: created.profileId,
      expectedRevision: 1,
    }, 200)
    expect(() => grants.revoke({
      grantId: created.grantId,
      workspaceId: created.workspaceId,
      profileId: created.profileId,
      expectedRevision: 1,
    }, 300)).toThrowError(expect.objectContaining({
      code: 'access_grant_revision_conflict',
    }))
  })

  it('rejects ambiguous, unbounded, unsafe, and invalid-lifetime fences', () => {
    const invalid: CreateAccessGrantInput[] = [
      { ...grantInput(), subjectId: 'person\nother' },
      { ...grantInput(), operation: 'read' },
      { ...grantInput(), fieldScope: { mode: 'list', ids: [] } },
      { ...grantInput(), rowScope: { mode: 'list', ids: Array(257).fill('row.1') } },
      { ...grantInput(), effectiveAt: 1_000, expiresAt: 1_000 },
      {
        ...grantInput(),
        consent: { state: 'recorded', evidenceId: 'invalid evidence' },
      },
    ]
    for (const input of invalid) {
      expect(() => grants.create(input, 100)).toThrow(AccessGrantStoreError)
    }
    expect(database.rawMainHandle.prepare(
      'SELECT COUNT(*) AS count FROM access_grants',
    ).get()).toEqual({ count: 0 })
  })

  it('enforces append-only revisions, monotonic heads, and parent scope in SQLite', () => {
    const created = grants.create(grantInput(), 100)
    expect(() => database.rawMainHandle.prepare(`
      UPDATE access_grant_revisions SET subject_id = 'person.changed'
      WHERE grant_id = ? AND revision = 1
    `).run(created.grantId)).toThrow('access grant revisions are immutable')
    expect(() => database.rawMainHandle.prepare(`
      DELETE FROM access_grant_revisions WHERE grant_id = ? AND revision = 1
    `).run(created.grantId)).toThrow('access grant revisions are immutable')
    expect(() => database.rawMainHandle.prepare(`
      UPDATE access_grants SET current_revision = 2 WHERE grant_id = ?
    `).run(created.grantId)).toThrow('access grant head transition is invalid')
    expect(() => database.rawMainHandle.prepare(`
      INSERT INTO access_grant_revisions
      SELECT grant_id, 2, 'workspace.other', profile_id, state, subject_id,
        purpose, channel, resource_kind, resource_id, operation, field_scope_mode,
        field_ids_json, row_scope_mode, row_ids_json, consent_state,
        consent_evidence_id, autonomy_ceiling, effective_at, expires_at, issued_by,
        200, revoked_at
      FROM access_grant_revisions WHERE grant_id = ? AND revision = 1
    `).run(created.grantId)).toThrow('FOREIGN KEY constraint failed')

    grants.revoke({
      grantId: created.grantId,
      workspaceId: created.workspaceId,
      profileId: created.profileId,
      expectedRevision: 1,
    }, 200)
    expect(() => database.rawMainHandle.prepare(`
      UPDATE access_grants SET current_revision = 1 WHERE grant_id = ?
    `).run(created.grantId)).toThrow('access grant head transition is invalid')
    expect(() => database.rawMainHandle.prepare(`
      DELETE FROM access_grants WHERE grant_id = ?
    `).run(created.grantId)).toThrow('access grant heads are retained')
  })

  it('bounds active grants transactionally and never persists unexpected canaries', () => {
    const bounded = new AccessGrantStore(database.rawMainHandle, 2)
    const first = bounded.create({
      ...grantInput(),
      secret: 'private-secret-canary',
      rawToolInput: 'private-input-canary',
    } as CreateAccessGrantInput, 100)
    bounded.create(grantInput(), 101)
    expect(() => bounded.create(grantInput(), 102)).toThrowError(
      expect.objectContaining({ code: 'access_grant_limit_exceeded' }),
    )
    const persisted = JSON.stringify({
      head: database.rawMainHandle.prepare(
        'SELECT * FROM access_grants WHERE grant_id = ?',
      ).get(first.grantId),
      revision: database.rawMainHandle.prepare(
        'SELECT * FROM access_grant_revisions WHERE grant_id = ?',
      ).get(first.grantId),
    })
    expect(persisted).not.toContain('private-secret-canary')
    expect(persisted).not.toContain('private-input-canary')
  })

  it('releases capacity on expiry or revoke while still reserving future grants', () => {
    const bounded = new AccessGrantStore(database.rawMainHandle, 2)
    const expiring = bounded.create({
      ...grantInput(), effectiveAt: 100, expiresAt: 200,
    }, 100)
    bounded.create({ ...grantInput(), effectiveAt: 500, expiresAt: 1_000 }, 100)
    expect(() => bounded.create(grantInput(), 150)).toThrowError(
      expect.objectContaining({ code: 'access_grant_limit_exceeded' }),
    )
    const afterExpiry = bounded.create(grantInput(), 200)
    bounded.revoke({
      grantId: afterExpiry.grantId,
      workspaceId: afterExpiry.workspaceId,
      profileId: afterExpiry.profileId,
      expectedRevision: 1,
    }, 201)
    expect(() => bounded.create(grantInput(), 201)).not.toThrow()
    expect(grants.getCurrentScoped(
      expiring.grantId, expiring.workspaceId, expiring.profileId,
    )).toMatchObject({ state: 'active', expiresAt: 200 })
  })

  it('gives one stale revoker a conflict without orphaning another revision', () => {
    const created = grants.create(grantInput(), 100)
    const competing = new AccessGrantStore(database.rawMainHandle)
    grants.revoke({
      grantId: created.grantId,
      workspaceId: created.workspaceId,
      profileId: created.profileId,
      expectedRevision: 1,
    }, 200)
    expect(() => competing.revoke({
      grantId: created.grantId,
      workspaceId: created.workspaceId,
      profileId: created.profileId,
      expectedRevision: 1,
    }, 200)).toThrowError(expect.objectContaining({
      code: 'access_grant_revision_conflict',
    }))
    expect(database.rawMainHandle.prepare(`
      SELECT revision, state FROM access_grant_revisions
      WHERE grant_id = ? ORDER BY revision
    `).all(created.grantId)).toEqual([
      { revision: 1, state: 'active' },
      { revision: 2, state: 'revoked' },
    ])
  })

  it('lists current revisions with lifecycle boundaries and includes revoked grants', () => {
    const expired = grants.create({
      ...grantInput(), effectiveAt: 100, expiresAt: 200,
    }, 100)
    const effective = grants.create({
      ...grantInput(), effectiveAt: 150, expiresAt: 300,
    }, 100)
    const scheduled = grants.create({
      ...grantInput(), effectiveAt: 250, expiresAt: 400,
    }, 100)
    const revoked = grants.create({
      ...grantInput(), effectiveAt: 100, expiresAt: 400,
    }, 100)
    grants.revoke({
      grantId: revoked.grantId,
      workspaceId: revoked.workspaceId,
      profileId: revoked.profileId,
      expectedRevision: 1,
    }, 190)

    const page = grants.listCurrentScoped(
      'workspace.test', 'assistant', { limit: 100, cursor: null }, 200,
    )
    expect(page.nextCursor).toBeNull()
    expect(page.items.map(item => ({
      grantId: item.grantId,
      revision: item.revision,
      lifecycle: item.lifecycle,
    }))).toEqual([
      { grantId: expired.grantId, revision: 1, lifecycle: 'expired' },
      { grantId: effective.grantId, revision: 1, lifecycle: 'effective' },
      { grantId: scheduled.grantId, revision: 1, lifecycle: 'scheduled' },
      { grantId: revoked.grantId, revision: 2, lifecycle: 'revoked' },
    ].sort((a, b) => a.grantId.localeCompare(b.grantId)))
  })

  it('paginates by grant ID without duplicates and keeps other scopes absent', () => {
    const expected = Array.from({ length: 5 }, (_, index) => grants.createImmediate({
      ...immediateGrantInput(),
      resourceId: `resource.${index}`,
      ttlSeconds: ACCESS_GRANT_MIN_TTL_SECONDS,
    }, 100 + index).grantId).sort()
    grants.createImmediate({
      ...immediateGrantInput(),
      workspaceId: 'workspace.other',
      ttlSeconds: ACCESS_GRANT_MIN_TTL_SECONDS,
    }, 100)

    const actual: string[] = []
    let cursor: string | null = null
    do {
      const page = grants.listCurrentScoped(
        'workspace.test', 'assistant', { limit: 2, cursor }, 500,
      )
      actual.push(...page.items.map(item => item.grantId))
      cursor = page.nextCursor
    } while (cursor !== null)

    expect(actual).toEqual(expected)
    expect(new Set(actual).size).toBe(expected.length)
    expect(grants.listCurrentScoped(
      'workspace.absent', 'assistant', { limit: 10, cursor: null }, 500,
    )).toEqual({ items: [], nextCursor: null })
    expect(grants.listCurrentScoped(
      'workspace.test', 'profile.absent', { limit: 10, cursor: null }, 500,
    )).toEqual({ items: [], nextCursor: null })
  })

  it('lets only the owner projection derive scope and paginate across current heads', () => {
    const target = seedPreparedTextResource()
    const prepared = grants.getPreparedTextReadTargetForOwner(target.resourceId)
    expect(prepared).toMatchObject({
      workspaceId: 'workspace.test',
      profileId: 'assistant',
      sourceId: target.sourceId,
      resourceId: target.resourceId,
    })
    const created = grants.createPreparedTextReadGrant({
      workspaceId: prepared!.workspaceId,
      profileId: prepared!.profileId,
      subjectId: 'person.synthetic-1',
      purpose: 'customer_support',
      channel: 'web.primary',
      resourceId: prepared!.resourceId,
      consent: { state: 'not_required' },
      ttlSeconds: ACCESS_GRANT_MIN_TTL_SECONDS,
      issuedBy: 'install_owner',
    }, 100)
    grants.createImmediate({
      ...immediateGrantInput(),
      workspaceId: 'workspace.other',
      profileId: 'other',
      ttlSeconds: ACCESS_GRANT_MIN_TTL_SECONDS,
    }, 100)

    expect(grants.getCurrentForOwner(created.grantId)).toEqual(created)
    expect(grants.getSourceIdentityForOwner(created.grantId)).toEqual({
      grantId: created.grantId,
      workspaceId: 'workspace.test',
      profileId: 'assistant',
      sourceId: target.sourceId,
    })
    expect(grants.listCurrentForOwner({ limit: 1, cursor: null }, 100))
      .toMatchObject({ items: [expect.any(Object)], nextCursor: expect.any(String) })
    expect(grants.listCurrentForOwner({ limit: 100, cursor: null }, 100).items)
      .toHaveLength(2)
    expect(grants.getPreparedTextReadTargetForOwner(
      '22222222-2222-4222-8222-222222222222',
    )).toBeNull()
    expect(grants.getCurrentForOwner(
      '22222222-2222-4222-8222-222222222222',
    )).toBeNull()
  })

  it('rejects invalid list limits and cursors', () => {
    for (const limit of [0, 101, 1.5]) {
      expect(() => grants.listCurrentScoped(
        'workspace.test', 'assistant', { limit, cursor: null }, 100,
      )).toThrowError(expect.objectContaining({ code: 'access_grant_invalid' }))
    }
    expect(() => grants.listCurrentScoped(
      'workspace.test', 'assistant', { limit: 10, cursor: 'not-a-uuid' }, 100,
    )).toThrowError(expect.objectContaining({ code: 'access_grant_invalid' }))
  })

  it('fails a current-page read closed when a persisted revision is corrupt', () => {
    const created = grants.create(grantInput(), 100)
    database.rawMainHandle.exec('DROP TRIGGER access_grant_revisions_no_update')
    database.rawMainHandle.prepare(`
      UPDATE access_grant_revisions SET issued_by = 'unsafe issuer'
      WHERE grant_id = ? AND revision = 1
    `).run(created.grantId)

    expect(() => grants.listCurrentScoped(
      created.workspaceId, created.profileId, { limit: 10, cursor: null }, 100,
    )).toThrow('Persisted access grant revision is invalid')
  })

  it('never persists or projects unexpected immediate-creation canaries', () => {
    const created = grants.createImmediate({
      ...immediateGrantInput(),
      ttlSeconds: ACCESS_GRANT_MIN_TTL_SECONDS,
      secret: 'immediate-secret-canary',
      rawToolInput: 'immediate-input-canary',
    } as CreateImmediateAccessGrantInput, 100)
    const page = grants.listCurrentScoped(
      created.workspaceId, created.profileId, { limit: 10, cursor: null }, 100,
    )
    const serialized = JSON.stringify({
      page,
      head: database.rawMainHandle.prepare(
        'SELECT * FROM access_grants WHERE grant_id = ?',
      ).get(created.grantId),
      revision: database.rawMainHandle.prepare(
        'SELECT * FROM access_grant_revisions WHERE grant_id = ?',
      ).get(created.grantId),
    })
    expect(serialized).not.toContain('immediate-secret-canary')
    expect(serialized).not.toContain('immediate-input-canary')
  })

  it('atomically creates only the fixed read fence for one usable prepared text resource', () => {
    const target = seedPreparedTextResource()

    const created = grants.createPreparedTextReadGrant({
      workspaceId: 'workspace.test',
      profileId: 'assistant',
      subjectId: 'person.synthetic-1',
      purpose: 'customer_support',
      channel: 'web.primary',
      resourceId: target.resourceId,
      consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' },
      ttlSeconds: ACCESS_GRANT_MIN_TTL_SECONDS,
      issuedBy: 'owner.synthetic',
      secret: 'prepared-grant-secret-canary',
      rawConsent: 'prepared-grant-consent-canary',
    } as Parameters<AccessGrantStore['createPreparedTextReadGrant']>[0], 100)

    expect(created).toMatchObject({
      workspaceId: 'workspace.test',
      profileId: 'assistant',
      resourceKind: 'source_resource',
      resourceId: target.resourceId,
      operation: 'source_content.read',
      fieldScope: { mode: 'all' },
      rowScope: { mode: 'all' },
      autonomyCeiling: 'observe',
      effectiveAt: 100,
      expiresAt: 60_100,
      issuedBy: 'owner.synthetic',
    })
    const persisted = JSON.stringify(database.rawMainHandle.prepare(`
      SELECT * FROM access_grant_revisions WHERE grant_id = ?
    `).get(created.grantId))
    expect(persisted).not.toContain('prepared-grant-secret-canary')
    expect(persisted).not.toContain('prepared-grant-consent-canary')
  })

  it('creates search as a separate prepared-text operation without widening read', () => {
    const target = seedPreparedTextResource()
    const common = {
      workspaceId: 'workspace.test',
      profileId: 'assistant',
      subjectId: 'person.synthetic-1',
      purpose: 'customer_support',
      channel: 'web.primary',
      resourceId: target.resourceId,
      consent: { state: 'not_required' } as const,
      ttlSeconds: ACCESS_GRANT_MIN_TTL_SECONDS,
      issuedBy: 'owner.synthetic',
    }
    const read = grants.createPreparedTextReadGrant(common, 100)
    const search = grants.createPreparedTextAccessGrant({
      ...common,
      operation: 'source_content.search',
    }, 100)

    expect(read.operation).toBe('source_content.read')
    expect(search.operation).toBe('source_content.search')
    expect(search).toMatchObject({
      resourceKind: 'source_resource',
      fieldScope: { mode: 'all' },
      rowScope: { mode: 'all' },
      autonomyCeiling: 'observe',
    })
    expect(grants.getSourceIdentityForOwner(search.grantId)).toMatchObject({
      sourceId: target.sourceId,
    })
  })

  it('keeps wrong-scope, refreshed, and deletion-fenced resources equally unavailable', () => {
    const target = seedPreparedTextResource()
    const input = {
      workspaceId: 'workspace.test',
      profileId: 'assistant',
      subjectId: 'person.synthetic-1',
      purpose: 'customer_support',
      channel: 'web.primary',
      resourceId: target.resourceId,
      consent: { state: 'not_required' } as const,
      ttlSeconds: ACCESS_GRANT_MIN_TTL_SECONDS,
      issuedBy: 'owner.synthetic',
    }

    for (const unavailable of [
      { ...input, workspaceId: 'workspace.other' },
      { ...input, profileId: 'other' },
      { ...input, resourceId: '22222222-2222-4222-8222-222222222222' },
    ]) {
      expect(() => grants.createPreparedTextReadGrant(unavailable, 100))
        .toThrowError(expect.objectContaining({
          code: 'access_grant_resource_unavailable',
        }))
    }

    database.rawMainHandle.prepare(`
      UPDATE source_derived_resources SET freshness = 'stale', stale_at = 101
      WHERE resource_id = ?
    `).run(target.resourceId)
    expect(() => grants.createPreparedTextReadGrant(input, 101)).toThrowError(
      expect.objectContaining({ code: 'access_grant_resource_unavailable' }),
    )
    database.rawMainHandle.prepare(`
      UPDATE source_derived_resources SET freshness = 'current', stale_at = NULL
      WHERE resource_id = ?
    `).run(target.resourceId)

    database.rawMainHandle.prepare(`
      UPDATE runtime_sources SET deletion_state = 'frozen', revision = revision + 1
      WHERE source_id = ?
    `).run(target.sourceId)
    expect(() => grants.createPreparedTextReadGrant(input, 102)).toThrowError(
      expect.objectContaining({ code: 'access_grant_resource_unavailable' }),
    )

    expect(database.rawMainHandle.prepare(
      'SELECT COUNT(*) AS count FROM access_grants',
    ).get()).toEqual({ count: 0 })
  })

  it.each([
    [
      'source preparation is not ready',
      "UPDATE runtime_sources SET preparation_state = 'failed' WHERE source_id = ?",
    ],
    [
      'the immutable version is not strict text',
      "UPDATE source_versions SET verified_media_type = 'application/pdf' WHERE source_id = ?",
    ],
    [
      'the preparation job did not succeed',
      "UPDATE source_jobs SET state = 'failed', outcome_code = 'preparation_failed' " +
        "WHERE source_id = ? AND operation = 'extract_text'",
    ],
    [
      'the resource checksum no longer matches its version',
      `UPDATE source_derived_resources SET resource_checksum = 'sha256:${'b'.repeat(64)}'
       WHERE source_id = ?`,
    ],
    [
      'the resource version is no longer current',
      'UPDATE runtime_sources SET current_version_id = NULL WHERE source_id = ?',
    ],
  ])('rejects a prepared resource when %s', (_label, mutation) => {
    const target = seedPreparedTextResource()
    database.rawMainHandle.prepare(mutation).run(target.sourceId)

    expect(() => grants.createPreparedTextReadGrant({
      workspaceId: 'workspace.test',
      profileId: 'assistant',
      subjectId: 'person.synthetic-1',
      purpose: 'customer_support',
      channel: 'web.primary',
      resourceId: target.resourceId,
      consent: { state: 'not_required' },
      ttlSeconds: ACCESS_GRANT_MIN_TTL_SECONDS,
      issuedBy: 'owner.synthetic',
    }, 100)).toThrowError(expect.objectContaining({
      code: 'access_grant_resource_unavailable',
    }))
    expect(database.rawMainHandle.prepare(
      'SELECT COUNT(*) AS count FROM access_grants',
    ).get()).toEqual({ count: 0 })
  })

  it('rolls back source-specific creation when grant insertion fails', () => {
    const target = seedPreparedTextResource()
    const bounded = new AccessGrantStore(database.rawMainHandle, 1)
    bounded.createImmediate({
      ...immediateGrantInput(),
      ttlSeconds: ACCESS_GRANT_MIN_TTL_SECONDS,
    }, 100)

    expect(() => bounded.createPreparedTextReadGrant({
      workspaceId: 'workspace.test',
      profileId: 'assistant',
      subjectId: 'person.synthetic-1',
      purpose: 'customer_support',
      channel: 'web.primary',
      resourceId: target.resourceId,
      consent: { state: 'not_required' },
      ttlSeconds: ACCESS_GRANT_MIN_TTL_SECONDS,
      issuedBy: 'owner.synthetic',
    }, 101)).toThrowError(expect.objectContaining({
      code: 'access_grant_limit_exceeded',
    }))
    expect(database.rawMainHandle.prepare(
      'SELECT COUNT(*) AS count FROM access_grants',
    ).get()).toEqual({ count: 1 })
  })

  function seedPreparedTextResource(): {
    readonly sourceId: string
    readonly resourceId: string
  } {
    const source = new SourceStore(database.rawMainHandle).create({
      workspaceId: 'workspace.test',
      profileId: 'assistant',
      kind: 'file',
      label: 'Synthetic source',
      classification: 'internal',
      authority: 'supporting_reference',
      audiencePolicyRef: 'audience.test',
      sensitivityPolicyRef: 'sensitivity.test',
      purposePolicyRef: 'purpose.test',
      retentionPolicyRef: 'retention.test',
      freshnessPolicyRef: 'freshness.test',
    }, 10)
    const versionId = '11111111-1111-4111-8111-111111111111'
    database.rawMainHandle.prepare(`
      INSERT INTO source_versions (
        source_version_id, source_id, checksum, verified_media_type,
        byte_count, object_key, inspection_state, created_at
      ) VALUES (?, ?, ?, 'text/plain', 4, ?, 'complete', 20)
    `).run(
      versionId,
      source.sourceId,
      `sha256:${'a'.repeat(64)}`,
      `sources/${source.sourceId}/versions/${versionId}/original`,
    )
    database.rawMainHandle.prepare(`
      UPDATE runtime_sources SET registration_state = 'registered',
        current_version_id = ?, inspection_state = 'complete',
        freshness_state = 'fresh', updated_at = 20
      WHERE source_id = ?
    `).run(versionId, source.sourceId)

    const jobs = new SourceJobStore(database.rawMainHandle)
    const job = jobs.enqueuePreparation({
      workspaceId: 'workspace.test',
      profileId: 'assistant',
      sourceId: source.sourceId,
      sourceVersionId: versionId,
    }, 30)
    const claim = jobs.claimNext('grant-test-worker', 40)!
    for (const checkpoint of [1, 2, 3]) {
      expect(jobs.advanceCheckpoint(
        job.jobId, claim.claimToken, checkpoint - 1, checkpoint, 40 + checkpoint,
      )).toBe('advanced')
    }
    expect(jobs.finishPreparation(
      job.jobId, claim.claimToken, 'succeeded', 'preparation_complete', 50,
    )).toBe('finished')
    return { sourceId: source.sourceId, resourceId: claim.resourceId! }
  }
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
    fieldScope: { mode: 'all' },
    rowScope: { mode: 'all' },
    consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' },
    autonomyCeiling: 'draft',
    effectiveAt: 100,
    expiresAt: 1_000,
    issuedBy: 'owner.synthetic',
  }
}

function immediateGrantInput(): Omit<CreateImmediateAccessGrantInput, 'ttlSeconds'> {
  const { effectiveAt: _effectiveAt, expiresAt: _expiresAt, ...input } = grantInput()
  return input
}
