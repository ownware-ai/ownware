import {
  ConnectionInventoryCursorNotFoundError,
  ConnectorConnectionsStore,
} from '../connector/connections/store.js'
import { CandidateStore } from '../gateway/candidate-store.js'
import {
  ChannelJobConflictError,
  ChannelJobStore,
} from '../gateway/channel-job-store.js'
import type { MemoryEventBus } from '../memory/event-bus.js'
import { SqliteUserIdentityStore } from '../memory/identity-store.js'
import { SqliteMemoryProposalsStore } from '../memory/proposals.js'
import { SqliteMemoryStore } from '../memory/store.js'
import { SqliteApprovalStore } from '../schedules/approvals.js'
import { SqliteScheduleStore } from '../schedules/store.js'
import type { TaskEventBus } from '../tasks/event-bus.js'
import { SqliteTaskStore } from '../tasks/store.js'
import { TeamStore } from '../team/store.js'
import {
  StorageLifecycleError,
  StorageRepositoryError,
  type StorageRepositoryDomain,
  type StorageRepositoryErrorCode,
} from './contracts.js'
import type {
  ApprovalRepository,
  CandidateRepository,
  ChannelJobRepository,
  ConnectorConnectionsRepository,
  MemoryProposalRepository,
  MemoryRepository,
  PlatformRepositories,
  ScheduleRepository,
  TaskRepository,
  TeamRepository,
  UserIdentityRepository,
} from './platform-repositories.js'
import type { SqliteRootRepositoryContext } from './sqlite-adapter.js'

export interface SqlitePlatformRepositoryOptions {
  readonly taskEvents: TaskEventBus
  readonly memoryEvents: MemoryEventBus
}

type AsyncMethods<T extends object> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never
}

function sqliteCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { readonly code?: unknown }).code ?? '')
    : ''
}

function isPreservedDomainError(error: unknown): boolean {
  return error instanceof StorageLifecycleError ||
    error instanceof StorageRepositoryError ||
    error instanceof ConnectionInventoryCursorNotFoundError ||
    error instanceof ChannelJobConflictError ||
    error instanceof TypeError ||
    error instanceof RangeError
}

async function repositoryCall<T>(
  assertActive: () => void,
  domain: StorageRepositoryDomain,
  operation: string,
  code: StorageRepositoryErrorCode,
  fn: () => T,
): Promise<Awaited<T>> {
  try {
    assertActive()
    return await fn()
  } catch (error) {
    if (isPreservedDomainError(error)) throw error
    const codeValue = sqliteCode(error)
    if (!codeValue.startsWith('SQLITE_')) throw error
    throw new StorageRepositoryError(
      code,
      'sqlite',
      domain,
      operation,
      codeValue === 'SQLITE_BUSY' || codeValue === 'SQLITE_LOCKED',
    )
  }
}

function wrapRepository<TStore extends object, TPort extends object>(
  store: TStore,
  assertActive: () => void,
  domain: StorageRepositoryDomain,
  operations: Readonly<Record<keyof TPort, StorageRepositoryErrorCode>>,
): AsyncMethods<TPort> {
  const wrapped: Partial<Record<keyof TPort, unknown>> = {}
  for (const key of Object.keys(operations) as Array<keyof TPort>) {
    const method = store[key as unknown as keyof TStore]
    if (typeof method !== 'function') {
      throw new StorageRepositoryError('read_failed', 'sqlite', domain, String(key), false)
    }
    wrapped[key] = (...args: readonly unknown[]) => repositoryCall(
      assertActive,
      domain,
      String(key),
      operations[key],
      () => Reflect.apply(method, store, args),
    )
  }
  return wrapped as AsyncMethods<TPort>
}

const connectorOperations = {
  upsertPending: 'write_failed', markReady: 'write_failed', markFailed: 'write_failed',
  markExpired: 'write_failed', markUnhealthy: 'write_failed', markRevoked: 'write_failed',
  touchPolled: 'write_failed', touchVerified: 'write_failed', findByConnectionId: 'read_failed',
  listInventory: 'read_failed', listActiveByStatus: 'read_failed', countForeignEntities: 'read_failed',
  findPending: 'read_failed', findActive: 'read_failed', findLastVerifiedAt: 'read_failed',
  expireStaleOnBoot: 'write_failed',
} as const satisfies Record<keyof ConnectorConnectionsRepository, StorageRepositoryErrorCode>

const channelOperations = {
  enqueue: 'write_failed', get: 'read_failed', listForProfile: 'read_failed',
  claimNext: 'write_failed', renewLease: 'write_failed', advanceCheckpoint: 'write_failed',
  appendWorkLine: 'write_failed', workLines: 'read_failed', parkForGate: 'write_failed',
  respondToGate: 'write_failed', consumeGateResponse: 'write_failed', deferUntil: 'write_failed',
  finish: 'write_failed', requestCancel: 'write_failed',
  confirmNextUnclaimedCancellation: 'write_failed', confirmCancelled: 'write_failed',
  recoverExpiredClaims: 'write_failed', appendReceipt: 'write_failed',
  receiptsForJob: 'read_failed', receiptsForProfile: 'read_failed',
} as const satisfies Record<keyof ChannelJobRepository, StorageRepositoryErrorCode>

const scheduleOperations = {
  create: 'write_failed', get: 'read_failed', list: 'read_failed', getDue: 'read_failed',
  update: 'write_failed', setEnabled: 'write_failed', advance: 'write_failed', delete: 'write_failed',
  recordRunAndAdvance: 'write_failed', recordRun: 'write_failed', getRun: 'read_failed',
  updateRun: 'write_failed', failInterruptedRuns: 'write_failed', listRuns: 'read_failed',
  listRecentRuns: 'read_failed',
} as const satisfies Record<keyof ScheduleRepository, StorageRepositoryErrorCode>

