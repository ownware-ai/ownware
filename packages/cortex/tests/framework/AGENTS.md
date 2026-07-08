## Response Style

- **Be concise.** Answer directly and to the point. No preamble, no summaries, no restating what was asked.
- **No padding.** Do not explain what you are about to do — just do it. Do not recap what you just did.
- **Short by default.** Give brief answers unless the user explicitly asks for detail, an explanation, or a full breakdown.

# Cortex Agent OS — Testing Framework

This is the comprehensive testing framework for the Cortex gateway.
Any AI agent working in this directory MUST read this file first.

## Purpose

This framework ensures every API endpoint, every SSE event, every user
flow, and every edge case is tested against a REAL running gateway with
REAL API calls. No mocks. No stubs. Production behavior only.

When a UI client is built against this API, it can trust it because every
response shape, every state transition, and every error format has been
verified here.

## Architecture

```
tests/framework/
├── CLAUDE.md              ← You are here (agent instructions)
├── harness/               ← Shared test infrastructure
│   ├── gateway.ts         ← Start/stop real gateway with temp DB
│   ├── api-client.ts      ← Typed HTTP client with auth
│   ├── sse-parser.ts      ← Parse SSE text → typed event objects
│   ├── schema-validator.ts← Zod schemas for ALL response types
│   ├── fixture-recorder.ts← Save real responses as JSON fixtures
│   └── assertions.ts      ← Custom matchers
│
├── contracts/             ← Layer 1: Response shape validation
│   ├── profiles.contract.ts
│   ├── threads.contract.ts
│   ├── workspaces.contract.ts
│   ├── run.contract.ts
│   ├── dashboard.contract.ts
│   ├── mcp.contract.ts
│   ├── settings.contract.ts
│   ├── providers.contract.ts
│   └── …one per endpoint group
│
├── journeys/              ← Layer 2: Stateful user flows
│   ├── 02-profile-lifecycle.journey.ts
│   ├── 03-workspace-flow.journey.ts
│   ├── 04-single-run.journey.ts
│   ├── 05-multi-turn.journey.ts
│   ├── 06-tool-execution.journey.ts
│   ├── 07-model-switching.journey.ts
│   ├── 08-dashboard-accuracy.journey.ts
│   ├── 09-search-and-export.journey.ts
│   ├── 10-settings-persistence.journey.ts
│   ├── 12-error-handling.journey.ts
│   └── 13-isolation.journey.ts
│
├── stress/                ← Layer 3: Limits and concurrency
│   ├── concurrent-runs.stress.ts
│   ├── pagination-limits.stress.ts
│   ├── large-message.stress.ts
│   ├── rapid-fire.stress.ts
│   └── db-recovery.stress.ts
│
├── fixtures/              ← Auto-generated response snapshots
│   └── (generated at runtime by fixture-recorder)
│
└── docs/                  ← Detailed specs per layer
    ├── 01-overview.md
    ├── 02-harness-spec.md
    ├── 03-contracts-spec.md
    ├── 04-journeys-spec.md
    ├── 05-stress-spec.md
    ├── 06-adding-tests.md
    └── 07-sse-patterns.md ← READ THIS for SSE testing
```

## SSE Testing — The Critical Layer

SSE (Server-Sent Events) is how the gateway streams every agent action.
Text generation, tool calls, sub-agents, permission requests, errors —
all of it flows through SSE. If any pattern is wrong, the client chat
breaks in subtle ways.

**ALWAYS read `docs/07-sse-patterns.md` before working on SSE tests.**

It documents:
- All gateway + Loom SSE event types and their payloads
- All 15 patterns we test (text streaming, tools, sub-agents,
  parallel sub-agents, permissions HITL, security blocks, etc.)
- Fixture recording format (every stream saved to JSON for later review)
- LLM-assisted review (future: Sonnet/Haiku reviews fixtures automatically)
- Rules for adding new patterns

The implemented SSE tests live in `journeys/sse-patterns.journey.ts`.
Future agents will add `sse-subagents.journey.ts`,
`sse-permissions.journey.ts`, `sse-errors.journey.ts`.

**LLM-assisted fixture review** — two prompt templates ready to use:
- `fixtures/REVIEW_PROMPT.txt` — review one fixture at a time
- `fixtures/BATCH_REVIEW_PROMPT.txt` — review an entire run, get
  per-pattern verdict + GREEN/YELLOW/RED health rating

