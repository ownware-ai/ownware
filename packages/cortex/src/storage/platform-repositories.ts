import type { ConnectorConnectionsStore } from '../connector/connections/store.js'
import type { CandidateStore } from '../gateway/candidate-store.js'
import type { ChannelJobStore } from '../gateway/channel-job-store.js'
import type { SqliteUserIdentityStore } from '../memory/identity-store.js'
import type { SqliteMemoryProposalsStore } from '../memory/proposals.js'
import type { SqliteMemoryStore } from '../memory/store.js'
import type { SqliteApprovalStore } from '../schedules/approvals.js'
import type { SqliteScheduleStore } from '../schedules/store.js'
import type { SqliteTaskStore } from '../tasks/store.js'
import type { TeamStore } from '../team/store.js'

type AsyncMethods<T extends object> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never
}

type ConnectorConnectionsPort = Pick<ConnectorConnectionsStore,
  | 'upsertPending'
  | 'markReady'
  | 'markFailed'
  | 'markExpired'
  | 'markUnhealthy'
  | 'markRevoked'
  | 'touchPolled'
  | 'touchVerified'
  | 'findByConnectionId'
  | 'listInventory'
  | 'listActiveByStatus'
  | 'countForeignEntities'
  | 'findPending'
  | 'findActive'
  | 'findLastVerifiedAt'
  | 'expireStaleOnBoot'
>

type ChannelJobPort = Pick<ChannelJobStore,
  | 'enqueue'
  | 'get'
  | 'listForProfile'
  | 'claimNext'
  | 'renewLease'
  | 'advanceCheckpoint'
  | 'appendWorkLine'
  | 'workLines'
  | 'parkForGate'
  | 'respondToGate'
  | 'consumeGateResponse'
  | 'deferUntil'
  | 'finish'
  | 'requestCancel'
  | 'confirmNextUnclaimedCancellation'
  | 'confirmCancelled'
  | 'recoverExpiredClaims'
  | 'appendReceipt'
  | 'receiptsForJob'
  | 'receiptsForProfile'
>

type SchedulePort = Pick<SqliteScheduleStore,
  | 'create'
  | 'get'
  | 'list'
  | 'getDue'
  | 'update'
  | 'setEnabled'
  | 'advance'
  | 'delete'
  | 'recordRunAndAdvance'
  | 'recordRun'
  | 'getRun'
  | 'updateRun'
  | 'failInterruptedRuns'
  | 'listRuns'
  | 'listRecentRuns'
>

type ApprovalPort = Pick<SqliteApprovalStore,
  | 'create'
  | 'get'
  | 'listByRun'
  | 'listPending'
  | 'countPending'
  | 'countPendingForRun'
  | 'claim'
  | 'decide'
  | 'recoverInterruptedClaims'
>

type TaskPort = Pick<SqliteTaskStore,
  | 'listForThread'
  | 'replaceAllForThread'
  | 'updateStatus'
>

type MemoryPort = Pick<SqliteMemoryStore,
  | 'getById'
  | 'loadActiveForPrompt'
  | 'recordReferences'
  | 'listForProfile'
  | 'countForProfile'
  | 'create'
  | 'update'
  | 'remove'
  | 'supersede'
>

type MemoryProposalPort = Pick<SqliteMemoryProposalsStore,
  | 'getById'
  | 'listForProfile'
  | 'listForThread'
  | 'countPendingForProfile'
  | 'propose'
  | 'proposeWithDisposition'
  | 'accept'
  | 'reject'
>

type UserIdentityPort = Pick<SqliteUserIdentityStore,
  | 'get'
  | 'set'
  | 'renderForPrompt'
>

type CandidatePort = Pick<CandidateStore,
  | 'get'
  | 'list'
  | 'getDeletion'
  | 'getActive'
  | 'getDeploymentState'
  | 'compareAndSetActive'
  | 'compareAndSetUndeployed'
  | 'compareAndSetRouting'
  | 'recordHealth'
  | 'beginDeletion'
  | 'deletionEligibility'
  | 'markDeleteFailed'
  | 'markDeleted'
  | 'begin'
  | 'markReady'
  | 'markFailed'
  | 'markCleanupFailed'
  | 'markCleanupResolved'
  | 'recoverInterrupted'
>

type TeamPort = Pick<TeamStore,
  | 'createTeam'
  | 'getTeam'
  | 'getTeamByName'
  | 'listTeams'
  | 'updateTeam'
  | 'deleteTeam'
  | 'createRun'
  | 'setRunBudget'
  | 'getRun'
  | 'getRunByThread'
  | 'listRunsForTeam'
  | 'listActiveRuns'
  | 'setRunStatus'
  | 'addRunCost'
  | 'insertTask'
  | 'getTask'
  | 'getTaskBySeq'
  | 'listTasks'
  | 'setTaskStatus'
  | 'completeTask'
  | 'assignTask'
  | 'updateTaskStructure'
  | 'acquireLease'
  | 'renewLeasesForAgent'
  | 'listLeases'
  | 'answerQuestion'
>

export type ConnectorConnectionsRepository = AsyncMethods<ConnectorConnectionsPort>
export type ChannelJobRepository = AsyncMethods<ChannelJobPort>
export type ScheduleRepository = AsyncMethods<SchedulePort>
export type ApprovalRepository = AsyncMethods<ApprovalPort>
export type TaskRepository = AsyncMethods<TaskPort>
export type MemoryRepository = AsyncMethods<MemoryPort>
export type MemoryProposalRepository = AsyncMethods<MemoryProposalPort>
export type UserIdentityRepository = AsyncMethods<UserIdentityPort>
export type CandidateRepository = AsyncMethods<CandidatePort>
export type TeamRepository = AsyncMethods<TeamPort>

export interface PlatformRepositories {
  readonly connectorConnections: ConnectorConnectionsRepository
  readonly channelJobs: ChannelJobRepository
  readonly schedules: ScheduleRepository
  readonly approvals: ApprovalRepository
  readonly tasks: TaskRepository
  readonly memories: MemoryRepository
  readonly memoryProposals: MemoryProposalRepository
  readonly userIdentity: UserIdentityRepository
  readonly candidates: CandidateRepository
  readonly teams: TeamRepository
}
