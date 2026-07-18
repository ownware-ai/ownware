import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { SourceQuotaPolicy } from './source-quota-policy.js'

export const SOURCE_UPLOAD_MAX_BYTES = 16 * 1024 * 1024
export const SOURCE_UPLOAD_MAX_CHUNK_BYTES = 1048576 as const
export const SOURCE_UPLOAD_MAX_CHUNKS = 64 as const
export const SOURCE_UPLOAD_TTL_MS = 15 * 60 * 1000

export interface SourceUploadSession {
  readonly uploadId: string
  readonly sourceId: string
  readonly state: 'open'
  readonly offset: 0
  readonly expectedBytes: number
  readonly expectedChecksum: string
  readonly declaredMediaType: 'text/plain' | 'application/pdf'
  readonly maxChunkBytes: typeof SOURCE_UPLOAD_MAX_CHUNK_BYTES
  readonly maxChunks: typeof SOURCE_UPLOAD_MAX_CHUNKS
  readonly expiresAt: number
  readonly createdAt: number
}

export interface CreateSourceUploadInput {
  readonly sourceId: string
  readonly workspaceId: string
  readonly profileId: string
  readonly principalKey: string
  readonly expectedBytes: number
  readonly expectedChecksum: string
  readonly declaredMediaType: SourceUploadSession['declaredMediaType']
  readonly filename: string
}

export class SourceUploadTargetNotFoundError extends Error {
  constructor() {
    super('Source upload target not found')
    this.name = 'SourceUploadTargetNotFoundError'
  }
}

export class SourceUploadRefreshConflictError extends Error {
  constructor(
    readonly actualRevision: number,
    readonly actualCurrentVersionId: string | null,
  ) {
    super('Source changed after the upload session was created')
    this.name = 'SourceUploadRefreshConflictError'
  }
}

interface SourceUploadRow {
  readonly upload_id: string
  readonly source_id: string
  readonly state: string
  readonly workspace_id: string
  readonly profile_id: string
  readonly principal_key: string
  readonly durable_offset: number
  readonly chunk_count: number
  readonly expected_bytes: number
  readonly expected_checksum: string
  readonly declared_media_type: SourceUploadSession['declaredMediaType']
  readonly max_chunk_bytes: number
  readonly max_chunks: number
  readonly expires_at: number
  readonly created_at: number
  readonly pending_version_id: string | null
  readonly completed_version_id: string | null
  readonly code: string | null
  readonly base_source_revision: number
  readonly base_current_version_id: string | null
}

export interface ScopedSourceUpload {
  readonly uploadId: string
  readonly sourceId: string
  readonly state: 'open' | 'completing' | 'completed' | 'expired' | 'failed'
  readonly offset: number
  readonly chunkCount: number
  readonly expectedBytes: number
  readonly expectedChecksum: string
  readonly declaredMediaType: 'text/plain' | 'application/pdf'
  readonly expiresAt: number
  readonly pendingVersionId: string | null
  readonly completedVersionId: string | null
  readonly baseSourceRevision: number
  readonly baseCurrentVersionId: string | null
  readonly code: string | null
}

export interface CurrentSourceIdentity {
  readonly revision: number
  readonly currentVersionId: string | null
}

export interface SourceUploadChunkRecord {
  readonly startOffset: number
  readonly byteCount: number
  readonly checksum: string
}

export interface SourceUploadCheckpoint {
  readonly uploadId: string
  readonly durableOffset: number
}

export interface SourceVersionManifest {
  readonly sourceVersionId: string
  readonly sourceId: string
  readonly checksum: string
  readonly verifiedMediaType: 'text/plain' | 'application/pdf'
  readonly byteCount: number
  readonly inspection: 'not_started' | 'queued' | 'inspecting' | 'complete' |
    'partial' | 'failed'
  readonly createdAt: number
}

export class SourceUploadStore {
  constructor(
    private readonly db: Database.Database,
    private readonly quota: SourceQuotaPolicy = new SourceQuotaPolicy(db),
  ) {}

