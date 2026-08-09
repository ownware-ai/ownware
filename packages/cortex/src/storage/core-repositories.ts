import type {
  DashboardKPIs,
  DashboardRange,
  DashboardStats,
  PaginatedResult,
  ProfileBreakdownRow,
  RecentActivityRow,
  Thread,
  ThreadMessage,
  UsageBucket,
} from '../gateway/types.js'
import type { UsageEvidenceRepository } from './usage-evidence-repository.js'

export interface ThreadUpdate {
  readonly title?: string | null
  readonly status?: Thread['status']
  readonly messageCount?: number
  readonly totalTokens?: number
  readonly totalCost?: number
}

export interface ThreadRepository {
  create(profileId: string, title?: string, workspaceId?: string): Promise<Thread>
  get(id: string): Promise<Thread | undefined>
  list(
    profileId?: string,
    options?: { readonly limit?: number; readonly offset?: number },
  ): Promise<PaginatedResult<Thread>>
  update(id: string, updates: ThreadUpdate): Promise<Thread | undefined>
  setModel(id: string, model: string): Promise<void>
  recoverOrphaned(): Promise<number>
  delete(id: string): Promise<boolean>
}

export interface MessageSubAgentPatch {
  readonly status: 'running' | 'completed' | 'error'
  readonly result?: string
  readonly durationMs?: number
  readonly toolCount?: number
  readonly turnCount?: number
}

export interface MessageRepository {
  /**
   * Durably appends one message. The adapter assigns the per-thread order at
   * this transaction boundary; caller timestamps and opaque ids never decide
   * conversation order.
   */
  add(threadId: string, message: ThreadMessage): Promise<void>
  /** Lists committed messages in their adapter-assigned per-thread order. */
  list(threadId: string): Promise<ThreadMessage[]>
  patchSubAgent(
    threadId: string,
    agentId: string,
    patch: MessageSubAgentPatch,
  ): Promise<boolean>
}

export interface UsageRecordInput {
  readonly threadId?: string
  readonly profileId: string
  readonly model: string
  readonly provider: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd: number
  readonly durationMs?: number
  readonly success?: boolean
}

export interface UsageSummary {
  readonly totalTokens: number
  readonly totalCost: number
  readonly requestCount: number
}

export interface UsageRepository {
  add(record: UsageRecordInput): Promise<void>
  summary(profileId?: string): Promise<UsageSummary>
  dashboardStats(): Promise<DashboardStats>
  timeSeries(range?: DashboardRange): Promise<UsageBucket[]>
  kpis(range?: DashboardRange): Promise<DashboardKPIs>
  profileBreakdown(): Promise<ProfileBreakdownRow[]>
  recentActivity(limit?: number): Promise<RecentActivityRow[]>
  incrementProfile(profileId: string, cost: number): Promise<void>
}

export interface AgentEventAppendInput {
  readonly threadId: string
  readonly agentId: string
  readonly parentAgentId: string | null
  readonly type: string
  readonly payload: unknown
}

export interface AgentEventListInput {
  readonly threadId: string
  readonly agentId: string
  readonly since?: number
  readonly limit?: number
}

export interface AgentEventRecord {
  readonly seq: number
  readonly type: string
  readonly payload: unknown
  readonly createdAt: number
  readonly parentAgentId: string | null
}

export interface AgentStreamSummary {
  readonly agentId: string
  readonly parentAgentId: string | null
  readonly eventCount: number
}

export interface AgentEventRepository {
  append(input: AgentEventAppendInput): Promise<number>
  list(input: AgentEventListInput): Promise<AgentEventRecord[]>
  maxSeq(threadId: string, agentId: string): Promise<number>
  minSeq(
    threadId: string,
    agentId: string,
    afterSeq: number,
    throughSeq?: number,
  ): Promise<number | null>
  lastTurnEndSeq(threadId: string, agentId: string): Promise<number>
  hasType(threadId: string, agentId: string, type: string): Promise<boolean>
  listAgents(threadId: string): Promise<AgentStreamSummary[]>
  listTerminalThreadsOlderThan(cutoffIso: string): Promise<string[]>
  listQuietRootThreads(cutoffMs: number): Promise<string[]>
  pruneRootStream(threadId: string): Promise<number>
  count(): Promise<number>
}

export interface CoreStorageRepositories {
  readonly threads: ThreadRepository
  readonly messages: MessageRepository
  readonly usage: UsageRepository
  readonly usageEvidence: UsageEvidenceRepository
  readonly events: AgentEventRepository
}
