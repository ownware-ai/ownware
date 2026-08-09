import { randomUUID } from 'node:crypto'
import type {
  DashboardKPICard,
  DashboardKPIs,
  DashboardProfileEntry,
  DashboardRange,
  DashboardStats,
  DashboardWorkspaceEntry,
  ProfileBreakdownRow,
  RecentActivityRow,
  Thread,
  ThreadMessage,
  UsageBucket,
} from '../gateway/types.js'
import type { PostgreSqlRootRepositoryContext } from './postgresql-adapter.js'
import type {
  AgentEventRecord,
  CoreStorageRepositories,
  ThreadUpdate,
} from './core-repositories.js'
import type { PostgreSqlPoolClient } from './postgresql-driver.js'
import {
  finiteNumber,
  nullableSafeInteger,
  repositoryCall,
  safeInteger,
  withPostgreSqlTransaction,
} from './postgresql-repository.js'
import { createPostgreSqlUsageEvidenceRepository } from './postgresql-usage-evidence-repository.js'

interface ThreadRow {
  readonly id: string
  readonly profile_id: string
  readonly workspace_id: string | null
  readonly title: string | null
  readonly status: string
  readonly message_count: unknown
  readonly total_tokens: unknown
  readonly total_cost: unknown
  readonly model: string | null
  readonly last_message_preview: string | null
  readonly created_at: string
  readonly updated_at: string
}

interface MessageRow {
  readonly id: string
  readonly role: string
  readonly content: string
  readonly tools: string | null
  readonly sub_agents: string | null
  readonly permissions: string | null
  readonly attachments: string | null
  readonly thinking: string | null
  readonly usage_input: unknown | null
  readonly usage_output: unknown | null
  readonly usage_cache_read: unknown | null
  readonly usage_cache_creation: unknown | null
  readonly created_at: string
  readonly parts: string | null
  readonly credentials: string | null
  readonly model: string | null
}

