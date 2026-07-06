# SSE Patterns — Deep Agent Behavior Testing

The most critical part of the framework. Cortex's gateway streams every
agent action via Server-Sent Events. If any pattern is wrong — text not
arriving, tool calls missing, sub-agents not spawning, permissions not
prompting — the UI breaks in subtle ways.

This document is the source of truth for every SSE pattern we test.

## What is SSE in Cortex?

Server-Sent Events is an HTTP streaming protocol where the server pushes
named events to the client over a single long-lived connection. Each event
has a name (e.g., `text.delta`) and JSON data.

In Cortex, the gateway converts every `LoomEvent` from the agent loop into
an SSE event and writes it to the response stream. The frontend receives
these in real time and updates the chat UI.

```
POST /api/v1/run
  ↓
returns JSON: { threadId, agentId, status: "running" }
  ↓
GET /api/v1/threads/:threadId/agents/:agentId/events
  ↓
gateway streams events:
  event: stream.start            data: { threadId, agentId, since, maxSeqAtStart }
  event: stream.replay.complete  data: { threadId, agentId, replayedThroughSeq, liveTail, ... }
  event: text.delta      data: { text: "Hello" }
  event: text.delta      data: { text: " world" }
  event: tool.call.start data: { toolCallId, toolName, input }
  event: tool.call.end   data: { result, isError, durationMs }
  event: turn.end        data: { usage: { ... } }
  event: done            data: { status: "complete" }
```

## Gateway + Loom Event Types

| # | Event | When It Fires | Payload | Notes |
|---|-------|--------------|---------|-------|
| 1 | `stream.start` | First event of every SSE stream | `{ threadId, agentId, since, maxSeqAtStart }` | Always exactly one |
| 2 | `stream.replay.complete` | Historical replay flushed | `{ threadId, agentId, since, replayedThroughSeq, maxSeqAtStart, liveTail }` | Marks replay/live boundary |
| 3 | `text.delta` | Each chunk of streamed text | `{ text: string }` | May be batched (1-N events per response) |
| 4 | `text.complete` | Text block finished | `{ text: string }` | Marks end of a text segment |
| 5 | `thinking.delta` | Each chunk of extended thinking | `{ text: string }` | Only for thinking-enabled models |
| 6 | `thinking.complete` | Thinking block finished | `{ text: string }` | Pairs with thinking.delta |
| 7 | `tool.call.start` | Agent invokes a tool | `{ toolCallId, toolName, input }` | One per tool invocation |
| 8 | `tool.call.end` | Tool result returned | `{ toolCallId, toolName, result, isError, durationMs }` | Pairs with start |
| 9 | `agent.spawn` | Sub-agent launched | `{ agentId, profileName, task? }` | Multiple can fire in parallel |
| 10 | `agent.complete` | Sub-agent finished | `{ agentId, result, durationMs, toolCount?, turnCount? }` | Pairs with spawn |
| 11 | `permission.request` | Tool needs user approval | `{ requestId, toolName, input, reason, zoneLevel?, zoneName?, explanation? }` | Blocks until /resume |
| 12 | `permission.response` | User approved/denied | `{ requestId, granted }` | Pairs with request |
| 13 | `security.block` | Tool blocked by zone policy | `{ toolName, reason }` | Hard block, not askable |
| 14 | `error` | Stream-level error | `{ code, message, recoverable, turnIndex }` | Stream may continue or end |
| 15 | `turn.end` | Loop iteration complete | `{ turnIndex, usage: { inputTokens, outputTokens, costUsd } }` | One per turn (multi-tool runs have multiple) |
| 16 | `stream.shutdown` | Gateway is restarting | `{ reason: 'gateway_shutdown', retryAfterMs }` | Lets clients back off intentionally |
| 17 | `done` | Stream finished cleanly | `{ status: 'complete' }` | Always last event for normal completion |

## The 15 Patterns We Test

Each pattern is its own test in `journeys/sse-patterns.journey.ts` (or
will be added there as we expand). Every test:

1. Runs against the **real Anthropic API** (not mocked)
2. Saves the **complete event stream** to `fixtures/sse/<timestamp>/`
3. Validates event ordering, payloads, and accumulation
4. Includes metadata (prompt, profile, expected behavior) so the saved
   fixture can later be reviewed by an LLM (Sonnet/Haiku) for correctness

