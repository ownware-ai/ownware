import {
  AccessGrantEvaluator,
  type AccessEvaluationContext,
} from './access-grant-evaluator.js'
import type { AccessConsent } from './access-grant-store.js'
import {
  CSV_DATA_VIEW_SELECTION_IMPLEMENTATION,
  CSV_DATA_VIEW_SELECTION_MAX_FIELDS,
  type CsvDataViewSelectionResult,
} from './csv-data-view-selection.js'
import { csvDataViewOrdinalId } from './csv-data-view.js'
import { SourceByteStore } from './source-byte-store.js'
import {
  SourceDataViewStore,
  type ProtectedSourceDataViewTarget,
  type SourceDataViewManifest,
} from './source-data-view-store.js'

/** Exact row scopes are bounded by the v1 access-grant list ceiling. */
export const PROTECTED_DATA_VIEW_SELECTION_MAX_ROWS = 256 as const

export interface ProtectedDataViewSelectionInput {
  readonly workspaceId: string
  readonly profileId: string
  readonly subjectId: string
  readonly purpose: string
  readonly channel: string | null
  readonly dataViewId: string
  readonly consent: AccessConsent
  readonly permissionMode: AccessEvaluationContext['permissionMode']
  readonly fieldIds: readonly string[]
  readonly rowOffset: number
  readonly rowCount: number
}

export interface ProtectedDataViewSelectionPolicyContext {
  readonly workspaceId: string
  readonly profileId: string
  readonly subjectId: string
  readonly purpose: string
  readonly channel: string | null
  readonly dataViewId: string
  readonly operation: 'source_data_views.query'
  readonly fieldIds: readonly string[]
  readonly rowIds: readonly string[]
  readonly consent: AccessConsent
  readonly autonomy: 'observe'
  readonly permissionMode: AccessEvaluationContext['permissionMode']
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly sourceRevision: number
  readonly classification: SourceDataViewManifest['classification']
  readonly authority: SourceDataViewManifest['authority']
  readonly audiencePolicyRef: string
  readonly sensitivityPolicyRef: string
  readonly purposePolicyRef: string
  readonly retentionPolicyRef: string
  readonly freshnessPolicyRef: string
}

export type ProtectedDataViewSelectionHardFloor = (
  context: ProtectedDataViewSelectionPolicyContext,
) => AccessEvaluationContext['hardFloor']

export interface ProtectedDataViewSelectionResult
  extends Omit<CsvDataViewSelectionResult, 'sourceVersionId'> {
  readonly dataViewId: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly sourceRevision: number
  readonly sourceChecksum: string
  readonly artifactChecksum: string
  readonly freshness: 'current'
  readonly classification: SourceDataViewManifest['classification']
  readonly authority: SourceDataViewManifest['authority']
  readonly observedAt: number
}

export class ProtectedDataViewSelectionError extends Error {
  constructor(readonly code: 'protected_data_view_unavailable') {
    super(code)
    this.name = 'ProtectedDataViewSelectionError'
  }
}

const FIELD_ID = /^field\.[0-9a-f]{32}$/

export class ProtectedDataViewSelectionService {
  constructor(
    private readonly dataViews: SourceDataViewStore,
    private readonly evaluator: AccessGrantEvaluator,
    private readonly bytes: SourceByteStore,
    private readonly evaluateHardFloor: ProtectedDataViewSelectionHardFloor,
    private readonly clock: () => number = Date.now,
  ) {}

  async select(
    input: ProtectedDataViewSelectionInput,
  ): Promise<ProtectedDataViewSelectionResult> {
    const request = snapshotInput(input)
    if (!request || !validRequestShape(request)) throw unavailable()
    const before = this.lookup(request)
    if (!before) throw unavailable()
    const requested = resolveRequestedScope(request, before.manifest)
    if (!requested || !this.isAllowed(request, before.manifest, requested, this.clock())) {
      throw unavailable()
    }

    let selected: CsvDataViewSelectionResult
    try {
      selected = await this.bytes.selectCsvDataViewArtifact({
        privateObjectKey: before.privateObjectKey,
        dataViewId: before.manifest.dataViewId,
        sourceVersionId: before.manifest.sourceVersionId,
        sourceChecksum: before.manifest.sourceChecksum,
        artifactChecksum: before.manifest.artifactChecksum,
        artifactByteCount: before.manifest.artifactByteCount,
        fieldIds: requested.fieldIds,
        rowOffset: requested.rowOffset,
        rowCount: requested.requestedRowCount,
      })
    } catch {
      throw unavailable()
    }

    const after = this.lookup(request)
    const observedAt = this.clock()
    if (!after || !sameTarget(before, after) ||
        !selectionMatches(selected, requested, after.manifest) ||
        !this.isAllowed(request, after.manifest, requested, observedAt)) {
      throw unavailable()
    }

    return Object.freeze({
      dataViewId: after.manifest.dataViewId,
      sourceId: after.manifest.sourceId,
      sourceVersionId: after.manifest.sourceVersionId,
      sourceRevision: after.manifest.sourceRevision,
      sourceChecksum: after.manifest.sourceChecksum,
      artifactChecksum: after.manifest.artifactChecksum,
      freshness: 'current',
      classification: after.manifest.classification,
      authority: after.manifest.authority,
      implementationVersion: selected.implementationVersion,
      rowOffset: selected.rowOffset,
      requestedRowCount: selected.requestedRowCount,
      returnedRowCount: selected.returnedRowCount,
      totalRowCount: selected.totalRowCount,
      complete: selected.complete,
      fields: selected.fields,
      rows: selected.rows,
      observedAt,
    })
  }