interface AggregateRow {
  readonly tokens: unknown
  readonly cost: unknown
  readonly count?: unknown
  readonly runs?: unknown
  readonly avg_duration?: unknown
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

function now(): string {
  return new Date().toISOString()
}

function mapThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    profileId: row.profile_id,
    workspaceId: row.workspace_id,
    title: row.title,
    status: row.status as Thread['status'],
    messageCount: safeInteger(row.message_count),
    totalTokens: safeInteger(row.total_tokens),
    totalCost: finiteNumber(row.total_cost),
    model: row.model,
    lastMessagePreview: row.last_message_preview,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseJson(value: string | null): unknown | undefined {
  return value === null ? undefined : JSON.parse(value) as unknown
}

function mapMessage(row: MessageRow): ThreadMessage {
  const usageInput = nullableSafeInteger(row.usage_input)
  return {
    id: row.id,
    role: row.role as ThreadMessage['role'],
    content: row.content,
    tools: parseJson(row.tools) as ThreadMessage['tools'],
    subAgents: parseJson(row.sub_agents) as ThreadMessage['subAgents'],
    permissions: parseJson(row.permissions) as ThreadMessage['permissions'],
    credentials: parseJson(row.credentials) as ThreadMessage['credentials'],
    attachments: parseJson(row.attachments) as ThreadMessage['attachments'],
    thinking: row.thinking ?? undefined,
    usage: usageInput === null
      ? undefined
      : {
          inputTokens: usageInput,
          outputTokens: nullableSafeInteger(row.usage_output) ?? 0,
          ...(row.usage_cache_read === null
            ? {}
            : { cacheReadTokens: safeInteger(row.usage_cache_read) }),
          ...(row.usage_cache_creation === null
            ? {}
            : { cacheCreationTokens: safeInteger(row.usage_cache_creation) }),
        },
    timestamp: row.created_at,
    parts: parseJson(row.parts) as ThreadMessage['parts'],
    ...(row.model === null ? {} : { model: row.model }),
  }
}

async function getThread(client: PostgreSqlPoolClient | PostgreSqlRootRepositoryContext['pool'], threadId: string) {
  const result = await client.query<ThreadRow>('SELECT * FROM ownware.threads WHERE id = $1', [threadId])
  const row = result.rows[0]
  return row === undefined ? undefined : mapThread(row)
}

async function createThreadOn(
  client: PostgreSqlPoolClient,
  profileId: string,
  title?: string,
  workspaceId?: string,
): Promise<Thread> {
  const threadId = id('thread')
  const timestamp = now()
  await client.query(`
    INSERT INTO ownware.threads (
      id, profile_id, workspace_id, title, status, message_count,
      total_tokens, total_cost, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, 'active', 0, 0, 0, $5, $5)
  `, [threadId, profileId, workspaceId ?? null, title ?? null, timestamp])
  if (workspaceId !== undefined) {
    await client.query(`
      INSERT INTO ownware.workspace_profiles (
        workspace_id, profile_id, thread_count, last_used_at
      ) VALUES ($1, $2, 1, $3)
      ON CONFLICT (workspace_id, profile_id) DO UPDATE SET
        thread_count = ownware.workspace_profiles.thread_count + 1,
        last_used_at = EXCLUDED.last_used_at
    `, [workspaceId, profileId, timestamp])
  }
  return {
    id: threadId,
    profileId,
    workspaceId: workspaceId ?? null,
    title: title ?? null,
    status: 'active',
    messageCount: 0,
    totalTokens: 0,
    totalCost: 0,
    model: null,
    lastMessagePreview: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function rangeToConfig(range: DashboardRange): { days: number | null; hours: number | null } {
  switch (range) {
    case '24h': return { days: null, hours: 24 }
    case '7d': return { days: 7, hours: null }
    case '30d': return { days: 30, hours: null }
    case '90d': return { days: 90, hours: null }
  }
}

/** Complete PostgreSQL implementation of the core repository contract. */
export function createPostgreSqlCoreRepositories(
  context: PostgreSqlRootRepositoryContext,
): CoreStorageRepositories {
  const eventAppendTails = new Map<string, Promise<void>>()
  const serializeEventAppend = <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = eventAppendTails.get(key) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => {}, () => {})
    eventAppendTails.set(key, tail)
    return result.finally(() => {
      if (eventAppendTails.get(key) === tail) eventAppendTails.delete(key)
    })
  }
  const threads: CoreStorageRepositories['threads'] = {
    create(profileId, title, workspaceId) {
      return repositoryCall(context, 'threads', 'create', 'write_failed', async (pool) =>
        withPostgreSqlTransaction(pool as PostgreSqlRootRepositoryContext['pool'], (client) =>
          createThreadOn(client, profileId, title, workspaceId)))
    },
    get(threadId) {
      return repositoryCall(context, 'threads', 'get', 'read_failed', (client) =>
        getThread(client, threadId))
    },
    list(profileId, options) {
      return repositoryCall(context, 'threads', 'list', 'read_failed', async (client) => {
        const limit = Math.min(options?.limit ?? 50, 200)
        const offset = options?.offset ?? 0
        const count = profileId === undefined
          ? await client.query<{ readonly count: string }>('SELECT count(*)::text AS count FROM ownware.threads')
          : await client.query<{ readonly count: string }>(
              'SELECT count(*)::text AS count FROM ownware.threads WHERE profile_id = $1',
              [profileId],
            )
        const rows = profileId === undefined
          ? await client.query<ThreadRow>(`
              SELECT * FROM ownware.threads
              ORDER BY updated_at DESC, id ASC LIMIT $1 OFFSET $2
            `, [limit, offset])
          : await client.query<ThreadRow>(`
              SELECT * FROM ownware.threads WHERE profile_id = $1
              ORDER BY updated_at DESC, id ASC LIMIT $2 OFFSET $3
            `, [profileId, limit, offset])
        return {
          items: rows.rows.map(mapThread),
          total: safeInteger(count.rows[0]?.count ?? '0'),
          offset,
          limit,
        }
      })
    },
    update(threadId, updates) {
      return repositoryCall(context, 'threads', 'update', 'write_failed', async (pool) =>
        withPostgreSqlTransaction(
          pool as PostgreSqlRootRepositoryContext['pool'],
          async (client) => {
            await client.query(
              'SELECT id FROM ownware.threads WHERE id = $1 FOR UPDATE',
              [threadId],
            )
            const current = await getThread(client, threadId)
            if (current === undefined) return undefined
            const next: Required<Pick<ThreadUpdate, 'title' | 'status' | 'messageCount' | 'totalTokens' | 'totalCost'>> = {
              title: updates.title !== undefined ? updates.title : current.title,
              status: updates.status ?? current.status,
              messageCount: updates.messageCount ?? current.messageCount,
              totalTokens: updates.totalTokens ?? current.totalTokens,
              totalCost: updates.totalCost ?? current.totalCost,
            }
            await client.query(`
              UPDATE ownware.threads SET title = $1, status = $2, message_count = $3,
                total_tokens = $4, total_cost = $5, updated_at = $6 WHERE id = $7
            `, [
              next.title,
              next.status,
              next.messageCount,
              next.totalTokens,
              next.totalCost,
              now(),
              threadId,
            ])
            return getThread(client, threadId)
          },
        ))
    },
    setModel(threadId, model) {
      return repositoryCall(context, 'threads', 'set_model', 'write_failed', async (client) => {
        await client.query(
          'UPDATE ownware.threads SET model = $1, updated_at = $2 WHERE id = $3',
          [model, now(), threadId],
        )
      })
    },
    recoverOrphaned() {
      return repositoryCall(context, 'threads', 'recover_orphaned', 'write_failed', async (client) => {
        const result = await client.query(
          `UPDATE ownware.threads SET status = 'completed', updated_at = $1 WHERE status = 'active'`,
          [now()],
        )
        return result.rowCount ?? 0
      })
    },
    delete(threadId) {
      return repositoryCall(context, 'threads', 'delete', 'write_failed', async (client) => {
        const result = await client.query('DELETE FROM ownware.threads WHERE id = $1', [threadId])
        return (result.rowCount ?? 0) > 0
      })
    },
  }

  const messages: CoreStorageRepositories['messages'] = {
    add(threadId, message) {
      return repositoryCall(context, 'messages', 'add', 'write_failed', async (pool) => {
        const json = (value: unknown | undefined): string | null =>
          value === undefined ? null : JSON.stringify(value)
        await withPostgreSqlTransaction(
          pool as PostgreSqlRootRepositoryContext['pool'],
          async (client) => {
            // This row update is both the aggregate mutation and the exact
            // same-thread serialization boundary. A concurrent writer cannot
            // observe/allocate until the prior transaction commits, while an
            // INSERT failure rolls the count and lock-owned work back together.
            const allocated = await client.query<{ readonly message_seq: string }>(`
              UPDATE ownware.threads AS thread_record SET
                message_count = GREATEST(
                  thread_record.message_count,
                  COALESCE((
                    SELECT MAX(message.message_seq)
                    FROM ownware.messages AS message
                    WHERE message.thread_id = $3
                  ), 0)
                ) + 1,
                last_message_preview = $1,
                updated_at = $2
              WHERE id = $3
                AND GREATEST(
                  thread_record.message_count,
                  COALESCE((
                    SELECT MAX(message.message_seq)
                    FROM ownware.messages AS message
                    WHERE message.thread_id = $3
                  ), 0)
                ) < 9007199254740991
              RETURNING message_count::text AS message_seq
            `, [message.content.slice(0, 200) || null, now(), threadId])
            let messageSeq = allocated.rows[0] === undefined
              ? 1
              : safeInteger(allocated.rows[0].message_seq)
            if (allocated.rows[0] === undefined) {
              const state = await client.query<{
                readonly message_count: string
                readonly max_message_seq: string
              }>(`
                SELECT
                  thread_record.message_count::text AS message_count,
                  COALESCE(MAX(message.message_seq), 0)::text AS max_message_seq
                FROM ownware.threads AS thread_record
                LEFT JOIN ownware.messages AS message
                  ON message.thread_id = thread_record.id
                WHERE thread_record.id = $1
                GROUP BY thread_record.id
              `, [threadId])
              const row = state.rows[0]
              if (
                row !== undefined &&
                Math.max(
                  safeInteger(row.message_count),
                  safeInteger(row.max_message_seq),
                ) >= Number.MAX_SAFE_INTEGER
              ) {
                throw new RangeError('Message sequence exhausted the safe integer domain.')
              }
              // No thread row: keep the historical FK-owned failure by
              // attempting sequence 1 below; the INSERT remains authoritative.
              messageSeq = 1
            }

            await client.query(`
              INSERT INTO ownware.messages (
                id, thread_id, role, content, tools, sub_agents, permissions,
                attachments, thinking, usage_input, usage_output, usage_cache_read,
                usage_cache_creation, created_at, parts, credentials, model,
                message_seq
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                $14, $15, $16, $17, $18
              )
            `, [
              message.id,
              threadId,
              message.role,
              message.content,
              json(message.tools),
              json(message.subAgents),
              json(message.permissions),
              json(message.attachments),
              message.thinking ?? null,
              message.usage?.inputTokens ?? null,
              message.usage?.outputTokens ?? null,
              message.usage?.cacheReadTokens ?? null,
              message.usage?.cacheCreationTokens ?? null,
              message.timestamp,
              json(message.parts),
              json(message.credentials),
              message.model ?? null,
              messageSeq,
            ])
          },
        )
      })
    },
    list(threadId) {
      return repositoryCall(context, 'messages', 'list', 'read_failed', async (client) => {
        const result = await client.query<MessageRow>(`
          SELECT * FROM ownware.messages WHERE thread_id = $1
          ORDER BY message_seq ASC
        `, [threadId])
        return result.rows.map(mapMessage)
      })
    },
    patchSubAgent(threadId, agentId, patch) {
      return repositoryCall(context, 'messages', 'patch_subagent', 'write_failed', async (pool) =>
        withPostgreSqlTransaction(
          pool as PostgreSqlRootRepositoryContext['pool'],
          async (client) => {
            const result = await client.query<{ readonly id: string; readonly sub_agents: string }>(`
              SELECT id, sub_agents FROM ownware.messages
              WHERE thread_id = $1 AND sub_agents IS NOT NULL
              ORDER BY message_seq DESC FOR UPDATE
            `, [threadId])
            for (const row of result.rows) {
              let agents: Array<Record<string, unknown>>
              try {
                agents = JSON.parse(row.sub_agents) as Array<Record<string, unknown>>
              } catch {
                continue
              }
              const index = agents.findIndex((agent) => agent.agentId === agentId)
              if (index < 0) continue
              agents[index] = { ...agents[index], ...patch }
              await client.query(
                'UPDATE ownware.messages SET sub_agents = $1 WHERE id = $2',
                [JSON.stringify(agents), row.id],
              )
              return true
            }
            return false
          },
        ))
    },
  }

  const usage: CoreStorageRepositories['usage'] = {
    add(record) {
      return repositoryCall(context, 'usage', 'add', 'write_failed', async (pool) => {
        const usageId = id('usage')
        const totalTokens = record.inputTokens + record.outputTokens
        await withPostgreSqlTransaction(
          pool as PostgreSqlRootRepositoryContext['pool'],
          async (client) => {
            await client.query(`
              INSERT INTO ownware.usage_records (
                id, thread_id, profile_id, model, provider, input_tokens,
                output_tokens, total_tokens, cost_usd, duration_ms, success
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            `, [
              usageId,
              record.threadId ?? null,
              record.profileId,
              record.model,
              record.provider,
              record.inputTokens,
              record.outputTokens,
              totalTokens,
              record.costUsd,
              record.durationMs ?? null,
              record.success ?? true,
            ])
            if (record.threadId !== undefined) {
              await client.query(`
                UPDATE ownware.threads SET
                  total_tokens = total_tokens + $1,
                  total_cost = total_cost + $2,
                  updated_at = $3
                WHERE id = $4
              `, [totalTokens, record.costUsd, now(), record.threadId])
            }
          },
        )
      })
    },
    summary(profileId) {
      return repositoryCall(context, 'usage', 'summary', 'read_failed', async (client) => {
        const result = profileId === undefined
          ? await client.query<AggregateRow>(`
              SELECT COALESCE(sum(total_tokens), 0) AS tokens,
                COALESCE(sum(cost_usd), 0) AS cost, count(*) AS count
              FROM ownware.usage_records
            `)
          : await client.query<AggregateRow>(`
              SELECT COALESCE(sum(total_tokens), 0) AS tokens,
                COALESCE(sum(cost_usd), 0) AS cost, count(*) AS count
              FROM ownware.usage_records WHERE profile_id = $1
            `, [profileId])
        const row = result.rows[0]
        return {
          totalTokens: safeInteger(row?.tokens ?? '0'),
          totalCost: finiteNumber(row?.cost ?? 0),
          requestCount: safeInteger(row?.count ?? '0'),
        }
      })
    },
    dashboardStats() {
      return repositoryCall(context, 'usage', 'dashboard_stats', 'read_failed', async (client) => {
        const today = new Date().toISOString().slice(0, 10)
        const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)
        const todayResult = await client.query<AggregateRow>(`
          SELECT count(*) AS runs, COALESCE(sum(total_tokens), 0) AS tokens,
            COALESCE(sum(cost_usd), 0) AS cost
          FROM ownware.usage_records WHERE created_at >= $1
        `, [today])
        const weekResult = await client.query<{ readonly cost: unknown }>(`
          SELECT COALESCE(sum(cost_usd), 0) AS cost
          FROM ownware.usage_records WHERE created_at >= $1
        `, [weekAgo])
        const workspaceResult = await client.query<{ readonly count: string }>(`
          SELECT count(*)::text AS count FROM ownware.workspaces WHERE status = 'active'
        `)
        const profileResult = await client.query<{
          readonly profile_id: string
          readonly runs: unknown
          readonly cost: unknown
        }>(`
          SELECT profile_id, count(*) AS runs, COALESCE(sum(cost_usd), 0) AS cost
          FROM ownware.usage_records WHERE created_at >= $1
          GROUP BY profile_id ORDER BY runs DESC, profile_id ASC
        `, [weekAgo])
        const profileRows = profileResult.rows.map((row) => ({
          profileId: row.profile_id,
          runs: safeInteger(row.runs),
          cost: finiteNumber(row.cost),
        }))
        const totalRuns = profileRows.reduce((sum, row) => sum + row.runs, 0) || 1
        const byProfile: DashboardProfileEntry[] = profileRows.map((row) => ({
          profileId: row.profileId,
          runCount: row.runs,
          runPercent: Math.round((row.runs / totalRuns) * 100),
          weekCost: row.cost,
        }))
        const workspaceRows = await client.query<{
          readonly workspace_id: string
          readonly name: string
          readonly threads: unknown
          readonly cost: unknown
        }>(`
          SELECT workspace.id AS workspace_id, workspace.name,
            count(DISTINCT thread.id) AS threads,
            COALESCE(sum(usage.cost_usd), 0) AS cost
          FROM ownware.workspaces AS workspace
          INNER JOIN ownware.threads AS thread ON thread.workspace_id = workspace.id
          LEFT JOIN ownware.usage_records AS usage
            ON usage.thread_id = thread.id AND usage.created_at >= $1
          WHERE workspace.status = 'active'
          GROUP BY workspace.id ORDER BY threads DESC, workspace.id ASC
        `, [weekAgo])
        const byWorkspace: DashboardWorkspaceEntry[] = workspaceRows.rows.map((row) => ({
          workspaceId: row.workspace_id,
          workspaceName: row.name,
          threadCount: safeInteger(row.threads),
          weekCost: finiteNumber(row.cost),
        }))
        const todayRow = todayResult.rows[0]
        return {
          activeAgents: 0,
          todayRuns: safeInteger(todayRow?.runs ?? '0'),
          todayTokens: safeInteger(todayRow?.tokens ?? '0'),
          todayCost: finiteNumber(todayRow?.cost ?? 0),
          weekCost: finiteNumber(weekResult.rows[0]?.cost ?? 0),
          workspaceCount: safeInteger(workspaceResult.rows[0]?.count ?? '0'),
          byProfile,
          byWorkspace,
        } satisfies DashboardStats
      })
    },
    timeSeries(range = '7d') {
      return repositoryCall(context, 'usage', 'time_series', 'read_failed', async (client) => {
        const { days, hours } = rangeToConfig(range)
        const timestamp = new Date()
        if (hours !== null) {
          const cutoff = new Date(timestamp.getTime() - hours * 3_600_000).toISOString()
          const result = await client.query<{
            readonly date: string
            readonly tokens: unknown
            readonly cost: unknown
            readonly runs: unknown
          }>(`
            SELECT substr(created_at, 1, 13) || ':00:00' AS date,
              COALESCE(sum(total_tokens), 0) AS tokens,
              COALESCE(sum(cost_usd), 0) AS cost, count(*) AS runs
            FROM ownware.usage_records WHERE created_at >= $1
            GROUP BY substr(created_at, 1, 13) ORDER BY date ASC
          `, [cutoff])
          const map = new Map(result.rows.map((row) => [row.date.slice(0, 13), row]))
          const buckets: UsageBucket[] = []
          for (let hour = hours - 1; hour >= 0; hour -= 1) {
            const date = new Date(timestamp.getTime() - hour * 3_600_000)
            const key = date.toISOString().slice(0, 13)
            const row = map.get(key)
            buckets.push({
              date: `${date.toISOString().slice(0, 10)}T${date.toISOString().slice(11, 13)}:00:00`,
              tokens: safeInteger(row?.tokens ?? '0'),
              cost: finiteNumber(row?.cost ?? 0),
              runs: safeInteger(row?.runs ?? '0'),
            })
          }
          return buckets
        }
        const cutoff = new Date(timestamp.getTime() - days! * 86_400_000).toISOString().slice(0, 10)
        const result = await client.query<{
          readonly date: string
          readonly tokens: unknown
          readonly cost: unknown
          readonly runs: unknown
        }>(`
          SELECT substr(created_at, 1, 10) AS date,
            COALESCE(sum(total_tokens), 0) AS tokens,
            COALESCE(sum(cost_usd), 0) AS cost, count(*) AS runs
          FROM ownware.usage_records WHERE substr(created_at, 1, 10) >= $1
          GROUP BY substr(created_at, 1, 10) ORDER BY date ASC
        `, [cutoff])
        const map = new Map(result.rows.map((row) => [row.date, row]))
        const buckets: UsageBucket[] = []
        for (let dayOffset = days! - 1; dayOffset >= 0; dayOffset -= 1) {
          const day = new Date(timestamp.getTime() - dayOffset * 86_400_000).toISOString().slice(0, 10)
          const row = map.get(day)
          buckets.push({
            date: day,
            tokens: safeInteger(row?.tokens ?? '0'),
            cost: finiteNumber(row?.cost ?? 0),
            runs: safeInteger(row?.runs ?? '0'),
          })
        }
        return buckets
      })
    },
    kpis(range = '7d') {
      return repositoryCall(context, 'usage', 'kpis', 'read_failed', async (client) => {
        const { days, hours } = rangeToConfig(range)
        const periodMs = hours !== null ? hours * 3_600_000 : days! * 86_400_000
        const timestamp = Date.now()
        const currentCutoff = new Date(timestamp - periodMs).toISOString()
        const previousCutoff = new Date(timestamp - periodMs * 2).toISOString()
        const currentResult = await client.query<AggregateRow>(`
          SELECT COALESCE(sum(total_tokens), 0) AS tokens,
            COALESCE(sum(cost_usd), 0) AS cost, count(*) AS runs,
            COALESCE(avg(duration_ms), 0) AS avg_duration
          FROM ownware.usage_records WHERE created_at >= $1
        `, [currentCutoff])
        const previousResult = await client.query<AggregateRow>(`
          SELECT COALESCE(sum(total_tokens), 0) AS tokens,
            COALESCE(sum(cost_usd), 0) AS cost, count(*) AS runs,
            COALESCE(avg(duration_ms), 0) AS avg_duration
          FROM ownware.usage_records WHERE created_at >= $1 AND created_at < $2
        `, [previousCutoff, currentCutoff])
        const sparkRows = await client.query<{
          readonly created_at: string
          readonly total_tokens: unknown
          readonly cost_usd: unknown
          readonly duration_ms: unknown | null
        }>(`
          SELECT created_at, total_tokens, cost_usd, duration_ms
          FROM ownware.usage_records WHERE created_at >= $1
        `, [currentCutoff])
        const bucketMs = Math.floor(periodMs / 12)
        const tokenSpark = new Array<number>(12).fill(0)
        const costSpark = new Array<number>(12).fill(0)
        const runSpark = new Array<number>(12).fill(0)
        const durationSums = new Array<number>(12).fill(0)
        const durationCounts = new Array<number>(12).fill(0)
        for (const row of sparkRows.rows) {
          const age = timestamp - new Date(row.created_at).getTime()
          const index = Math.min(11, Math.floor((periodMs - age) / bucketMs))
          if (index < 0) continue
          tokenSpark[index]! += safeInteger(row.total_tokens)
          costSpark[index]! += finiteNumber(row.cost_usd)
          runSpark[index]! += 1
          if (row.duration_ms !== null) {
            durationSums[index]! += safeInteger(row.duration_ms)
            durationCounts[index]! += 1
          }
        }
        const durationSpark = durationSums.map((sum, index) =>
          durationCounts[index]! > 0 ? Math.round(sum / durationCounts[index]!) : 0)
        const current = currentResult.rows[0]!
        const previous = previousResult.rows[0]!
        const values = {
          current: {
            tokens: safeInteger(current.tokens),
            cost: finiteNumber(current.cost),
            runs: safeInteger(current.runs ?? '0'),
            duration: finiteNumber(current.avg_duration ?? 0),
          },
          previous: {
            tokens: safeInteger(previous.tokens),
            cost: finiteNumber(previous.cost),
            runs: safeInteger(previous.runs ?? '0'),
            duration: finiteNumber(previous.avg_duration ?? 0),
          },
        }
        const percent = (currentValue: number, previousValue: number): number | null =>
          previousValue === 0
            ? null
            : Math.round(((currentValue - previousValue) / previousValue) * 1_000) / 10
        const cards: DashboardKPICard[] = [
          { label: 'Tokens', value: values.current.tokens, unit: 'tokens', delta: percent(values.current.tokens, values.previous.tokens), sparkline: tokenSpark },
          { label: 'Cost', value: Math.round(values.current.cost * 10_000) / 10_000, unit: 'USD', delta: percent(values.current.cost, values.previous.cost), sparkline: costSpark },
          { label: 'Runs', value: values.current.runs, unit: 'runs', delta: percent(values.current.runs, values.previous.runs), sparkline: runSpark },
          { label: 'Avg Duration', value: Math.round(values.current.duration), unit: 'ms', delta: percent(values.current.duration, values.previous.duration), sparkline: durationSpark },
        ]
        return { range, cards } satisfies DashboardKPIs
      })
    },
    profileBreakdown() {
      return repositoryCall(context, 'usage', 'profile_breakdown', 'read_failed', async (client) => {
        const result = await client.query<{
          readonly profile_id: string
          readonly runs: unknown
          readonly tokens: unknown
          readonly cost: unknown
          readonly avg_duration: unknown | null
          readonly success_rate: unknown
        }>(`
          SELECT profile_id, count(*) AS runs,
            COALESCE(sum(total_tokens), 0) AS tokens,
            COALESCE(sum(cost_usd), 0) AS cost,
            avg(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) AS avg_duration,
            COALESCE(avg(CASE WHEN success THEN 1.0 ELSE 0.0 END), 1) AS success_rate
          FROM ownware.usage_records GROUP BY profile_id
          ORDER BY runs DESC, profile_id ASC
        `)
        return result.rows.map((row): ProfileBreakdownRow => ({
          profileId: row.profile_id,
          runs: safeInteger(row.runs),
          tokens: safeInteger(row.tokens),
          cost: finiteNumber(row.cost),
          avgDurationMs: row.avg_duration === null ? null : Math.round(finiteNumber(row.avg_duration)),
          successRate: finiteNumber(row.success_rate),
        }))
      })
    },
    recentActivity(limit = 20) {
      return repositoryCall(context, 'usage', 'recent_activity', 'read_failed', async (client) => {
        const result = await client.query<{
          readonly id: string
          readonly profile_id: string
          readonly thread_id: string | null
          readonly model: string
          readonly total_tokens: unknown
          readonly cost_usd: unknown
          readonly duration_ms: unknown | null
          readonly success: boolean
          readonly created_at: string
        }>(`
          SELECT id, profile_id, thread_id, model, total_tokens, cost_usd,
            duration_ms, success, created_at
          FROM ownware.usage_records ORDER BY created_at DESC, id ASC LIMIT $1
        `, [limit])
        return result.rows.map((row): RecentActivityRow => ({
          id: row.id,
          profileId: row.profile_id,
          threadId: row.thread_id,
          model: row.model,
          totalTokens: safeInteger(row.total_tokens),
          costUsd: finiteNumber(row.cost_usd),
          durationMs: nullableSafeInteger(row.duration_ms),
          success: row.success,
          createdAt: row.created_at,
        }))
      })
    },
    incrementProfile(profileId, cost) {
      return repositoryCall(context, 'usage', 'increment_profile', 'write_failed', async (client) => {
        const timestamp = now()
        await client.query(`
          INSERT INTO ownware.profile_metadata (
            profile_id, use_count, total_cost, last_used_at, updated_at
          ) VALUES ($1, 1, $2, $3, $3)
          ON CONFLICT (profile_id) DO UPDATE SET
            use_count = ownware.profile_metadata.use_count + 1,
            total_cost = ownware.profile_metadata.total_cost + EXCLUDED.total_cost,
            last_used_at = EXCLUDED.last_used_at,
            updated_at = EXCLUDED.updated_at
        `, [profileId, cost, timestamp])
      })
    },
  }