### Pattern 1: Text Streaming (Plain)
**What**: Single-turn prompt, no tools, plain text response.
**Validates**:
- `stream.start` fires exactly once
- `stream.replay.complete` fires exactly once before any live-tail events
- `text.delta` events accumulate to final text
- `turn.end` has non-zero usage
- `done` terminates stream
- Total ordering: stream.start → stream.replay.complete → delta+ → turn.end → done

### Pattern 2: Multi-Turn Context Retention
**What**: Two runs on the same thread; second run references info from first.
**Validates**:
- Both runs complete cleanly
- Second turn's response references info from first
- Thread `messageCount` reflects both turns (≥4 messages)
- `totalTokens` accumulates across runs
- **Critical**: Runtime cleared between runs (no 409 conflict)

### Pattern 3: Single Tool Call
**What**: Profile with a tool preset (e.g., `coding`); prompt asks to read a file.
**Validates**:
- `tool.call.start` event with `toolName`, `toolCallId`, `input`
- `tool.call.end` event with `result` (file contents)
- `text.delta` events appear AFTER tool call (LLM interprets result)
- Tool call appears in `messages[].tools[]` after run

### Pattern 4: Multiple Tool Calls in One Turn
**What**: Prompt that requires multiple tools (read 3 files, summarize).
**Validates**:
- Multiple `tool.call.start` / `tool.call.end` pairs
- All tool results delivered
- LLM produces final synthesis text
- Each tool's `durationMs` recorded
- `turn.end` reflects total token cost

### Pattern 5: Extended Thinking
**What**: Thinking-enabled profile with reasoning prompt.
**Validates**:
- `thinking.delta` events appear (if model supports)
- `thinking.complete` after thinking block
- Final answer in `text.delta` events
- `messages[].thinking` populated in DB

### Pattern 6: Sub-Agent (Single Helper)
**What**: Profile with one defined sub-agent; prompt explicitly asks
"use the helper to do X".

