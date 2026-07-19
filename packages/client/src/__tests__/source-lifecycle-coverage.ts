import type { OwnwareClient } from '../client.js'

export const PCC04_PUBLIC_PROOFS = {
  'client.source-capability-negotiation': {
    proofFile: 'packages/client/src/__tests__/client.test.ts',
    proofTitle: 'capabilities() returns typed available, unavailable and incompatible states before mutation',
  },
  'client.subject-bound-delegation': {
    proofFile: 'packages/client/src/__tests__/client.test.ts',
    proofTitle: 'issues and revokes a delegation through the published owner SDK',
  },
  'client.text-and-data-view-lifecycle': {
    proofFile: 'packages/client/src/__tests__/integration.test.ts',
    proofTitle: 'prepares a strict CSV Data View through only the public SDK contract',
  },
  'contract.source-registration': {
    proofFile: 'packages/cortex/tests/framework/contracts/source-registration.contract.ts',
    proofTitle: 'lists and reads safe manifests through bounded scoped routes',
  },
  'client.text-and-data-view-deletion': {
    proofFile: 'packages/client/src/__tests__/integration.test.ts',
    proofTitle: 'prepares a strict CSV Data View through only the public SDK contract',
  },
  'contract.source-deletion-cancel': {
    proofFile: 'packages/cortex/tests/framework/contracts/source-deletions.contract.ts',
    proofTitle: 'creates, exactly replays, reads, and safely cancels before destruction',
  },
  'contract.source-deletion-partial-retry': {
    proofFile: 'packages/cortex/tests/framework/contracts/source-deletions.contract.ts',
    proofTitle: 'keeps partial deletion frozen, rejects cancellation, and retries only failed inventory',
  },
  'client.text-and-data-view-upload': {
    proofFile: 'packages/client/src/__tests__/integration.test.ts',
    proofTitle: 'prepares a strict CSV Data View through only the public SDK contract',
  },
  'client.text-and-data-view-version': {
    proofFile: 'packages/client/src/__tests__/integration.test.ts',
    proofTitle: 'prepares a strict CSV Data View through only the public SDK contract',
  },
  'client.text-and-data-view-preparation': {
    proofFile: 'packages/client/src/__tests__/integration.test.ts',
    proofTitle: 'prepares a strict CSV Data View through only the public SDK contract',
  },
  'client.text-and-data-view-inspection': {
    proofFile: 'packages/client/src/__tests__/integration.test.ts',
    proofTitle: 'prepares a strict CSV Data View through only the public SDK contract',
  },
  'client.text-lifecycle': {
    proofFile: 'packages/client/src/__tests__/source-search-lifecycle.test.ts',
    proofTitle: 'negotiates, repeats, revokes, refreshes, regrants and deletes without stale evidence',
  },
  'client.data-view-lifecycle': {
    proofFile: 'packages/client/src/__tests__/integration.test.ts',
    proofTitle: 'prepares a strict CSV Data View through only the public SDK contract',
  },
  'client.text-grant-inspection': {
    proofFile: 'packages/client/src/__tests__/integration.test.ts',
    proofTitle: 'a delegated client registers and reads one safe source manifest',
  },
  'client.text-and-data-view-jobs': {
    proofFile: 'packages/client/src/__tests__/integration.test.ts',
    proofTitle: 'prepares a strict CSV Data View through only the public SDK contract',
  },
  'contract.source-job-cancel': {
    proofFile: 'packages/cortex/tests/framework/contracts/source-jobs.contract.ts',
    proofTitle: 'creates, replays, reads, and truthfully cancels one in-flight job',
  },
} as const

export interface Pcc04PublicOperationOwner {
  readonly operationId: string
  readonly capabilityId: string
  readonly capabilityVersion: number
  readonly sdkMethod: keyof OwnwareClient
  readonly journey: 'prerequisite' | 'shared' | 'text' | 'data_view'
  readonly proofId: keyof typeof PCC04_PUBLIC_PROOFS
}

/**
 * Executable ownership map for every published PCC-04 HTTP operation plus the
 * capability/delegation prerequisites used by the two release journeys.
 */
