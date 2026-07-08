# Journey Tests Specification

Journey tests validate full user flows — stateful, sequential, each step
depends on the last. They mirror what a real user does in the UI client.

## Key Difference from Contracts

- **Contracts**: "Does GET /threads return the right shape?" (isolated)
- **Journeys**: "After onboarding, creating a profile, running an agent,
  does the dashboard show the correct numbers?" (stateful chain)

## Test Files

### (removed) `journeys/01-onboarding.journey.ts`

The legacy desktop first-run flow (`/session/state`, `/onboarding/*`) was
deleted from the gateway; this journey went with it. Provider-key setup is
covered by the providers contract tests.

### `journeys/02-profile-lifecycle.journey.ts`

**Screen**: Profiles
**API key needed**: NO (CRUD only)

```
Step 1: Create profile from scratch
  → POST /profiles { name: 'test-coder', description: 'A coding agent', model: 'anthropic:claude-sonnet-4-20250514' }
  → Verify: returned ProfileDetail has correct fields

Step 2: Add personality (SOUL.md)
  → POST /profiles/test-coder/files { type: 'soul_md', content: 'You are a helpful coder.' }
  → GET /profiles/test-coder → soulMd matches

Step 3: Add memory (AGENTS.md)
  → POST /profiles/test-coder/files { type: 'agents_md', content: 'User prefers TypeScript.' }
  → GET /profiles/test-coder → agentsMd matches

Step 4: Add a skill
  → POST /profiles/test-coder/files { type: 'skill', skillName: 'review', content: '---\nname: review\n---\nReview code for bugs.' }
  → GET /profiles/test-coder → skills[] has 'review'

Step 5: Attach MCP server
  → POST /profiles/test-coder/mcp { serverId: 'test-server' }
  → GET /profiles/test-coder/mcp → server listed

Step 6: Update model
  → PUT /profiles/test-coder { config: { model: 'anthropic:claude-haiku-4-5-20251001' } }
  → GET /profiles/test-coder → model updated

Step 7: List all profiles
  → GET /profiles → test-coder in list
  → Verify: useCount=0, totalCost=0 (never run yet)

Step 8: Reload from disk
  → POST /profiles/test-coder/reload
  → Verify: no error, profile refreshed

Step 9: Set metadata
  → (via state) setProfileMetadata('test-coder', { icon: 'code', color: '#7C5CFC', category: 'Development' })
  → GET /profiles → test-coder has icon, color, category
```

### `journeys/03-workspace-flow.journey.ts`

**Screen**: Home → Workspace
**API key needed**: NO

```
Step 1: Create workspace
  → POST /workspaces { path: tmpDir, name: 'My Project' }
  → Verify: id starts with ws_, status='active'

Step 2: Verify in list
  → GET /workspaces → workspace present
  → GET /workspaces?status=active → workspace present
  → GET /workspaces?status=archived → workspace NOT present

Step 3: Get workspace detail
  → GET /workspaces/:id → WorkspaceDetail
  → profiles[]: empty (no runs yet)
  → activeThreads: 0, totalThreads: 0

Step 4: Browse files
  → POST /workspaces/browse { path: tmpDir }
  → Verify: returns FileTreeNode[] with real directory contents

Step 5: Create threads in workspace
  → POST /threads { profileId: 'mini', workspaceId: wsId }
  → POST /threads { profileId: 'mini', workspaceId: wsId }
  → GET /workspaces/:id → totalThreads: 2

Step 6: List workspace threads
  → GET /workspaces/:id/threads → 2 threads

Step 7: Pin workspace
  → PUT /workspaces/:id { pinned: true }
  → GET /workspaces → pinned workspace appears first

Step 8: Archive workspace
  → PUT /workspaces/:id { status: 'archived' }
  → GET /workspaces?status=active → NOT present
  → GET /workspaces?status=archived → present

Step 9: Reopen by creating again with same path
  → POST /workspaces { path: tmpDir }
  → Verify: returns existing workspace (reactivated), not duplicate

Step 10: Verify lastOpenedAt updated
  → GET /workspaces/:id → lastOpenedAt recent
```

### `journeys/04-single-run.journey.ts`

**Screen**: Chat
**API key needed**: YES (real Anthropic call)

```
Step 1: Setup
  → Create workspace + thread + use 'mini' profile

Step 2: Run prompt
  → POST /run { prompt: 'Say exactly: JOURNEY FOUR PASSED', threadId, profileId: 'mini' }
  → Response returns { threadId, agentId }
  → GET /threads/:threadId/agents/:agentId/events
  → Parse SSE stream

Step 3: Validate SSE events
  → stream.start present with correct threadId + agentId
  → stream.replay.complete marks replay/live boundary
  → text.delta events exist and accumulate to response
  → turn.end has usage with inputTokens > 0
  → done event terminates stream
  → Response contains "JOURNEY FOUR PASSED"

Step 4: Verify thread state
  → GET /threads/:id
  → messageCount >= 2 (user + assistant)
  → totalTokens > 0
  → totalCost > 0
  → lastMessagePreview set

Step 5: Verify messages
  → GET /threads/:id/messages
  → First message: role=user, content matches prompt
  → Last message: role=assistant, content matches response

Step 6: Verify usage tracking
  → GET /dashboard → todayRuns >= 1
  → getUsageTimeSeries('7d') → today bucket has runs >= 1
  → getRecentActivity(1) → entry matches this run

Step 7: Verify profile usage
  → getProfileMetadata('mini') → useCount >= 1, totalCost > 0
```