  private lookup(input: ProtectedDataViewSelectionInput): ProtectedSourceDataViewTarget | null {
    try {
      return this.dataViews.getProtectedSelectionTargetScoped(
        input.dataViewId, input.workspaceId, input.profileId,
      )
    } catch {
      return null
    }
  }

  private isAllowed(
    input: ProtectedDataViewSelectionInput,
    manifest: SourceDataViewManifest,
    requested: RequestedScope,
    now: number,
  ): boolean {
    let hardFloor: AccessEvaluationContext['hardFloor']
    try {
      hardFloor = this.evaluateHardFloor(policyContext(input, manifest, requested))
    } catch {
      return false
    }
    return this.evaluator.evaluate({
      workspaceId: input.workspaceId,
      profileId: input.profileId,
      subjectId: input.subjectId,
      purpose: input.purpose,
      channel: input.channel,
      resourceKind: 'source_data_view',
      resourceId: input.dataViewId,
      operation: 'source_data_views.query',
      fieldScope: { mode: 'list', ids: requested.fieldIds },
      rowScope: { mode: 'list', ids: requested.rowIds },
      consent: input.consent,
      autonomy: 'observe',
      permissionMode: input.permissionMode,
      hardFloor,
    }, now).decision === 'allow'
  }
}

interface RequestedScope {
  readonly fieldIds: readonly string[]
  readonly rowIds: readonly string[]
  readonly rowOffset: number
  readonly requestedRowCount: number
}

function snapshotInput(
  input: ProtectedDataViewSelectionInput,
): ProtectedDataViewSelectionInput | null {
  if (!input || typeof input !== 'object' || !Array.isArray(input.fieldIds) ||
      !input.consent || typeof input.consent !== 'object') return null
  let consent: AccessConsent
  if (input.consent.state === 'not_required') {
    consent = Object.freeze({ state: 'not_required' })
  } else if (input.consent.state === 'recorded' &&
      typeof input.consent.evidenceId === 'string') {
    consent = Object.freeze({
      state: 'recorded', evidenceId: input.consent.evidenceId,
    })
  } else {
    return null
  }
  return Object.freeze({
    workspaceId: input.workspaceId,
    profileId: input.profileId,
    subjectId: input.subjectId,
    purpose: input.purpose,
    channel: input.channel,
    dataViewId: input.dataViewId,
    consent,
    permissionMode: input.permissionMode,
    fieldIds: Object.freeze([...input.fieldIds]),
    rowOffset: input.rowOffset,
    rowCount: input.rowCount,
  })
}

function validRequestShape(input: ProtectedDataViewSelectionInput): boolean {
  return Array.isArray(input.fieldIds) && input.fieldIds.length >= 1 &&
    input.fieldIds.length <= CSV_DATA_VIEW_SELECTION_MAX_FIELDS &&
    input.fieldIds.every((id) => typeof id === 'string' && FIELD_ID.test(id)) &&
    new Set(input.fieldIds).size === input.fieldIds.length &&
    Number.isSafeInteger(input.rowOffset) && input.rowOffset >= 0 &&
    Number.isSafeInteger(input.rowCount) && input.rowCount >= 1 &&
    input.rowCount <= PROTECTED_DATA_VIEW_SELECTION_MAX_ROWS
}

function resolveRequestedScope(
  input: ProtectedDataViewSelectionInput,
  manifest: SourceDataViewManifest,
): RequestedScope | null {
  const knownFields = new Set(manifest.fields.map((field) => field.fieldId))
  if (input.fieldIds.some((fieldId) => !knownFields.has(fieldId)) ||
      input.rowOffset >= manifest.rowCount) return null
  const rowEnd = Math.min(manifest.rowCount, input.rowOffset + input.rowCount)
  if (!Number.isSafeInteger(rowEnd) || rowEnd <= input.rowOffset) return null
  const rowIds: string[] = []
  for (let ordinal = input.rowOffset; ordinal < rowEnd; ordinal += 1) {
    rowIds.push(csvDataViewOrdinalId('row', manifest.sourceVersionId, ordinal))
  }
  return {
    fieldIds: Object.freeze([...input.fieldIds]),
    rowIds: Object.freeze(rowIds),
    rowOffset: input.rowOffset,
    requestedRowCount: input.rowCount,
  }
}