export const PCC04_PUBLIC_OPERATIONS: readonly Pcc04PublicOperationOwner[] = [
  { operationId: 'capabilities', capabilityId: 'gateway.capabilities', capabilityVersion: 10, sdkMethod: 'capabilities', journey: 'prerequisite', proofId: 'client.source-capability-negotiation' },
  { operationId: 'issueDelegation', capabilityId: 'principals.issue', capabilityVersion: 3, sdkMethod: 'issueDelegation', journey: 'prerequisite', proofId: 'client.subject-bound-delegation' },
  { operationId: 'registerSource', capabilityId: 'sources.register', capabilityVersion: 2, sdkMethod: 'registerSource', journey: 'shared', proofId: 'client.text-and-data-view-lifecycle' },
  { operationId: 'listSources', capabilityId: 'sources.list', capabilityVersion: 1, sdkMethod: 'sources', journey: 'shared', proofId: 'contract.source-registration' },
  { operationId: 'getSource', capabilityId: 'sources.read', capabilityVersion: 1, sdkMethod: 'source', journey: 'shared', proofId: 'client.text-and-data-view-lifecycle' },
  { operationId: 'createSourceDeletion', capabilityId: 'source_deletions.create', capabilityVersion: 1, sdkMethod: 'createSourceDeletion', journey: 'shared', proofId: 'client.text-and-data-view-deletion' },
  { operationId: 'getSourceDeletion', capabilityId: 'source_deletions.read', capabilityVersion: 1, sdkMethod: 'sourceDeletion', journey: 'shared', proofId: 'client.text-and-data-view-deletion' },
  { operationId: 'cancelSourceDeletion', capabilityId: 'source_deletions.cancel', capabilityVersion: 1, sdkMethod: 'cancelSourceDeletion', journey: 'shared', proofId: 'contract.source-deletion-cancel' },
  { operationId: 'retrySourceDeletion', capabilityId: 'source_deletions.retry', capabilityVersion: 1, sdkMethod: 'retrySourceDeletion', journey: 'shared', proofId: 'contract.source-deletion-partial-retry' },
  { operationId: 'createSourceUploadSession', capabilityId: 'source_uploads.create', capabilityVersion: 3, sdkMethod: 'createSourceUploadSession', journey: 'shared', proofId: 'client.text-and-data-view-upload' },
  { operationId: 'writeSourceUploadChunk', capabilityId: 'source_uploads.write', capabilityVersion: 1, sdkMethod: 'writeSourceUploadChunk', journey: 'shared', proofId: 'client.text-and-data-view-upload' },
  { operationId: 'completeSourceUpload', capabilityId: 'source_uploads.complete', capabilityVersion: 2, sdkMethod: 'completeSourceUpload', journey: 'shared', proofId: 'client.text-and-data-view-upload' },
  { operationId: 'getSourceVersion', capabilityId: 'source_versions.read', capabilityVersion: 1, sdkMethod: 'sourceVersion', journey: 'shared', proofId: 'client.text-and-data-view-version' },
  { operationId: 'createSourcePreparation', capabilityId: 'source_preparations.create', capabilityVersion: 3, sdkMethod: 'createSourcePreparation', journey: 'shared', proofId: 'client.text-and-data-view-preparation' },
  { operationId: 'createSourceJob', capabilityId: 'source_jobs.create', capabilityVersion: 2, sdkMethod: 'createSourceJob', journey: 'shared', proofId: 'client.text-and-data-view-inspection' },
  { operationId: 'getSourceResource', capabilityId: 'source_resources.read', capabilityVersion: 1, sdkMethod: 'sourceResource', journey: 'text', proofId: 'client.text-lifecycle' },
  { operationId: 'getSourceDataView', capabilityId: 'source_data_views.read', capabilityVersion: 1, sdkMethod: 'sourceDataView', journey: 'data_view', proofId: 'client.data-view-lifecycle' },
  { operationId: 'createDataViewQueryGrant', capabilityId: 'access_grants.create', capabilityVersion: 3, sdkMethod: 'createDataViewQueryGrant', journey: 'data_view', proofId: 'client.data-view-lifecycle' },
  { operationId: 'querySourceDataView', capabilityId: 'source_data_views.query', capabilityVersion: 1, sdkMethod: 'querySourceDataView', journey: 'data_view', proofId: 'client.data-view-lifecycle' },
  { operationId: 'createAccessGrant', capabilityId: 'access_grants.create', capabilityVersion: 3, sdkMethod: 'createAccessGrant', journey: 'text', proofId: 'client.text-lifecycle' },
  { operationId: 'readSourceContent', capabilityId: 'source_content.read', capabilityVersion: 2, sdkMethod: 'readSourceContent', journey: 'text', proofId: 'client.text-lifecycle' },
  { operationId: 'searchSourceContent', capabilityId: 'source_content.search', capabilityVersion: 2, sdkMethod: 'searchSourceContent', journey: 'text', proofId: 'client.text-lifecycle' },
  { operationId: 'listAccessGrants', capabilityId: 'access_grants.list', capabilityVersion: 1, sdkMethod: 'accessGrants', journey: 'text', proofId: 'client.text-grant-inspection' },
  { operationId: 'getAccessGrant', capabilityId: 'access_grants.read', capabilityVersion: 1, sdkMethod: 'accessGrant', journey: 'text', proofId: 'client.text-grant-inspection' },
  { operationId: 'revokeAccessGrant', capabilityId: 'access_grants.revoke', capabilityVersion: 1, sdkMethod: 'revokeAccessGrant', journey: 'text', proofId: 'client.text-lifecycle' },
  { operationId: 'getSourceJob', capabilityId: 'source_jobs.read', capabilityVersion: 3, sdkMethod: 'sourceJob', journey: 'shared', proofId: 'client.text-and-data-view-jobs' },
  { operationId: 'cancelSourceJob', capabilityId: 'source_jobs.cancel', capabilityVersion: 2, sdkMethod: 'cancelSourceJob', journey: 'shared', proofId: 'contract.source-job-cancel' },
] as const

