# Contract Tests Specification

Contract tests verify that every endpoint returns the exact shape
defined in `types.ts`. They catch wrong field names, missing fields,
wrong types, and unexpected nulls.

## Principle

For every endpoint:
1. Make the call
2. Assert status code
3. Validate response body against Zod schema (EVERY field)
4. Optionally record as fixture

## Test Files

### `contracts/profiles.contract.ts`

```
GET /api/v1/profiles
  ✓ returns 200
  ✓ body is ProfileSummary[]
  ✓ each entry has: id, name, description, model, tags, toolCount
  ✓ each entry has: hasSkills, hasMcp (boolean)
  ✓ each entry has: icon, color, category (string | null)
  ✓ each entry has: useCount (number), totalCost (number)
  ✓ each entry has: lastUsedAt (string | null)
  ✓ each entry has: helperCount (number), isLive (boolean)

GET /api/v1/profiles/:profileId
  ✓ returns 200 for existing profile
  ✓ body is ProfileDetail (extends ProfileSummary)
  ✓ has config (object), soulMd (string | null), agentsMd (string | null)
  ✓ has skills[] with { name, description, content }
  ✓ has path (string)
  ✓ returns 404 for non-existent profile
  ✓ 404 body matches ApiError shape

POST /api/v1/profiles
  ✓ returns 201 for valid input
  ✓ body is ProfileDetail
  ✓ profile appears in subsequent GET /profiles
  ✓ returns 400 for missing name

PUT /api/v1/profiles/:profileId
  ✓ returns 200 for valid update
  ✓ updated fields reflected in GET
  ✓ returns 404 for non-existent profile

POST /api/v1/profiles/:profileId/reload
  ✓ returns 200
  ✓ profile data refreshed from disk

GET /api/v1/profiles/:profileId/files
  ✓ returns 200
  ✓ body lists soul.md, agents.md, skills/
```

### `contracts/threads.contract.ts`

```
GET /api/v1/threads
  ✓ returns 200
  ✓ body is PaginatedResult<Thread>
  ✓ has items[], total, offset, limit
  ✓ default limit is 50
  ✓ each thread has: id, profileId, workspaceId, title, status
  ✓ each thread has: messageCount, totalTokens, totalCost
  ✓ each thread has: lastMessagePreview, createdAt, updatedAt

GET /api/v1/threads?profileId=X
  ✓ filters by profile
  ✓ total reflects filtered count

GET /api/v1/threads/:threadId
  ✓ returns 200 with thread + messages[]
  ✓ messages is ThreadMessage[]
  ✓ each message has: id, role, content, timestamp
  ✓ optional fields: tools[], subAgents[], permissions[], thinking, usage
  ✓ returns 404 for non-existent thread

POST /api/v1/threads
  ✓ returns 201
  ✓ body is Thread with messageCount=0

PATCH /api/v1/threads/:threadId
  ✓ returns 200
  ✓ only specified fields changed
  ✓ updatedAt advanced

DELETE /api/v1/threads/:threadId
  ✓ returns 204
  ✓ thread gone from GET /threads
  ✓ messages cascade-deleted

GET /api/v1/threads/:threadId/messages
  ✓ returns ThreadMessage[]
  ✓ ordered by created_at ASC

GET /api/v1/threads/:threadId/export?format=markdown
  ✓ returns text/markdown
  ✓ contains thread title, profile, messages

GET /api/v1/threads/:threadId/export?format=json
  ✓ returns { thread, messages }
```

### `contracts/workspaces.contract.ts`

```
GET /api/v1/workspaces
  ✓ returns PaginatedResult<Workspace>
  ✓ each workspace has: id, name, path, status, pinned
  ✓ each workspace has: lastProfileId, lastOpenedAt, createdAt, updatedAt

GET /api/v1/workspaces?status=active
  ✓ filters by status

GET /api/v1/workspaces/:id
  ✓ returns WorkspaceDetail
  ✓ includes profiles[], activeThreads, totalThreads

POST /api/v1/workspaces
  ✓ returns 201 for valid path
  ✓ returns 400 for non-existent path
  ✓ returns 200 (reactivated) for archived workspace with same path

PUT /api/v1/workspaces/:id
  ✓ updates name, pinned, status

DELETE /api/v1/workspaces/:id
  ✓ returns 204

POST /api/v1/workspaces/browse
  ✓ returns FileTreeNode[] for valid path
```