Both contain 27 protocol rules covering event ordering, pairing,
payload shapes, content matching, and usage. Pass as the system
prompt to Sonnet/Haiku, paste fixture JSON, get a structured
PASS/FAIL/WARN report.

## How to Run

```bash
cd packages/cortex

# Layer 1 — Contract tests (no API key needed, ~5s)
npx vitest run tests/framework/contracts/

# Layer 2 — Journey tests (NEEDS ANTHROPIC_API_KEY, ~60s)
npx vitest run tests/framework/journeys/

# Layer 3 — Stress tests (NEEDS ANTHROPIC_API_KEY, ~30s)
npx vitest run tests/framework/stress/

# Everything
npx vitest run tests/framework/
```

## Rules for Agents Working Here

1. **Every test uses the shared harness.** Never create a raw gateway
   or manual fetch call. Use `createTestGateway()` and `ApiClient`.

2. **Every response is validated against Zod schemas.** Not just
   "status 200" but every field, every type, every nullable.

3. **Contract tests NEVER depend on prior state.** Each test creates
   its own data. Journey tests are sequential by design.

4. **Real API calls only.** Tests that need LLM responses use
   `describe.skipIf(!process.env.ANTHROPIC_API_KEY)`. They are
   never mocked.

5. **Fixtures are recorded, not hand-written.** The harness saves
   real responses to `fixtures/`. Frontend devs use these for
   Storybook/component tests.

6. **Every new endpoint gets a contract test.** No exceptions.
   Every new screen flow gets a journey test.

7. **Tests must be idempotent.** Each test file creates a fresh
   temp DB. No shared state across files.

## Priority Order for Building

| Phase | What | Why First |
|-------|------|-----------|
| 1 | Harness (gateway.ts, api-client.ts, sse-parser.ts) | Everything depends on this |
| 2 | Contracts: threads, profiles, workspaces, run | Core CRUD the UI needs |
| 3 | Journeys: 04-single-run, 05-multi-turn | Validates the critical path |
| 4 | Journeys: 02-profile, 03-workspace, 06-tools | Profile + workspace flows |
| 5 | Contracts: dashboard, mcp, settings, providers | Analytics + config |
| 6 | Journeys: 07-13 (model switch, dashboard, search, etc.) | Full coverage |
| 7 | Stress tests | Scale confidence |
| 8 | Fixture generation | Frontend handoff |

## What Each Layer Catches

| Bug Type | Contract | Journey | Stress |
|----------|----------|---------|--------|
| Wrong field name/type | YES | - | - |
| Missing field in response | YES | - | - |
| Wrong HTTP status code | YES | YES | - |
| State not persisted after action | - | YES | - |
| Multi-turn context lost | - | YES | - |
| Tool calls not in messages | - | YES | - |
| Dashboard shows wrong numbers | - | YES | - |
| Data leaks across entities | - | YES | - |
| Race condition in concurrent writes | - | - | YES |
| Rate limiter not working | - | - | YES |
| Large payload handling | - | - | YES |

## Endpoints Covered (80 total)

### Health & Meta (3)
- `GET /api/v1/health`
- `GET /api/v1/app/version`
- `GET /api/v1/connectivity`

### Profiles (10)
- `GET /api/v1/profiles`
- `GET /api/v1/profiles/:profileId`
- `POST /api/v1/profiles`
- `PUT /api/v1/profiles/:profileId`
- `POST /api/v1/profiles/:profileId/reload`
- `POST /api/v1/profiles/generate`
- `POST /api/v1/profiles/:profileId/files`
- `GET /api/v1/profiles/:profileId/files`
- `DELETE /api/v1/profiles/:profileId`
- `POST /api/v1/profiles/:profileId/duplicate`

### Threads (7)
- `GET /api/v1/threads`
- `POST /api/v1/threads`
- `GET /api/v1/threads/:threadId`
- `PATCH /api/v1/threads/:threadId`
- `DELETE /api/v1/threads/:threadId`
- `GET /api/v1/threads/:threadId/messages`
- `GET /api/v1/threads/:threadId/export`

### Run / Execution (3)
- `POST /api/v1/run`
- `POST /api/v1/threads/:threadId/resume`
- `POST /api/v1/threads/:threadId/abort`