  const events: CoreStorageRepositories['events'] = {
    append(input) {
      const streamKey = `${input.threadId}\u001f${input.agentId}`
      return serializeEventAppend(streamKey, () =>
        repositoryCall(context, 'events', 'append', 'write_failed', async (pool) => {
        const payload = JSON.stringify(input.payload)
        if (payload === undefined) throw new TypeError('Event payload is not JSON representable.')
        return withPostgreSqlTransaction(
          pool as PostgreSqlRootRepositoryContext['pool'],
          async (client) => {
            const sequence = await client.query<{ readonly seq: string }>(`
              INSERT INTO ownware.agent_event_streams (
                thread_id, agent_id, high_water_seq
              ) VALUES ($1, $2, 1)
              ON CONFLICT (thread_id, agent_id) DO UPDATE SET
                high_water_seq = ownware.agent_event_streams.high_water_seq + 1
              RETURNING high_water_seq::text AS seq
            `, [input.threadId, input.agentId])
            const seq = safeInteger(sequence.rows[0]?.seq ?? '0')
            await client.query(`
              INSERT INTO ownware.agent_events (
                thread_id, agent_id, parent_agent_id, seq, type, payload, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [
              input.threadId,
              input.agentId,
              input.parentAgentId,
              seq,
              input.type,
              payload,
              Date.now(),
            ])
            return seq
          },
        )
        }))
    },
    list(input) {
      return repositoryCall(context, 'events', 'list', 'read_failed', async (client) => {
        const result = await client.query<{
          readonly seq: unknown
          readonly type: string
          readonly payload: string
          readonly created_at: unknown
          readonly parent_agent_id: string | null
        }>(`
          SELECT seq, type, payload, created_at, parent_agent_id
          FROM ownware.agent_events
          WHERE thread_id = $1 AND agent_id = $2 AND seq > $3
          ORDER BY seq ASC LIMIT $4
        `, [input.threadId, input.agentId, input.since ?? 0, input.limit ?? 10_000])
        return result.rows.map((row): AgentEventRecord => ({
          seq: safeInteger(row.seq),
          type: row.type,
          payload: JSON.parse(row.payload) as unknown,
          createdAt: safeInteger(row.created_at),
          parentAgentId: row.parent_agent_id,
        }))
      })
    },
    maxSeq(threadId, agentId) {
      return repositoryCall(context, 'events', 'max_seq', 'read_failed', async (client) => {
        const result = await client.query<{ readonly max_seq: unknown }>(`
          SELECT COALESCE(high_water_seq, 0) AS max_seq
          FROM ownware.agent_event_streams WHERE thread_id = $1 AND agent_id = $2
        `, [threadId, agentId])
        return safeInteger(result.rows[0]?.max_seq ?? '0')
      })
    },
    minSeq(threadId, agentId, afterSeq, throughSeq) {
      return repositoryCall(context, 'events', 'min_seq', 'read_failed', async (client) => {
        const result = throughSeq === undefined
          ? await client.query<{ readonly min_seq: unknown | null }>(`
              SELECT min(seq) AS min_seq FROM ownware.agent_events
              WHERE thread_id = $1 AND agent_id = $2 AND seq > $3
            `, [threadId, agentId, afterSeq])
          : await client.query<{ readonly min_seq: unknown | null }>(`
              SELECT min(seq) AS min_seq FROM ownware.agent_events
              WHERE thread_id = $1 AND agent_id = $2 AND seq > $3 AND seq <= $4
            `, [threadId, agentId, afterSeq, throughSeq])
        return nullableSafeInteger(result.rows[0]?.min_seq ?? null)
      })
    },
    lastTurnEndSeq(threadId, agentId) {
      return repositoryCall(context, 'events', 'last_turn_end_seq', 'read_failed', async (client) => {
        const result = await client.query<{ readonly max_seq: unknown }>(`
          SELECT COALESCE(max(seq), 0) AS max_seq FROM ownware.agent_events
          WHERE thread_id = $1 AND agent_id = $2 AND type = 'turn.end'
        `, [threadId, agentId])
        return safeInteger(result.rows[0]?.max_seq ?? '0')
      })
    },
    hasType(threadId, agentId, type) {
      return repositoryCall(context, 'events', 'has_type', 'read_failed', async (client) => {
        const result = await client.query(`
          SELECT 1 FROM ownware.agent_events
          WHERE thread_id = $1 AND agent_id = $2 AND type = $3 LIMIT 1
        `, [threadId, agentId, type])
        return result.rows[0] !== undefined
      })
    },
    listAgents(threadId) {
      return repositoryCall(context, 'events', 'list_agents', 'read_failed', async (client) => {
        const result = await client.query<{
          readonly agent_id: string
          readonly parent_agent_id: string | null
          readonly event_count: unknown
        }>(`
          SELECT agent_id, max(parent_agent_id) AS parent_agent_id,
            count(*) AS event_count
          FROM ownware.agent_events WHERE thread_id = $1
          GROUP BY agent_id ORDER BY agent_id ASC
        `, [threadId])
        return result.rows.map((row) => ({
          agentId: row.agent_id,
          parentAgentId: row.parent_agent_id,
          eventCount: safeInteger(row.event_count),
        }))
      })
    },
    listTerminalThreadsOlderThan(cutoffIso) {
      return repositoryCall(context, 'events', 'list_terminal_threads', 'read_failed', async (client) => {
        const result = await client.query<{ readonly id: string }>(`
          SELECT id FROM ownware.threads
          WHERE status IN ('completed', 'error') AND updated_at < $1
          ORDER BY id ASC
        `, [cutoffIso])
        return result.rows.map((row) => row.id)
      })
    },
    listQuietRootThreads(cutoffMs) {
      return repositoryCall(context, 'events', 'list_quiet_root_threads', 'read_failed', async (client) => {
        const result = await client.query<{ readonly id: string }>(`
          SELECT thread_id AS id FROM ownware.agent_events
          WHERE agent_id = 'root' GROUP BY thread_id
          HAVING max(created_at) < $1 ORDER BY thread_id ASC
        `, [cutoffMs])
        return result.rows.map((row) => row.id)
      })
    },
    pruneRootStream(threadId) {
      return repositoryCall(context, 'events', 'prune_root_stream', 'write_failed', async (pool) =>
        withPostgreSqlTransaction(
          pool as PostgreSqlRootRepositoryContext['pool'],
          async (client) => {
            await client.query(`
              INSERT INTO ownware.agent_event_streams (
                thread_id, agent_id, high_water_seq
              ) SELECT thread_id, agent_id, max(seq)
                FROM ownware.agent_events
                WHERE thread_id = $1 AND agent_id = 'root'
                GROUP BY thread_id, agent_id
              ON CONFLICT (thread_id, agent_id) DO UPDATE SET
                high_water_seq = greatest(
                  ownware.agent_event_streams.high_water_seq,
                  EXCLUDED.high_water_seq
                )
            `, [threadId])
            const result = await client.query(
              `DELETE FROM ownware.agent_events WHERE thread_id = $1 AND agent_id = 'root'`,
              [threadId],
            )
            return result.rowCount ?? 0
          },
        ))
    },
    count() {
      return repositoryCall(context, 'events', 'count', 'read_failed', async (client) => {
        const result = await client.query<{ readonly count: string }>(
          'SELECT count(*)::text AS count FROM ownware.agent_events',
        )
        return safeInteger(result.rows[0]?.count ?? '0')
      })
    },
  }

  const usageEvidence = createPostgreSqlUsageEvidenceRepository(context)

  return { threads, messages, usage, usageEvidence, events }
}

/** Transaction-scoped primitive used by delegated thread authority. */
export async function createPostgreSqlThreadInTransaction(
  client: PostgreSqlPoolClient,
  profileId: string,
  workspaceId: string | undefined,
): Promise<Thread> {
  return createThreadOn(client, profileId, undefined, workspaceId)
}