### `journeys/05-multi-turn.journey.ts`

**Screen**: Chat (continued conversation)
**API key needed**: YES

```
Step 1: Run 1 — establish context
  → POST /run { prompt: 'Remember this secret code: DELTA-7742', threadId }
  → Verify: response acknowledges the code

Step 2: Run 2 — test context retention
  → POST /run { prompt: 'What was the secret code I told you?', threadId }
  → Verify: response contains 'DELTA-7742'

Step 3: Verify accumulation
  → GET /threads/:id
  → messageCount >= 4 (2 user + 2 assistant)
  → totalTokens from run 2 > run 1 (growing context)

Step 4: Verify usage records
  → getRecentActivity(10) → at least 2 entries for this thread
```

### `journeys/06-tool-execution.journey.ts`

**Screen**: Chat with tool calls
**API key needed**: YES

```
Step 1: Create a tool-capable profile
  → POST /profiles { name: 'tool-tester', tools: { preset: 'coding' } }

Step 2: Run with tool-triggering prompt
  → POST /run { prompt: 'List the files in the current directory', profileId: 'tool-tester' }
  → Parse SSE

Step 3: Validate tool events
  → tool.call.start event present (toolName like 'listFiles' or 'shell')
  → tool.call.end event present with result
  → text.delta events AFTER tool call (LLM interprets result)

Step 4: Verify tool calls in messages
  → GET /threads/:id
  → messages[].tools[] has at least 1 entry
  → tool entry has: name, input, output, durationMs
```

### `journeys/07-model-switching.journey.ts`

**Screen**: Profile editor (model selector)
**API key needed**: YES

```
Step 1: Run with Claude Sonnet
  → POST /run { prompt: 'Say HI', profileId uses Sonnet model }
  → Verify: SSE works, response received

Step 2: Run with Claude Haiku
  → POST /run { prompt: 'Say HI', profileId uses Haiku model }
  → Verify: SSE works, response received

Step 3: Compare
  → getProfileBreakdown() → both profiles in results
  → Haiku cost < Sonnet cost (per token pricing)
  → Both have runs: 1
```

### `journeys/08-dashboard-accuracy.journey.ts`

**Screen**: Home / Dashboard
**API key needed**: NO (uses data from prior journeys, or seeds its own)

```
Step 1: Seed known data
  → Create 3 usage records with known tokens/cost
  → Across 2 profiles

Step 2: Verify dashboard stats
  → GET /dashboard → todayRuns = 3, todayTokens matches sum
  → todayCost matches sum
  → byProfile has 2 entries, runPercent adds to 100

Step 3: Verify KPIs
  → getKPIs('7d') → Tokens card value = sum of tokens
  → Cost card value = sum of costs
  → Runs card value = 3
  → Each card has 12-point sparkline

Step 4: Verify time series
  → getUsageTimeSeries('7d') → today bucket matches
  → Other 6 days are zero (fresh DB)

Step 5: Verify profile breakdown
  → getProfileBreakdown() → 2 rows
  → Runs, tokens, cost match per-profile sums

Step 6: Verify recent activity
  → getRecentActivity(10) → 3 entries, newest first
```

### `journeys/09-search-and-export.journey.ts`

**Screen**: Command Palette, Thread export

```
Step 1: Create searchable data
  → Threads with titles: 'Alpha Project', 'Beta Feature', 'Alpha Bug Fix'
  → Workspaces: 'Alpha Workspace'

Step 2: Search threads
  → GET /search?q=Alpha → finds 2 threads + 1 workspace
  → Results sorted by score

Step 3: Search profiles
  → GET /search?q=mini → finds mini profile

Step 4: No results
  → GET /search?q=zzzznonexistent → empty array

Step 5: Export
  → GET /threads/:id/export?format=markdown → valid markdown
  → GET /threads/:id/export?format=json → { thread, messages }
```

### `journeys/10-settings-persistence.journey.ts`

**Screen**: Settings

```
Step 1: Set appearance
  → PUT /settings/appearance { theme: 'dark', fontSize: '14' }
Step 2: Set defaults
  → PUT /settings/defaults { model: 'anthropic:claude-sonnet-4-20250514' }
Step 3: Read back
  → GET /settings → appearance.theme='dark', defaults.model=...
Step 4: Update
  → PUT /settings/appearance { theme: 'light' }
  → GET /settings → theme='light', fontSize still '14'
```

### `journeys/11-session-recovery.journey.ts`

**Screen**: Crash recovery

```
Step 1: Create state (workspace + threads)
Step 2: Save session
Step 3: Stop gateway
Step 4: Start new gateway with same DB
Step 5: GET /session/state → hasSession: true
Step 6: POST /session/restore → correct counts
Step 7: Verify workspaces reactivated
```

### `journeys/12-error-handling.journey.ts`

**Screen**: All (error states)

```
✓ POST /run missing prompt → 400 ApiError
✓ POST /run invalid profile → 404 ApiError
✓ GET /threads/nonexistent → 404 ApiError
✓ POST /workspaces invalid path → 400 ApiError
✓ PUT /settings/x with number → 400 ApiError
✓ POST /run on busy thread → 409 ApiError
✓ All errors match { error: string, message: string } shape
```

### `journeys/13-isolation.journey.ts`

**Screen**: Data integrity

```
✓ Profile A's cost ≠ Profile B's cost
✓ Workspace 1's threads not in workspace 2
✓ Thread messages don't leak
✓ Delete thread → messages gone (cascade)
✓ Delete workspace → threads orphaned, not deleted
✓ Each profile's useCount tracks independently
```
