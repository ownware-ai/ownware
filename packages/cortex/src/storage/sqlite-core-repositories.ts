import type { CortexDatabase } from '../gateway/db/database.js'
import type { SqliteRootRepositoryContext } from './sqlite-adapter.js'
import {
  StorageLifecycleError,
  StorageRepositoryError,
  type StorageRepositoryDomain,
  type StorageRepositoryErrorCode,
} from './contracts.js'
import type {
  AgentEventRepository,
  CoreStorageRepositories,
  MessageRepository,
  ThreadRepository,
  UsageRepository,
} from './core-repositories.js'
import { createSqliteUsageEvidenceRepository } from './sqlite-usage-evidence-repository.js'

/**
 * SQLite implementation of the backend-neutral core repository contract.
 *
 * STO-04 deliberately delegates to the already-certified CortexDatabase SQL
 * while callers move to the final async domain ports. The SQL bodies move out
 * of CortexDatabase incrementally; PostgreSQL implements these interfaces
 * directly and never receives this legacy object.
 */
export function createSqliteCoreRepositories(
  context: SqliteRootRepositoryContext,
): CoreStorageRepositories {
  return createSqliteCoreRepositoriesFromDatabase(
    context.legacyDatabase,
    context.database,
    context.assertActive,
  )
}

/** Test/transition helper for an already-open isolated SQLite database. */
export function createSqliteCoreRepositoriesFromDatabase(
  database: CortexDatabase,
  sqliteDatabase: import('./sqlite-driver.js').SqliteDatabase,
  assertActive: () => void = () => {},
): CoreStorageRepositories {
  const call = <T>(
    domain: StorageRepositoryDomain,
    operation: string,
    code: StorageRepositoryErrorCode,
    fn: () => T,
  ): T => {
    try {
      assertActive()
      return fn()
    } catch (error) {
      if (error instanceof StorageLifecycleError || error instanceof StorageRepositoryError) {
        throw error
      }
      const sqliteCode = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { readonly code?: unknown }).code ?? '')
        : ''
      throw new StorageRepositoryError(
        code,
        'sqlite',
        domain,
        operation,
        sqliteCode === 'SQLITE_BUSY' || sqliteCode === 'SQLITE_LOCKED',
      )
    }
  }

  const threads: ThreadRepository = {
    async create(profileId, title, workspaceId) {
      return call('threads', 'create', 'write_failed', () =>
        database.createThread(profileId, title, workspaceId))
    },
    async get(id) {
      return call('threads', 'get', 'read_failed', () => database.getThread(id))
    },
    async list(profileId, options) {
      return call('threads', 'list', 'read_failed', () =>
        database.listThreads(profileId, options))
    },
    async update(id, updates) {
      return call('threads', 'update', 'write_failed', () =>
        database.updateThread(id, updates))
    },
    async setModel(id, model) {
      call('threads', 'set_model', 'write_failed', () => database.setThreadModel(id, model))
    },
    async recoverOrphaned() {
      return call('threads', 'recover_orphaned', 'write_failed', () =>
        database.recoverOrphanedThreads())
    },
    async delete(id) {
      return call('threads', 'delete', 'write_failed', () => database.deleteThread(id))
    },
  }

  const messages: MessageRepository = {
    async add(threadId, message) {
      call('messages', 'add', 'write_failed', () => database.addMessage(threadId, message))
    },
    async list(threadId) {
      return call('messages', 'list', 'read_failed', () => database.getMessages(threadId))
    },
    async patchSubAgent(threadId, agentId, patch) {
      return call('messages', 'patch_subagent', 'write_failed', () =>
        database.patchMessageSubAgent(threadId, agentId, patch))
    },
  }

  const usage: UsageRepository = {
    async add(record) {
      call('usage', 'add', 'write_failed', () => database.addUsageRecord(record))
    },
    async summary(profileId) {
      return call('usage', 'summary', 'read_failed', () => database.getUsageSummary(profileId))
    },
    async dashboardStats() {
      return call('usage', 'dashboard_stats', 'read_failed', () =>
        database.getDashboardStats())
    },
    async timeSeries(range) {
      return call('usage', 'time_series', 'read_failed', () =>
        database.getUsageTimeSeries(range))
    },
    async kpis(range) {
      return call('usage', 'kpis', 'read_failed', () => database.getKPIs(range))
    },
    async profileBreakdown() {
      return call('usage', 'profile_breakdown', 'read_failed', () =>
        database.getProfileBreakdown())
    },
    async recentActivity(limit) {
      return call('usage', 'recent_activity', 'read_failed', () =>
        database.getRecentActivity(limit))
    },
    async incrementProfile(profileId, cost) {
      call('usage', 'increment_profile', 'write_failed', () =>
        database.incrementProfileUsage(profileId, cost))
    },
  }

  const events: AgentEventRepository = {
    async append(input) {
      return call('events', 'append', 'write_failed', () => database.appendAgentEvent(input))
    },
    async list(input) {
      return call('events', 'list', 'read_failed', () => database.listAgentEvents(input))
    },
    async maxSeq(threadId, agentId) {
      return call('events', 'max_seq', 'read_failed', () =>
        database.getAgentEventMaxSeq(threadId, agentId))
    },
    async minSeq(threadId, agentId, afterSeq, throughSeq) {
      return call('events', 'min_seq', 'read_failed', () =>
        database.getAgentEventMinSeq(threadId, agentId, afterSeq, throughSeq))
    },
    async lastTurnEndSeq(threadId, agentId) {
      return call('events', 'last_turn_end_seq', 'read_failed', () =>
        database.getLastTurnEndSeq(threadId, agentId))
    },
    async hasType(threadId, agentId, type) {
      return call('events', 'has_type', 'read_failed', () =>
        database.hasAgentEventOfType(threadId, agentId, type))
    },
    async listAgents(threadId) {
      return call('events', 'list_agents', 'read_failed', () =>
        database.listAgentsForThread(threadId))
    },
    async listTerminalThreadsOlderThan(cutoffIso) {
      return call('events', 'list_terminal_threads', 'read_failed', () =>
        database.listTerminalThreadsOlderThan(cutoffIso))
    },
    async listQuietRootThreads(cutoffMs) {
      return call('events', 'list_quiet_root_threads', 'read_failed', () =>
        database.listThreadsWithQuietRootAgent(cutoffMs))
    },
    async pruneRootStream(threadId) {
      return call('events', 'prune_root_stream', 'write_failed', () =>
        database.pruneAgentEvents(threadId))
    },
    async count() {
      return call('events', 'count', 'read_failed', () => database.countAgentEvents())
    },
  }

  const usageEvidence = createSqliteUsageEvidenceRepository({
    database: sqliteDatabase,
    assertActive,
  })

  return { threads, messages, usage, usageEvidence, events }
}