export interface Pcc04UnhappyStateOwner {
  readonly stateId: string
  readonly seam: 'public' | 'restart_harness' | 'fault_injection'
  readonly proofFile: string
  readonly proofTitle: string
  readonly reasonNotPublic?: string
}

/** Faults that cannot be safely manufactured through public mutation say why. */
export const PCC04_UNHAPPY_STATES: readonly Pcc04UnhappyStateOwner[] = [
  { stateId: 'capability_incompatible_or_unavailable', seam: 'public', proofFile: 'packages/client/src/__tests__/client.test.ts', proofTitle: 'capabilities() returns typed available, unavailable and incompatible states before mutation' },
  { stateId: 'wrong_workspace_profile_or_subject', seam: 'public', proofFile: 'packages/client/src/__tests__/source-search-lifecycle.test.ts', proofTitle: 'negotiates, repeats, revokes, refreshes, regrants and deletes without stale evidence' },
  { stateId: 'malformed_source_input', seam: 'public', proofFile: 'packages/cortex/tests/framework/contracts/source-upload-sessions.contract.ts', proofTitle: 'rejects unsafe declarations without reflecting private input' },
  { stateId: 'over_limit_source_input', seam: 'public', proofFile: 'packages/cortex/tests/framework/contracts/source-upload-sessions.contract.ts', proofTitle: 'fails closed for expiry, oversized/checksum-invalid chunks, races, and checkpoint failure' },
  { stateId: 'source_registration_quota_refusal', seam: 'public', proofFile: 'packages/cortex/tests/framework/contracts/source-quotas.contract.ts', proofTitle: 'rejects registration growth safely without poisoning the retry key' },
  { stateId: 'source_upload_reservation_quota', seam: 'public', proofFile: 'packages/cortex/tests/framework/contracts/source-quotas.contract.ts', proofTitle: 'counts active upload bytes as reservations before any chunk is written' },
  { stateId: 'source_job_quota_refusal', seam: 'fault_injection', proofFile: 'packages/cortex/tests/unit/gateway/source-job-store.test.ts', proofTitle: 'reserves nonterminal job capacity and releases it only at terminal state', reasonNotPublic: 'The test injects smaller deterministic quota ceilings than the published installation limits.' },
  { stateId: 'text_derived_resource_quota_refusal', seam: 'fault_injection', proofFile: 'packages/cortex/tests/unit/gateway/source-job-store.test.ts', proofTitle: 'reserves one derived-resource slot when preparation is enqueued', reasonNotPublic: 'The test injects smaller deterministic quota ceilings than the published installation limits.' },
  { stateId: 'data_view_derived_resource_quota_refusal', seam: 'fault_injection', proofFile: 'packages/cortex/tests/unit/gateway/source-data-view-store.test.ts', proofTitle: 'fails closed for an ineligible target and transactional quota refusal', reasonNotPublic: 'The test injects smaller deterministic quota ceilings than the published installation limits.' },
  { stateId: 'stale_refresh_conflict_and_cleanup', seam: 'public', proofFile: 'packages/client/src/__tests__/integration.test.ts', proofTitle: 'a delegated client registers and reads one safe source manifest' },
  { stateId: 'source_job_cancel_requested', seam: 'public', proofFile: 'packages/cortex/tests/framework/contracts/source-jobs.contract.ts', proofTitle: 'creates, replays, reads, and truthfully cancels one in-flight job' },
  { stateId: 'grant_revoke_and_post_revoke_denial', seam: 'public', proofFile: 'packages/client/src/__tests__/source-search-lifecycle.test.ts', proofTitle: 'negotiates, repeats, revokes, refreshes, regrants and deletes without stale evidence' },
  { stateId: 'data_view_revoke_or_expiry', seam: 'fault_injection', proofFile: 'packages/cortex/tests/unit/gateway/protected-data-view-selection.test.ts', proofTitle: 'withholds buffered cells after grant revoke or expiry', reasonNotPublic: 'The race and exact expiry boundary require deterministic hooks and a controlled clock.' },
  { stateId: 'data_view_refresh_delete_or_substitution', seam: 'fault_injection', proofFile: 'packages/cortex/tests/unit/gateway/protected-data-view-selection.test.ts', proofTitle: 'withholds buffered cells after refresh, deletion, or target substitution', reasonNotPublic: 'The test changes trusted lineage between the two mandatory authorization proofs.' },
  { stateId: 'data_view_artifact_tamper_or_selector_failure', seam: 'fault_injection', proofFile: 'packages/cortex/tests/unit/gateway/protected-data-view-selection.test.ts', proofTitle: 'collapses artifact tamper and selector failures to unavailable without cells', reasonNotPublic: 'Private artifact tampering is deliberately not a public mutation surface.' },
  { stateId: 'data_view_selection_timeout', seam: 'fault_injection', proofFile: 'packages/cortex/tests/unit/gateway/source-byte-store-data-view.test.ts', proofTitle: 'applies one deadline across artifact verification and projection', reasonNotPublic: 'A deterministic storage deadline must be injected without a real slow disk.' },
  { stateId: 'data_view_malformed_orphan_cleanup', seam: 'fault_injection', proofFile: 'packages/cortex/tests/unit/gateway/source-data-view-worker.test.ts', proofTitle: 'fails malformed CSV with a closed code and publishes no artifact', reasonNotPublic: 'The worker seam proves private artifact cleanup without exposing placement as a public control.' },
  { stateId: 'cache_authority_and_lineage_binding', seam: 'fault_injection', proofFile: 'packages/cortex/tests/unit/gateway/evidence-search-cache.test.ts', proofTitle: 'binds every authority, lineage, policy, consent and parameter dimension', reasonNotPublic: 'Cache keys and retained candidates are runtime-private implementation details.' },
  { stateId: 'cache_expiry_boundary', seam: 'fault_injection', proofFile: 'packages/cortex/tests/unit/gateway/evidence-search-cache.test.ts', proofTitle: 'expires exclusively at the earlier grant or cache deadline without sliding', reasonNotPublic: 'The exact expiry boundary requires a deterministic clock.' },
  { stateId: 'cache_grant_revoke_invalidation', seam: 'fault_injection', proofFile: 'packages/cortex/tests/unit/gateway/evidence-search-cache-lifecycle.test.ts', proofTitle: 'invalidates only the exact scoped grant immediately after revocation', reasonNotPublic: 'Cache membership is runtime-private and must be inspected at its narrow invalidation seam.' },
  { stateId: 'cache_source_refresh_invalidation', seam: 'fault_injection', proofFile: 'packages/cortex/tests/unit/gateway/evidence-search-cache-lifecycle.test.ts', proofTitle: 'invalidates only the exact scoped source in the refresh transaction', reasonNotPublic: 'Cache membership is runtime-private and must be inspected inside the refresh transaction.' },
  { stateId: 'source_deletion_cancel', seam: 'public', proofFile: 'packages/cortex/tests/framework/contracts/source-deletions.contract.ts', proofTitle: 'creates, exactly replays, reads, and safely cancels before destruction' },
  { stateId: 'source_deletion_partial_retry', seam: 'fault_injection', proofFile: 'packages/cortex/tests/framework/contracts/source-deletions.contract.ts', proofTitle: 'keeps partial deletion frozen, rejects cancellation, and retries only failed inventory', reasonNotPublic: 'A safe public client cannot corrupt or withhold runtime-private artifact removal.' },
  { stateId: 'worker_restart_recovery', seam: 'restart_harness', proofFile: 'packages/cortex/tests/integration/gateway/source-job-restart.test.ts', proofTitle: 'resumes queued Data View preparation through the combined worker after restart', reasonNotPublic: 'The harness must stop the runtime at exact durable checkpoints.' },
  { stateId: 'deletion_restart_recovery', seam: 'restart_harness', proofFile: 'packages/cortex/tests/integration/gateway/source-deletion-restart.test.ts', proofTitle: 'resumes an expired irreversible claim and verifies byte absence before success', reasonNotPublic: 'The harness must stop the runtime at exact durable checkpoints.' },
  { stateId: 'grant_expiry_and_clock_boundary', seam: 'fault_injection', proofFile: 'packages/cortex/tests/unit/gateway/access-grant-evaluator.test.ts', proofTitle: 'enforces effective time, expiry, and append-only revocation immediately', reasonNotPublic: 'The minimum public grant lifetime is sixty seconds; tests inject a deterministic clock.' },
  { stateId: 'mid_scan_revoke', seam: 'fault_injection', proofFile: 'packages/cortex/tests/unit/gateway/protected-source-read.test.ts', proofTitle: 'withholds matches when the search grant is revoked after scanning', reasonNotPublic: 'The race must be injected between the two mandatory authorization proofs.' },
  { stateId: 'mid_scan_policy_drift', seam: 'fault_injection', proofFile: 'packages/cortex/tests/unit/gateway/protected-source-read.test.ts', proofTitle: 'withholds matches when live source policy lineage changes during scanning', reasonNotPublic: 'The race must be injected between the two mandatory authorization proofs.' },
  { stateId: 'replaced_private_bytes', seam: 'fault_injection', proofFile: 'packages/cortex/tests/unit/gateway/source-byte-store-search.test.ts', proofTitle: 'withholds every match when full-object checksum verification fails', reasonNotPublic: 'Private object placement is deliberately not a public mutation surface.' },
  { stateId: 'symlinked_private_bytes', seam: 'fault_injection', proofFile: 'packages/cortex/tests/unit/gateway/source-byte-store-search.test.ts', proofTitle: 'rejects a symlinked private object without returning passages', reasonNotPublic: 'Private object placement is deliberately not a public mutation surface.' },
  { stateId: 'protected_search_timeout', seam: 'fault_injection', proofFile: 'packages/cortex/tests/unit/gateway/source-content-handler.test.ts', proofTitle: 'maps protected search timeout to a safe 504 without partial evidence', reasonNotPublic: 'A deterministic storage deadline must be injected without a real slow disk.' },
  { stateId: 'atomic_checkpoint_or_cleanup_failure', seam: 'fault_injection', proofFile: 'packages/cortex/tests/unit/gateway/source-deletion-worker.test.ts', proofTitle: 'keeps failed absence truthful and retries the exact durable inventory', reasonNotPublic: 'The failure is below the public API and must be injected at the storage/checkpoint seam.' },
] as const