  create(input: CreateSourceUploadInput, now: number = Date.now()): SourceUploadSession {
    return this.db.transaction((): SourceUploadSession => {
      const source = this.db.prepare(`
        SELECT revision, current_version_id FROM runtime_sources
        WHERE source_id = ? AND workspace_id = ? AND profile_id = ?
          AND deletion_state = 'active'
      `).get(input.sourceId, input.workspaceId, input.profileId) as {
        revision: number
        current_version_id: string | null
      } | undefined
      if (!source) throw new SourceUploadTargetNotFoundError()
      this.quota.assertCanGrow(input, {
        retainedAndReservedBytes: input.expectedBytes,
        activeUploadSessions: 1,
      })

      const uploadId = randomUUID()
      const expiresAt = now + SOURCE_UPLOAD_TTL_MS
      this.db.prepare(`
        INSERT INTO source_upload_sessions (
          upload_id, source_id, workspace_id, profile_id, principal_key, state,
          expected_bytes, expected_checksum, declared_media_type, filename,
          durable_offset, chunk_count, max_chunk_bytes, max_chunks,
          pending_version_id, completed_version_id, code,
          expires_at, created_at, updated_at,
          base_source_revision, base_current_version_id
        ) VALUES (
          ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, 0, 0, ?, ?, NULL, NULL, NULL,
          ?, ?, ?, ?, ?
        )
      `).run(
        uploadId, input.sourceId, input.workspaceId, input.profileId,
        input.principalKey, input.expectedBytes, input.expectedChecksum,
        input.declaredMediaType, input.filename, SOURCE_UPLOAD_MAX_CHUNK_BYTES,
        SOURCE_UPLOAD_MAX_CHUNKS, expiresAt, now, now,
        source.revision, source.current_version_id,
      )
      const row = this.db.prepare(`
        SELECT * FROM source_upload_sessions WHERE upload_id = ?
      `).get(uploadId) as SourceUploadRow
      if (row.state !== 'open' || row.durable_offset !== 0 ||
          row.max_chunk_bytes !== SOURCE_UPLOAD_MAX_CHUNK_BYTES ||
          row.max_chunks !== SOURCE_UPLOAD_MAX_CHUNKS ||
          row.base_source_revision !== source.revision ||
          row.base_current_version_id !== source.current_version_id) {
        throw new Error('New upload session did not retain its initial limits and source fence')
      }
      return {
        uploadId: row.upload_id,
        sourceId: row.source_id,
        state: 'open',
        offset: 0,
        expectedBytes: row.expected_bytes,
        expectedChecksum: row.expected_checksum,
        declaredMediaType: row.declared_media_type,
        maxChunkBytes: SOURCE_UPLOAD_MAX_CHUNK_BYTES,
        maxChunks: SOURCE_UPLOAD_MAX_CHUNKS,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
      }
    }).immediate()
  }

  listOpenCheckpoints(): readonly SourceUploadCheckpoint[] {
    const rows = this.db.prepare(`
      SELECT upload_id, durable_offset FROM source_upload_sessions
      WHERE state = 'open'
      ORDER BY upload_id
    `).all() as Array<{ upload_id: string; durable_offset: number }>
    return rows.map((row) => ({
      uploadId: row.upload_id,
      durableOffset: row.durable_offset,
    }))
  }

  getScoped(
    uploadId: string,
    workspaceId: string,
    profileId: string,
    principalKey: string,
    now: number = Date.now(),
  ): ScopedSourceUpload | null {
    let row = this.db.prepare(`
      SELECT * FROM source_upload_sessions
      WHERE upload_id = ? AND workspace_id = ? AND profile_id = ? AND principal_key = ?
    `).get(uploadId, workspaceId, profileId, principalKey) as SourceUploadRow | undefined
    if (!row) return null
    if (row.state === 'open' && now > row.expires_at) {
      this.db.prepare(`
        UPDATE source_upload_sessions
        SET state = 'expired', code = 'upload_expired', updated_at = ?
        WHERE upload_id = ? AND state = 'open'
      `).run(now, uploadId)
      row = { ...row, state: 'expired' }
    }
    return {
      uploadId: row.upload_id,
      sourceId: row.source_id,
      state: row.state as ScopedSourceUpload['state'],
      offset: row.durable_offset,
      chunkCount: row.chunk_count,
      expectedBytes: row.expected_bytes,
      expectedChecksum: row.expected_checksum,
      declaredMediaType: row.declared_media_type,
      expiresAt: row.expires_at,
      pendingVersionId: row.pending_version_id,
      completedVersionId: row.completed_version_id,
      baseSourceRevision: row.base_source_revision,
      baseCurrentVersionId: row.base_current_version_id,
      code: row.code,
    }
  }