const approvalOperations = {
  create: 'write_failed', get: 'read_failed', listByRun: 'read_failed', listPending: 'read_failed',
  countPending: 'read_failed', countPendingForRun: 'read_failed', decide: 'write_failed',
} as const satisfies Record<keyof ApprovalRepository, StorageRepositoryErrorCode>

const taskOperations = {
  listForThread: 'read_failed', replaceAllForThread: 'write_failed', updateStatus: 'write_failed',
} as const satisfies Record<keyof TaskRepository, StorageRepositoryErrorCode>

const memoryOperations = {
  getById: 'read_failed', loadActiveForPrompt: 'read_failed', recordReferences: 'write_failed',
  listForProfile: 'read_failed', countForProfile: 'read_failed', create: 'write_failed',
  update: 'write_failed', remove: 'write_failed', supersede: 'write_failed',
} as const satisfies Record<keyof MemoryRepository, StorageRepositoryErrorCode>

const proposalOperations = {
  getById: 'read_failed', listForProfile: 'read_failed', listForThread: 'read_failed',
  countPendingForProfile: 'read_failed', propose: 'write_failed', accept: 'write_failed',
  reject: 'write_failed',
} as const satisfies Record<keyof MemoryProposalRepository, StorageRepositoryErrorCode>

const identityOperations = {
  get: 'read_failed', set: 'write_failed', renderForPrompt: 'read_failed',
} as const satisfies Record<keyof UserIdentityRepository, StorageRepositoryErrorCode>

const candidateOperations = {
  get: 'read_failed', list: 'read_failed', getDeletion: 'read_failed', getActive: 'read_failed',
  getDeploymentState: 'read_failed', compareAndSetActive: 'write_failed',
  compareAndSetUndeployed: 'write_failed', compareAndSetRouting: 'write_failed',
  recordHealth: 'write_failed',
  beginDeletion: 'write_failed', deletionEligibility: 'read_failed', markDeleteFailed: 'write_failed',
  markDeleted: 'write_failed', begin: 'write_failed', markReady: 'write_failed', markFailed: 'write_failed',
  markCleanupFailed: 'write_failed', markCleanupResolved: 'write_failed', recoverInterrupted: 'write_failed',
} as const satisfies Record<keyof CandidateRepository, StorageRepositoryErrorCode>

const teamOperations = {
  createTeam: 'write_failed', getTeam: 'read_failed', getTeamByName: 'read_failed', listTeams: 'read_failed',
  updateTeam: 'write_failed', deleteTeam: 'write_failed', createRun: 'write_failed',
  setRunBudget: 'write_failed', getRun: 'read_failed', getRunByThread: 'read_failed',
  listRunsForTeam: 'read_failed', listActiveRuns: 'read_failed', setRunStatus: 'write_failed',
  addRunCost: 'write_failed', insertTask: 'write_failed', getTask: 'read_failed',
  getTaskBySeq: 'read_failed', listTasks: 'read_failed', setTaskStatus: 'write_failed',
  completeTask: 'write_failed', assignTask: 'write_failed', updateTaskStructure: 'write_failed',
  acquireLease: 'write_failed', renewLeasesForAgent: 'write_failed', listLeases: 'read_failed',
  answerQuestion: 'write_failed',
} as const satisfies Record<keyof TeamRepository, StorageRepositoryErrorCode>

export function createSqlitePlatformRepositories(
  context: SqliteRootRepositoryContext,
  options: SqlitePlatformRepositoryOptions,
): PlatformRepositories {
  const { database, assertActive } = context
  const connectorConnections = new ConnectorConnectionsStore(database)
  const channelJobs = new ChannelJobStore(database)
  const schedules = new SqliteScheduleStore(database)
  const approvals = new SqliteApprovalStore(database)
  const tasks = new SqliteTaskStore(database, options.taskEvents)
  const memories = new SqliteMemoryStore(database, options.memoryEvents)
  const memoryProposals = new SqliteMemoryProposalsStore(database, memories, options.memoryEvents)
  const userIdentity = new SqliteUserIdentityStore(database, options.memoryEvents)
  const candidates = new CandidateStore(database)
  const teams = new TeamStore(database)

  return {
    connectorConnections: wrapRepository<typeof connectorConnections, ConnectorConnectionsRepository>(
      connectorConnections, assertActive, 'connector_connections', connectorOperations,
    ),
    channelJobs: wrapRepository<typeof channelJobs, ChannelJobRepository>(
      channelJobs, assertActive, 'channel_jobs', channelOperations,
    ),
    schedules: wrapRepository<typeof schedules, ScheduleRepository>(
      schedules, assertActive, 'schedules', scheduleOperations,
    ),
    approvals: wrapRepository<typeof approvals, ApprovalRepository>(
      approvals, assertActive, 'schedule_approvals', approvalOperations,
    ),
    tasks: wrapRepository<typeof tasks, TaskRepository>(
      tasks, assertActive, 'tasks', taskOperations,
    ),
    memories: wrapRepository<typeof memories, MemoryRepository>(
      memories, assertActive, 'memories', memoryOperations,
    ),
    memoryProposals: wrapRepository<typeof memoryProposals, MemoryProposalRepository>(
      memoryProposals, assertActive, 'memory_proposals', proposalOperations,
    ),
    userIdentity: wrapRepository<typeof userIdentity, UserIdentityRepository>(
      userIdentity, assertActive, 'user_identity', identityOperations,
    ),
    candidates: wrapRepository<typeof candidates, CandidateRepository>(
      candidates, assertActive, 'profile_candidates', candidateOperations,
    ),
    teams: wrapRepository<typeof teams, TeamRepository>(
      teams, assertActive, 'teams', teamOperations,
    ),
  }
}