function policyContext(
  input: ProtectedDataViewSelectionInput,
  manifest: SourceDataViewManifest,
  requested: RequestedScope,
): ProtectedDataViewSelectionPolicyContext {
  return {
    workspaceId: input.workspaceId,
    profileId: input.profileId,
    subjectId: input.subjectId,
    purpose: input.purpose,
    channel: input.channel,
    dataViewId: input.dataViewId,
    operation: 'source_data_views.query',
    fieldIds: requested.fieldIds,
    rowIds: requested.rowIds,
    consent: input.consent,
    autonomy: 'observe',
    permissionMode: input.permissionMode,
    sourceId: manifest.sourceId,
    sourceVersionId: manifest.sourceVersionId,
    sourceRevision: manifest.sourceRevision,
    classification: manifest.classification,
    authority: manifest.authority,
    audiencePolicyRef: manifest.audiencePolicyRef,
    sensitivityPolicyRef: manifest.sensitivityPolicyRef,
    purposePolicyRef: manifest.purposePolicyRef,
    retentionPolicyRef: manifest.retentionPolicyRef,
    freshnessPolicyRef: manifest.freshnessPolicyRef,
  }
}

function sameTarget(
  a: ProtectedSourceDataViewTarget,
  b: ProtectedSourceDataViewTarget,
): boolean {
  const left = a.manifest
  const right = b.manifest
  return a.workspaceId === b.workspaceId && a.profileId === b.profileId &&
    left.dataViewId === right.dataViewId && left.jobId === right.jobId &&
    left.sourceId === right.sourceId && left.sourceVersionId === right.sourceVersionId &&
    left.implementationVersion === right.implementationVersion &&
    left.sourceRevision === right.sourceRevision &&
    left.sourceChecksum === right.sourceChecksum &&
    left.artifactChecksum === right.artifactChecksum &&
    left.artifactByteCount === right.artifactByteCount &&
    left.fieldCount === right.fieldCount && left.rowCount === right.rowCount &&
    sameFields(left.fields, right.fields) &&
    left.classification === right.classification && left.authority === right.authority &&
    left.audiencePolicyRef === right.audiencePolicyRef &&
    left.sensitivityPolicyRef === right.sensitivityPolicyRef &&
    left.purposePolicyRef === right.purposePolicyRef &&
    left.retentionPolicyRef === right.retentionPolicyRef &&
    left.freshnessPolicyRef === right.freshnessPolicyRef &&
    left.freshness === 'current' && right.freshness === 'current' &&
    left.createdAt === right.createdAt && left.staleAt === null && right.staleAt === null &&
    a.privateObjectKey === b.privateObjectKey
}

function selectionMatches(
  selected: CsvDataViewSelectionResult,
  requested: RequestedScope,
  manifest: SourceDataViewManifest,
): boolean {
  if (selected.implementationVersion !== CSV_DATA_VIEW_SELECTION_IMPLEMENTATION ||
      selected.sourceVersionId !== manifest.sourceVersionId ||
      selected.rowOffset !== requested.rowOffset ||
      selected.requestedRowCount !== requested.requestedRowCount ||
      selected.returnedRowCount !== requested.rowIds.length ||
      selected.totalRowCount !== manifest.rowCount ||
      selected.fields.length !== requested.fieldIds.length ||
      selected.rows.length !== requested.rowIds.length ||
      selected.fields.some((field, index) =>
        field.fieldId !== requested.fieldIds[index] ||
        field.ordinal !== manifest.fields.find((item) => item.fieldId === field.fieldId)?.ordinal ||
        field.label !== manifest.fields.find((item) => item.fieldId === field.fieldId)?.label) ||
      selected.rows.some((row, index) =>
        row.rowId !== requested.rowIds[index] || row.ordinal !== requested.rowOffset + index ||
        row.values.length !== requested.fieldIds.length ||
        row.values.some((value) => typeof value !== 'string'))) return false
  const expectedComplete = requested.rowOffset + requested.rowIds.length >= manifest.rowCount
  return selected.complete === expectedComplete
}

function sameFields(
  a: SourceDataViewManifest['fields'],
  b: SourceDataViewManifest['fields'],
): boolean {
  return a.length === b.length && a.every((field, index) => {
    const other = b[index]
    return other !== undefined && field.fieldId === other.fieldId &&
      field.ordinal === other.ordinal && field.label === other.label
  })
}

function unavailable(): ProtectedDataViewSelectionError {
  return new ProtectedDataViewSelectionError('protected_data_view_unavailable')
}