**IMPORTANT — how sub-agents actually appear on the parent SSE:**
Sub-agents are NOT standalone `agent.spawn` events on the parent wire.
They appear as `tool.call.start { toolName: "agent_spawn" }` followed
by `tool.call.end` with the result. The `agent.spawn` / `agent.complete`
lifecycle events are persisted to the `agent_events` table (under the
parent's agent_id via the lifecycle rewrite rule) but are NOT directly
emitted by the Loom loop into the parent's SSE stream.

The sub-agent's INTERNAL events (text.delta, tool.call.*, turn.*) are
captured by the AgentSpawner's `onEvent` hook → EventIngestor → SQLite
`agent_events` table under the sub-agent's own agent_id. The client accesses
these via `GET /api/v1/threads/:tid/agents/:agentId/events` when the
user clicks "View thread →" on the sub-agent card.

**Validates**:
- `tool.call.start` event with `toolName: "agent_spawn"` on parent SSE
- `tool.call.end` with `metadata.agentId` (for the modal link)
- Sub-agent's own event log has content in `agent_events` table:
  `listAgentEvents({ threadId, agentId: <sub-agent-id> })` returns > 0 rows
- Sub-agent event log contains its own tool calls (explore helper uses glob/grep)
- `agent.spawn` / `agent.complete` persisted under parent's agent_id in agent_events
- Sub-agent's agent_events stream does NOT contain agent.spawn/complete (lifecycle rewrite)
- Sub-agent record appears in parent's `messages[].subAgents[]`

### Pattern 7: Sub-Agents in Parallel (3-4 Helpers)
**What**: Profile with multiple sub-agents; prompt asks to dispatch them
in parallel ("Run helpers A, B, C simultaneously").
**Validates**:
- 3-4 `tool.call.start { toolName: "agent_spawn" }` events fire close together
- Their `tool.call.end` events arrive (possibly out of spawn order)
- Each sub-agent has its own `agentId` in `tool.call.end.metadata`
- `listAgentsForThread()` returns root + N sub-agent entries
- Each sub-agent has its own event log in `agent_events` with real content
- All results aggregated into final response
- No event loss under concurrent spawning — all sub-agent events persisted

### Pattern 8: Permission Request (HITL Approve)
**What**: Tool requires permission; test approves via /resume mid-stream.
**Validates**:
- `permission.request` event with `requestId`, `toolName`, `reason`
- `zoneLevel` + `zoneName` populated when zone security active
- Stream BLOCKS waiting for /resume
- POST `/threads/:id/resume` with `action: 'approve'` → unblocks
- `permission.response` event with `granted: true`
- Tool then executes (`tool.call.start` follows)
- Permission saved in `messages[].permissions[]` with `decision: 'approved'`

### Pattern 9: Permission Request (HITL Deny)
**What**: Same as Pattern 8 but user denies.
**Validates**:
- `permission.response` with `granted: false`
- `tool.call.start` does NOT fire
- LLM gracefully handles refusal in next turn
- Permission saved with `decision: 'denied'`

### Pattern 10: Permission Always (Persistent Approval)
**What**: User responds with `action: 'always'` for a tool.
**Validates**:
- Permission persisted to disk (`permissionStore.saveRule`)
- Next run with same tool → no permission prompt
- Zone expansion granted at session level

### Pattern 11: Security Block (Hard Block)
**What**: Tool in `never` zone — cannot be approved.
**Validates**:
- `security.block` event fires
- NO `permission.request` (not askable)
- Tool not executed
- Block reason recorded as system message

### Pattern 12: Error Recovery
**What**: Tool returns invalid input; LLM should retry or apologize.
**Validates**:
- `tool.call.end` with `isError: true`
- LLM produces follow-up `text.delta` acknowledging the error
- `turn.end` still fires
- Stream completes via `done`

### Pattern 13: Model Switching
**What**: Same prompt run on Sonnet vs Haiku profiles.
**Validates**:
- Both produce valid streams
- `turn.end` cost reflects model pricing
- Sonnet typically costs more per token than Haiku
- Both recorded in `usage_records` with correct `model` field

### Pattern 14: Profile Reload Mid-Test
**What**: Modify SOUL.md on disk, call `/profiles/:id/reload`, run.
**Validates**:
- Reload returns 200
- New personality reflected in next run's response
- Existing thread sessions are NOT affected (cached session)
- New thread on same profile DOES use new personality

### Pattern 15: Long Output Streaming
**What**: Prompt that produces 200+ tokens of output.
**Validates**:
- Many `text.delta` events (>5 typically)
- Total `text()` length reflects full response
- No truncation, no dropped events
- Stream stays connected throughout
- Keepalive pings don't pollute event stream

## Pattern Coverage Matrix

| Pattern | Status | File | Notes |
|---------|--------|------|-------|
| 1. Text streaming | ✅ DONE | sse-patterns.journey.ts | Pass |
| 2. Multi-turn | ✅ DONE | sse-patterns.journey.ts | Pass — fixed runtime cleanup bug |
| 3. Single tool | ✅ DONE | sse-patterns.journey.ts | Pass |
| 4. Multiple tools | ✅ DONE | sse-multitool.journey.ts | Pass — uses bundled coder + sandbox |
| 5. Thinking | ✅ DONE | sse-patterns.journey.ts | Pass (text-only on this model) |
| 6. Sub-agent single | ✅ DONE | sse-subagents.journey.ts | Pass — documents Loom gap (see below) |
| 7. Sub-agents parallel | ✅ DONE | sse-subagents.journey.ts | Pass — documents Loom gap |
| 8. Permission approve | ✅ DONE | sse-permissions.journey.ts | Pass |
| 9. Permission deny | ✅ DONE | sse-permissions.journey.ts | Pass — documents zone gap |
| 10. Permission always | ✅ DONE | sse-permissions.journey.ts | Pass |
| 11. Security block | ⏳ TODO | sse-permissions.journey.ts | Needs zone NEVER profile config |
| 12. Error recovery | ✅ DONE | sse-errors.journey.ts | Pass |
| 13. Model switching | ✅ DONE | sse-patterns.journey.ts | Pass |
| 14. Profile reload | ✅ DONE | sse-patterns.journey.ts | Pass |
| 15. Long output | ✅ DONE | sse-patterns.journey.ts | Pass |

## Fixture Recording

Every SSE pattern test calls `gw.recorder.recordSSE(name, stream, metadata)`.
With `RECORD_FIXTURES=1` env var set, this writes:

```
fixtures/sse/2026-04-08T13-52-39/
├── index.json                          ← Run summary
├── 01-pattern-01-text-streaming.json   ← Full event dump
├── 02-pattern-02-multi-turn-1.json
├── 03-pattern-02-multi-turn-2.json
├── 04-pattern-03-tool-use.json
├── ...
```

Each fixture file contains:
```json
{
  "recordedAt": "ISO timestamp",
  "metadata": {
    "prompt": "the actual prompt",
    "profileId": "which profile",
    "threadId": "which thread",
    "expectedBehavior": "what should happen"
  },
  "eventCount": 27,
  "eventCounts": { "text.delta": 14, "tool.call.start": 1, ... },
  "completed": true,
  "errors": [],
  "analysis": {
    "text": "full accumulated response text",
    "thinking": "any thinking content",
    "tools": [{ toolName, result, durationMs, ... }],
    "agents": [...],
    "permissions": [...],
    "usage": { inputTokens, outputTokens, costUsd }
  },
  "events": [
    { "event": "stream.start", "data": {...}, "index": 0 },
    { "event": "text.delta",   "data": {...}, "index": 1 },
    ...
  ]
}
```

## LLM-Assisted Review

Every SSE stream is saved as structured JSON with prompt + expected
behavior, so we can run an automated review using Claude.

**Two ready-to-use prompts in `fixtures/`:**

- `fixtures/REVIEW_PROMPT.txt` — Reviews ONE fixture at a time. Pass
  this as the system prompt to Sonnet/Haiku, then paste a single
  fixture JSON. Returns a structured PASS/FAIL/WARN report with
  protocol checks, content checks, and anomalies.

- `fixtures/BATCH_REVIEW_PROMPT.txt` — Reviews an entire run (all
  fixtures from one timestamped folder). Returns a per-pattern verdict
  table, critical issues list, protocol compliance summary, and an
  overall GREEN/YELLOW/RED health rating.

**The 27 protocol rules are documented in REVIEW_PROMPT.txt:**
- R1-R7: Event ordering rules
- R8-R11: Pairing rules (start/end, spawn/complete, request/response)
- R12-R18: Payload shape rules
- R19-R22: Content match rules
- R23-R25: Usage rules
- R26-R27: Error handling rules

**Workflow:**
```
1. Run tests with RECORD_FIXTURES=1
2. cd fixtures/sse/<latest-timestamp>/
3. Pick a fixture or batch all of them
4. System prompt: contents of REVIEW_PROMPT.txt or BATCH_REVIEW_PROMPT.txt
5. User prompt: "Review this fixture/run and report findings"
6. Paste the JSON
7. Read the structured report — any FAIL = real bug
```

This is the endgame: **the system reviews itself**. A QA agent profile can
be built that runs the framework, reads fixtures, and reports issues
without human intervention.

## Rules for Adding New Patterns

1. **One pattern per test** — don't combine multiple SSE patterns in one test.
2. **Always call recordSSE()** — the fixture is more valuable than the test
   itself in many cases.
3. **Always include metadata** — prompt, profileId, expectedBehavior. This
   is what the LLM reviewer reads.
4. **Use real prompts** — don't use "test" or "hello world" generically.
   Make the prompt do something verifiable.
5. **Assert on event counts AND content** — both ordering and payloads matter.
6. **Use realistic profiles** — each test should use a profile suited to
   its pattern (tools profile for tool tests, subagent profile for sub-agent
   tests, etc.).
7. **Handle batching** — Anthropic batches `text.delta` events. Don't assume
   one delta per token. Assert on accumulated text, not delta count
   (unless you're testing chunking specifically).

---

## Sub-Agent Event Streaming Architecture

Added in the agent_events infrastructure work. This is how every sub-agent
event flows from Loom to the client.

### The pipeline (5 stops)

```
Loom spawner yields LoomEvent
  ↓
Stop 1: spawner.runAgent() calls this.onEvent(event, handle.id)
  ↓
Stop 2: EventIngestor decides agent_id:
         agent.spawn/complete → rewrite to parent agent_id
         everything else      → keep on child agent_id
  ↓
Stop 3: SQLite INSERT (atomic seq assignment via transaction)
  ↓
Stop 4: EventBus.publish (in-process notification — no-op if nobody listening)
  ↓
Stop 5: SSE handler writes to response (if a client is subscribed)
```

### Key invariant: disk before wire

Stop 3 always happens before Stop 4. If the browser disconnects, every
event it missed is on disk. Reconnect with `?since=N` resumes from there.

### Two streams per sub-agent run

| Event type | Written under | Why |
|---|---|---|
| `agent.spawn` | parent's agent_id (`root`) | The client's main chat renders the sub-agent card here |
| `agent.complete` | parent's agent_id (`root`) | Card transitions to "done" state |
| Everything else | child's agent_id (`agent_*`) | The client's "View thread" modal shows the full conversation |

### SSE handler replay + live merge

The handler at `GET /threads/:tid/agents/:aid/events` does:

1. **Subscribe** to EventBus (buffer incoming events)
2. **Read** SQLite from `seq > ?since` (replay)
3. **Drain** buffer, skip `seq ≤ last-replayed` (dedup)
4. **Tail** live from bus (forward directly)

Subscribe-before-read prevents TOCTOU: no events lost between read and subscribe.

### Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /threads/:tid/agents` | List agent_ids on a thread (for modal tree) |
| `GET /threads/:tid/agents/:aid/events` | SSE replay + live tail (modal + dev picker) |
| `GET /threads/:tid/agents/:aid/events/history` | JSON snapshot (tests + exports) |
| `GET /api/v1/fixtures` | List `[fixture:*]` tagged threads (dev picker data source) |

### Code locations

| What | File |
|---|---|
| `SpawnerEventHook` type + wiring | `loom/src/agents/spawner.ts` |
| Gateway hook injection | `cortex/src/gateway/handlers/run.ts:118-140` |
| Lifecycle rewrite logic | `cortex/src/gateway/event-ingestor.ts:66-93` |
| EventBus (in-process pub/sub) | `cortex/src/gateway/event-bus.ts` |
| SSE replay + live tail handler | `cortex/src/gateway/handlers/agent-events.ts` |
| Fixtures listing handler | `cortex/src/gateway/handlers/fixtures.ts` |
| Schema (migration 006) | `cortex/src/gateway/db/schema.ts` |
| DB methods | `cortex/src/gateway/db/database.ts:240-380` |

### Tests

| Test | What it covers | API key? |
|---|---|---|
| `tests/unit/gateway/event-bus.test.ts` (16 tests) | Bus fan-out, unsubscribe, ingestor seq, lifecycle rewrite, race simulation | No |
| `tests/integration/gateway/agent-events-live.test.ts` (8 tests) | Live tail over real HTTP, replay, resume, concurrent subscribers | No |
| `tests/integration/gateway/fixtures-endpoint.test.ts` (8 tests) | Fixture listing, grouping, filtering | No |
| `tests/framework/journeys/sse-subagent-events.journey.ts` (3 tests) | Real Anthropic sub-agent → full event persistence + replay | Yes |
| `tests/framework/journeys/fixtures-batch-*.journey.ts` (48 tests) | Real fixture recording across 4 scenario batches | Yes |

---

## Fixture Replay System

Fixtures are real threads recorded by journey tests into `~/.ownware/ownware.db`.
No JSON files. No manifest. The database IS the fixture store.

### Convention

Thread titles start with `[fixture:scenario-id]`:
```
[fixture:text-simple] Plain text response, one turn
[fixture:subagent-parallel-3] Three helpers in parallel
```

### Client dev picker flow

1. `GET /api/v1/fixtures` → list all fixture scenarios
2. User picks one → the client gets `threadId`
3. `GET /api/v1/threads/:tid/agents/root/events` (SSE) → main chat replay
4. If sub-agents exist, "View thread →" uses the same endpoint with the child's `agentId`

Same code path as the production "View thread" modal. If replay works, prod works.

### Recording new fixtures

```bash
cd packages/cortex
ANTHROPIC_API_KEY=... npx vitest run tests/framework/journeys/fixtures-batch-1.journey.ts
```