### Tools & Models (3)
- `GET /api/v1/profiles/:profileId/tools`
- `GET /api/v1/tools/catalog`
- `GET /api/v1/models`

### MCP Integration (11)
- `GET /api/v1/mcp/featured`
- `GET /api/v1/mcp/marketplace`
- `GET /api/v1/mcp/marketplace/:serverId`
- `POST /api/v1/mcp/credentials/:serverId`
- `GET /api/v1/mcp/credentials/:serverId`
- `DELETE /api/v1/mcp/credentials/:serverId`
- `GET /api/v1/profiles/:profileId/mcp`
- `POST /api/v1/profiles/:profileId/mcp`
- `DELETE /api/v1/profiles/:profileId/mcp/:serverId`
- `POST /api/v1/mcp/connect/:serverId`
- `GET /api/v1/mcp/servers`

### Workspaces (12)
- `GET /api/v1/workspaces`
- `POST /api/v1/workspaces`
- `POST /api/v1/workspaces/browse`
- `GET /api/v1/workspaces/:workspaceId`
- `PUT /api/v1/workspaces/:workspaceId`
- `DELETE /api/v1/workspaces/:workspaceId`
- `GET /api/v1/workspaces/:workspaceId/threads`
- `GET /api/v1/workspaces/:workspaceId/tabs`
- `POST /api/v1/workspaces/:workspaceId/tabs`
- `PUT /api/v1/workspaces/:workspaceId/tabs/:tabId`
- `DELETE /api/v1/workspaces/:workspaceId/tabs/:tabId`
- `GET /api/v1/workspaces/:workspaceId/files`

### Dashboard & Analytics (8)
- `GET /api/v1/dashboard`
- `GET /api/v1/dashboard/kpis`
- `GET /api/v1/dashboard/usage-chart`
- `GET /api/v1/activity`
- `GET /api/v1/storage/stats`
- `POST /api/v1/storage/clear-cache`
- `POST /api/v1/data/export`
- `GET /api/v1/dashboard/profile-breakdown`

### Settings (2)
- `GET /api/v1/settings`
- `PUT /api/v1/settings/:section`

### Providers (5)
- `GET /api/v1/providers`
- `POST /api/v1/providers`
- `POST /api/v1/providers/validate`
- `DELETE /api/v1/providers/:provider`
- `GET /api/v1/providers/:provider/key`

### Search (1)
- `GET /api/v1/search`

### Debug (2)
- `GET /api/v1/debug/events`
- `GET /api/v1/debug/events/:threadId/timeline`

## SSE Event Types (15)

| Event | Data Shape | Tested In |
|-------|-----------|-----------|
| `stream.start` | `{ threadId, agentId, since, maxSeqAtStart }` | run.contract, journey-04 |
| `text.delta` | `{ text: string }` | run.contract, journey-04/05 |
| `text.complete` | `{ text: string }` | run.contract |
| `thinking.delta` | `{ text: string }` | run.contract |
| `thinking.complete` | `{ text: string }` | run.contract |
| `tool.call.start` | `{ toolCallId, toolName, input }` | run.contract, journey-06 |
| `tool.call.end` | `{ toolCallId, toolName, result, isError, durationMs }` | run.contract, journey-06 |
| `agent.spawn` | `{ agentId, profileName, task? }` | run.contract |
| `agent.complete` | `{ agentId, result, durationMs }` | run.contract |
| `permission.request` | `{ requestId, toolName, reason, zoneLevel?, zoneName? }` | run.contract |
| `permission.response` | `{ requestId, granted }` | run.contract |
| `security.block` | `{ toolName, reason }` | run.contract |
| `stream.replay.complete` | `{ threadId, agentId, since, replayedThroughSeq, maxSeqAtStart, liveTail }` | agent-events-live, journey-04 |
| `stream.shutdown` | `{ reason: 'gateway_shutdown', retryAfterMs }` | agent-events-live |
| `error` | `{ code, message, recoverable, turnIndex }` | run.contract, journey-12 |
| `turn.end` | `{ turnIndex, usage: { inputTokens, outputTokens, costUsd } }` | run.contract, journey-04 |
| `done` | `{ status: 'complete' }` | run.contract, journey-04 |