  getCurrentSourceIdentity(sourceId: string): CurrentSourceIdentity | null {
    const row = this.db.prepare(`
      SELECT revision, current_version_id FROM runtime_sources WHERE source_id = ?
    `).get(sourceId) as {
      revision: number
      current_version_id: string | null
    } | undefined
    return row ? {
      revision: row.revision,
      currentVersionId: row.current_version_id,
    } : null
  }

  findChunk(uploadId: string, startOffset: number): SourceUploadChunkRecord | null {
    const row = this.db.prepare(`
      SELECT start_offset, byte_count, checksum FROM source_upload_chunks
      WHERE upload_id = ? AND start_offset = ?
    `).get(uploadId, startOffset) as {
      start_offset: number; byte_count: number; checksum: string
    } | undefined
    return row ? {
      startOffset: row.start_offset,
      byteCount: row.byte_count,
      checksum: row.checksum,
    } : null
  }

  advanceChunk(
    uploadId: string,
    expectedOffset: number,
    chunk: { readonly byteCount: number; readonly checksum: string },
    now: number = Date.now(),
  ): { readonly offset: number; readonly chunkCount: number } {
    return this.db.transaction((): { readonly offset: number; readonly chunkCount: number } => {
      const row = this.db.prepare(`
        SELECT durable_offset, chunk_count FROM source_upload_sessions
        WHERE upload_id = ? AND state = 'open' AND expires_at >= ?
      `).get(uploadId, now) as { durable_offset: number; chunk_count: number } | undefined
      if (!row || row.durable_offset !== expectedOffset || row.chunk_count >= SOURCE_UPLOAD_MAX_CHUNKS) {
        throw new Error('Upload chunk checkpoint conflict')
      }
      this.db.prepare(`
        INSERT INTO source_upload_chunks (
          upload_id, chunk_index, start_offset, byte_count, checksum, accepted_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(uploadId, row.chunk_count, expectedOffset, chunk.byteCount, chunk.checksum, now)
      const offset = expectedOffset + chunk.byteCount
      this.db.prepare(`
        UPDATE source_upload_sessions
        SET durable_offset = ?, chunk_count = chunk_count + 1, updated_at = ?
        WHERE upload_id = ? AND state = 'open' AND durable_offset = ?
      `).run(offset, now, uploadId, expectedOffset)
      return { offset, chunkCount: row.chunk_count + 1 }
    }).immediate()
  }

  beginCompletion(uploadId: string, now: number = Date.now()): string {
    const versionId = randomUUID()
    const updated = this.db.prepare(`
      UPDATE source_upload_sessions
      SET state = 'completing', pending_version_id = ?, updated_at = ?
      WHERE upload_id = ? AND state = 'open' AND durable_offset = expected_bytes
        AND expires_at >= ?
    `).run(versionId, now, uploadId, now)
    if (updated.changes !== 1) throw new Error('Upload is not ready for completion')
    return versionId
  }

  finishCompletion(
    uploadId: string,
    input: {
      readonly versionId: string
      readonly checksum: string
      readonly verifiedMediaType: 'text/plain' | 'application/pdf'
      readonly byteCount: number
      readonly objectKey: string
    },
    now: number = Date.now(),
  ): SourceVersionManifest {
    return this.db.transaction((): SourceVersionManifest => {
      const session = this.db.prepare(`
        SELECT source_id, pending_version_id, base_source_revision,
          base_current_version_id
        FROM source_upload_sessions
        WHERE upload_id = ? AND state = 'completing'
      `).get(uploadId) as {
        source_id: string
        pending_version_id: string | null
        base_source_revision: number
        base_current_version_id: string | null
      } | undefined
      if (!session || session.pending_version_id !== input.versionId) {
        throw new Error('Upload completion checkpoint conflict')
      }
      this.db.prepare(`
        INSERT OR IGNORE INTO source_versions (
          source_version_id, source_id, checksum, verified_media_type,
          byte_count, object_key, inspection_state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'not_started', ?)
      `).run(
        input.versionId, session.source_id, input.checksum,
        input.verifiedMediaType, input.byteCount, input.objectKey, now,
      )
      const sourceUpdated = this.db.prepare(`
        UPDATE runtime_sources
        SET revision = revision + 1, current_version_id = ?,
          registration_state = 'registered', inspection_state = 'not_started',
          preparation_state = 'not_requested', freshness_state = 'fresh', updated_at = ?
        WHERE source_id = ? AND deletion_state = 'active' AND revision = ?
          AND current_version_id IS ?
      `).run(
        input.versionId,
        now,
        session.source_id,
        session.base_source_revision,
        session.base_current_version_id,
      )
      if (sourceUpdated.changes !== 1) {
        const actual = this.db.prepare(`
          SELECT revision, current_version_id, deletion_state
          FROM runtime_sources WHERE source_id = ?
        `).get(session.source_id) as {
          revision: number
          current_version_id: string | null
          deletion_state: string
        } | undefined
        if (actual?.deletion_state === 'active') {
          throw new SourceUploadRefreshConflictError(
            actual.revision,
            actual.current_version_id,
          )
        }
        throw new Error('Source is not active for completion')
      }
      this.db.prepare(`
        UPDATE source_derived_resources
        SET freshness = 'stale', stale_at = ?
        WHERE source_id = ? AND source_version_id != ? AND freshness = 'current'
      `).run(now, session.source_id, input.versionId)
      const sessionUpdated = this.db.prepare(`
        UPDATE source_upload_sessions
        SET state = 'completed', completed_version_id = ?, code = NULL,
          byte_reservation_released_at = ?, updated_at = ?
        WHERE upload_id = ? AND state = 'completing'
      `).run(input.versionId, now, now, uploadId)
      if (sessionUpdated.changes !== 1) throw new Error('Upload completion state changed')
      return {
        sourceVersionId: input.versionId,
        sourceId: session.source_id,
        checksum: input.checksum,
        verifiedMediaType: input.verifiedMediaType,
        byteCount: input.byteCount,
        inspection: 'not_started',
        createdAt: now,
      }
    }).immediate()
  }

  getCompletedVersion(uploadId: string): SourceVersionManifest | null {
    const row = this.db.prepare(`
      SELECT v.* FROM source_upload_sessions u
      JOIN source_versions v ON v.source_version_id = u.completed_version_id
      WHERE u.upload_id = ? AND u.state = 'completed'
    `).get(uploadId) as {
      source_version_id: string; source_id: string; checksum: string
      verified_media_type: 'text/plain' | 'application/pdf'
      byte_count: number; created_at: number
    } | undefined
    return row ? {
      sourceVersionId: row.source_version_id,
      sourceId: row.source_id,
      checksum: row.checksum,
      verifiedMediaType: row.verified_media_type,
      byteCount: row.byte_count,
      inspection: 'not_started',
      createdAt: row.created_at,
    } : null
  }

  getVersionScoped(
    sourceId: string,
    versionId: string,
    workspaceId: string,
    profileId: string,
  ): SourceVersionManifest | null {
    const row = this.db.prepare(`
      SELECT v.* FROM source_versions v
      JOIN runtime_sources s ON s.source_id = v.source_id
      WHERE v.source_version_id = ? AND v.source_id = ?
        AND s.workspace_id = ? AND s.profile_id = ?
    `).get(versionId, sourceId, workspaceId, profileId) as {
      source_version_id: string; source_id: string; checksum: string
      verified_media_type: 'text/plain' | 'application/pdf'
      byte_count: number
      inspection_state: 'not_started' | 'queued' | 'inspecting' | 'complete' |
        'partial' | 'failed'
      created_at: number
    } | undefined
    return row ? {
      sourceVersionId: row.source_version_id,
      sourceId: row.source_id,
      checksum: row.checksum,
      verifiedMediaType: row.verified_media_type,
      byteCount: row.byte_count,
      inspection: row.inspection_state,
      createdAt: row.created_at,
    } : null
  }

  markFailed(uploadId: string, code: string, now: number = Date.now()): void {
    this.db.prepare(`
      UPDATE source_upload_sessions SET state = 'failed', code = ?, updated_at = ?
      WHERE upload_id = ? AND state IN ('open', 'completing')
    `).run(code, now, uploadId)
  }

  markFailedAfterVerifiedCleanup(
    uploadId: string,
    code: string,
    now: number = Date.now(),
  ): void {
    this.db.prepare(`
      UPDATE source_upload_sessions
      SET state = 'failed', code = ?, byte_reservation_released_at = ?, updated_at = ?
      WHERE upload_id = ? AND state IN ('open', 'completing')
    `).run(code, now, now, uploadId)
  }
}
