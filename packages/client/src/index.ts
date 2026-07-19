/**
 * @ownware/client — talk to your Ownware agent from anywhere.
 *
 * The typed SDK over the gateway wire contract (HTTP + SSE). Zero
 * dependencies, no Node-only APIs: the same package works in Node and
 * the browser. The server half is the `ownware` package (OwnwareGateway);
 * this is the plug that connects to it.
 *
 *   import { OwnwareClient } from '@ownware/client'
 *   const ownware = new OwnwareClient({ baseUrl: 'http://localhost:4000', token })
 *   const { runId } = await ownware.run({ profileId: 'assistant', prompt: 'hello' })
 *   if (!runId) throw new Error('Gateway does not support run snapshots')
 *   for await (const ev of ownware.streamReply(runId)) {
 *     if (ev.type === 'delta') process.stdout.write(ev.text)
 *   }
 *
 * The wire contract itself is versioned in `spec/` (OpenAPI + AsyncAPI).
 */

export type {
  RunInput,
  RunAttachmentInput,
  RunResult,
  DurableRunStatus,
  RunSnapshot,
  StreamReplyOptions,
  GatewayEvent,
  ResumeInput,
  PermissionDecisionInput,
  PermissionDecisionResult,
  RunCancellationResult,
  ModelEntry,
  ProfileSummary,
  HealthResult,
  GatewayContractDescriptor,
  GatewayCapability,
  PublicGatewayLimits,
  SourceQuotaCeilings,
  SourceQuotaResourceClass,
  CapabilityRequirements,
  CapabilityNegotiationResult,
  IssueDelegationInput,
  DelegatedPrincipal,
  IssueDelegationResult,
  CandidateUploadFile,
  ValidateCandidateInput,
  CandidateFinding,
  CandidateValidationResult,
  StageCandidateInput,
  CandidateStageResult,
  ActivateCandidateInput,
  CandidateActivationResult,
  CandidateRollbackResult,
  ProfileRoutingState,
  ProfileDeploymentHealth,
  ProfileDeploymentMutationInput,
  ProfileDeploymentResult,
  CandidatePublicState,
  CandidateStatus,
  CandidateList,
  ProfileDeploymentStatus,
  CandidateDeletionResult,
  SourceKind,
  SourceClassification,
  SourceAuthority,
  RegisterSourceInput,
  SourceHealth,
  SourceManifest,
  SourceListOptions,
  SourceList,
  ConnectionInventoryStatus,
  ConnectionRecovery,
  ConnectionInventoryItem,
  ConnectionListOptions,
  ConnectionList,
  CreateSourceUploadSessionInput,
  SourceUploadSession,
  WriteSourceUploadChunkInput,
  SourceUploadChunkResult,
  SourceVersionManifest,
  SourceUploadCompletionResult,
  SourceJobOperation,
  SourceJobState,
  SourceJobOutcomeCode,
  CreateSourceJobInput,
  CreateSourcePreparationInput,
  SourceJob,
  SourceJobCancellationResult,
  SourceResourceManifest,
  SourceDataViewField,
  SourceDataViewManifest,
  CreateDataViewQueryGrantInput,
  QuerySourceDataViewInput,
  SourceDataViewSelectionRow,
  ProtectedSourceDataViewSelection,
  AccessConsent,
  CreateAccessGrantInput,
  AccessGrantMutationReceipt,
  AccessGrant,
  CurrentAccessGrant,
  AccessGrantListOptions,
  AccessGrantList,
  RevokeAccessGrantInput,
  ReadSourceContentInput,
  ProtectedSourceContent,
  SourceContentSearchMatchMode,
  SearchSourceContentInput,
  ProtectedSourceSearchMatch,
  ProtectedSourceSearchResult,
  CreateSourceDeletionInput,
  SourceDeletionCounts,
  SourceDeletion,
  SourceDeletionCancellationResult,
  SourceDeletionRetryResult,
  GatewayClient,
  OwnwareClientOptions,
  HttpGatewayClientOptions,
} from './client.js'
export { OwnwareClient, OwnwareError, HttpGatewayClient } from './client.js'

export type { RunStreamEvent } from './run-stream.js'
export { interpretSseEvent } from './run-stream.js'

export { parseSseFrames } from './sse.js'