### `contracts/run.contract.ts`

```
POST /api/v1/run (bootstrap)
  ✓ returns 200 JSON with { threadId, agentId, status: 'running' }
  ✓ client then opens GET /api/v1/threads/:threadId/agents/:agentId/events
  ✓ SSE response has Content-Type: text/event-stream
  ✓ first event is stream.start with { threadId, agentId, since, maxSeqAtStart }
  ✓ text.delta events have { text: string }
  ✓ turn.end events have { turnIndex, usage: { inputTokens, outputTokens, costUsd } }
  ✓ replay boundary emits stream.replay.complete
  ✓ last meaningful event is done with { status: 'complete' }
  ✓ usage.inputTokens > 0
  ✓ usage.outputTokens > 0

POST /api/v1/run (error cases)
  ✓ returns 400 for missing prompt
  ✓ returns 404 for non-existent profile
  ✓ returns 404 for non-existent thread
  ✓ returns 409 for thread with active run

POST /api/v1/threads/:threadId/abort
  ✓ returns 200 with { aborted: true }
  ✓ returns 404 for no active session
```

### `contracts/dashboard.contract.ts`

```
GET /api/v1/dashboard
  ✓ returns DashboardStats
  ✓ has: activeAgents, todayRuns, todayTokens, todayCost, weekCost
  ✓ has: workspaceCount, byProfile[], byWorkspace[]
  ✓ byProfile entries have: profileId, runCount, runPercent, weekCost
  ✓ byWorkspace entries have: workspaceId, workspaceName, threadCount, weekCost

(Internal — validated via state methods until HTTP endpoints exist)
  getKPIs(range)
    ✓ returns DashboardKPIs with 4 cards
    ✓ each card has: label, value, unit, delta, sparkline[12]
    ✓ range echoed back

  getUsageTimeSeries(range)
    ✓ 24h → 24 hourly buckets
    ✓ 7d → 7 daily buckets
    ✓ 30d → 30 daily buckets
    ✓ each bucket has: date, tokens, cost, runs

  getProfileBreakdown()
    ✓ returns ProfileBreakdownRow[]
    ✓ has: profileId, runs, tokens, cost, avgDurationMs, successRate

  getRecentActivity(limit)
    ✓ returns RecentActivityRow[]
    ✓ ordered newest first
    ✓ respects limit
```

### `contracts/mcp.contract.ts`

```
GET /api/v1/mcp/servers (legacy)
  ✓ returns PaginatedResult<MCPServerRecord>
  ✓ each server has profileIds[]

GET /api/v1/mcp/marketplace
  ✓ returns MCPMarketplaceEntry[]

GET /api/v1/profiles/:profileId/mcp
  ✓ returns ProfileMCPStatus[]

POST /api/v1/mcp/credentials/:serverId
  ✓ saves credentials
  ✓ returns 200

GET /api/v1/mcp/credentials/:serverId
  ✓ returns credential status
```

### `contracts/settings.contract.ts`

```
GET /api/v1/settings
  ✓ returns grouped object { section: { key: value } }

PUT /api/v1/settings/:section
  ✓ returns 200 for valid string values
  ✓ returns 400 for non-string values
  ✓ returns 400 for empty body
  ✓ persists values (verify with GET)
```

### `contracts/providers.contract.ts`

```
GET /api/v1/providers
  ✓ returns ProviderInfo[]
  ✓ each has: id, name, hasKey, models[]

POST /api/v1/providers
  ✓ saves encrypted key
  ✓ returns key hint (first 4 + last 4 chars)

POST /api/v1/providers/validate
  ✓ tests real API connectivity
  ✓ returns { reachable: boolean, latencyMs }

DELETE /api/v1/providers/:provider
  ✓ removes key
```

### `contracts/onboarding.contract.ts`

```
POST /api/v1/onboarding/role
  ✓ saves user role
  ✓ returns 200

POST /api/v1/onboarding/complete
  ✓ marks onboarding done
  ✓ returns 200
```

### `contracts/session.contract.ts`

```
GET /api/v1/session/state
  ✓ returns SessionState or PersistedSessionState
  ✓ has: hasSession, workspaces?, tabs?

POST /api/v1/session/restore
  ✓ returns { workspaceCount, tabCount }
```
