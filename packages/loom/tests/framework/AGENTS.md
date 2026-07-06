## Response Style

- **Be concise.** Answer directly and to the point. No preamble, no summaries, no restating what was asked.
- **No padding.** Do not explain what you are about to do — just do it. Do not recap what you just did.
- **Short by default.** Give brief answers unless the user explicitly asks for detail, an explanation, or a full breakdown.

# Loom Testing Framework — Agent Instructions

This is the comprehensive testing framework for `@ownware/loom`, the agent runtime engine.
Any AI agent working in this directory MUST read this file first.

## Purpose

This framework ensures every event type, every tool execution path, every sub-agent pattern,
every compaction strategy, every permission flow, and every error recovery path is tested
against the REAL Loom engine with REAL API calls. No mocks for end-to-end tests. No stubs
for integration tests. Production behavior only.

When the Cortex gateway and UI clients are built on top of Loom, they can trust that
every event shape, every state transition, and every edge case has been verified here.

## How This Differs from the Cortex Framework

The Cortex framework (`packages/cortex/tests/framework/`) tests the **HTTP gateway layer** —
it starts a server, makes HTTP requests, parses SSE over the wire. It does NOT test Loom
internals exhaustively.

This framework tests the **engine itself** end-to-end:

| Cortex Framework | This Framework (Loom) |
|-----------------|----------------------|
| Entry: HTTP POST /run | Entry: Session.submitMessage() |
| Events: SSE text parsing | Events: AsyncGenerator<LoomEvent> directly |
| Interaction: POST /resume | Interaction: hitl.respond() direct call |
| State: SQLite DB reads | State: session.getState() direct |
| Scope: Gateway routing, auth | Scope: Loop, tools, agents, compaction, zones |

## Architecture

```
tests/framework/
├── CLAUDE.md              ← You are here
├── harness/               ← Shared test infrastructure
│   ├── session.ts         ← createTestSession() — wraps Session
│   ├── event-collector.ts ← Drain AsyncGenerator → typed EventStream
│   ├── sandbox.ts         ← Temp workspace for file operations
│   ├── tools-fixture.ts   ← Pre-built tool sets for tests
│   ├── fixture-recorder.ts← Save event streams to JSON for review
│   ├── assertions.ts      ← Custom matchers for events
│   └── index.ts           ← Barrel export
│
├── docs/                  ← Specifications
│   ├── 01-overview.md
│   ├── 02-harness-spec.md
│   ├── 03-events-spec.md
│   ├── 04-providers-spec.md
│   ├── 05-tools-spec.md
│   ├── 06-subagents-spec.md
│   └── 07-adding-tests.md
│
├── sse-patterns/          ← Event stream pattern tests
│   ├── 01-text-streaming.sse.ts
│   ├── 02-multi-turn.sse.ts
│   ├── 03-single-tool.sse.ts
│   ├── 04-multi-tool.sse.ts
│   ├── 05-thinking.sse.ts
│   ├── 06-subagent-single.sse.ts
│   ├── 07-subagent-parallel.sse.ts
│   ├── 08-permission-approve.sse.ts
│   ├── 09-permission-deny.sse.ts
│   ├── 10-permission-always.sse.ts
│   ├── 11-security-block.sse.ts
│   ├── 12-error-recovery.sse.ts
│   └── 13-compaction.sse.ts
│
├── tools/                 ← Per-tool execution tests
│   ├── filesystem.tool.ts
│   ├── shell.tool.ts
│   ├── agent-spawn.tool.ts
│   └── web-fetch.tool.ts
│
├── subagents/             ← Sub-agent pattern tests
│   ├── single.subagent.ts
│   ├── parallel.subagent.ts
│   ├── nested.subagent.ts
│   ├── background.subagent.ts
│   ├── abort.subagent.ts
│   └── isolation.subagent.ts
│
├── providers/             ← Per-provider streaming tests
│   ├── anthropic.provider.ts
│   ├── openai.provider.ts
│   └── google.provider.ts
│
├── mcp/                   ← MCP server integration
│   ├── connect.mcp.ts
│   └── tool-call.mcp.ts
│
├── stress/                ← Scale + concurrency
│   ├── parallel-sessions.stress.ts
│   ├── compaction-trigger.stress.ts
│   └── long-running.stress.ts
│
└── fixtures/              ← Recorded event streams
    ├── REVIEW_PROMPT.txt
    └── BATCH_REVIEW_PROMPT.txt
```

## How to Run

```bash
cd packages/loom

# All framework tests (mocked — no API key needed)
bun test tests/framework/

# With real API (needs ANTHROPIC_API_KEY)
ANTHROPIC_API_KEY=sk-... bun test tests/framework/

# Specific layer
bun test tests/framework/sse-patterns/
bun test tests/framework/tools/
bun test tests/framework/subagents/
bun test tests/framework/stress/

# Record fixtures for LLM review
RECORD_FIXTURES=1 bun test tests/framework/sse-patterns/
```

## Rules for Agents Working Here

1. **Every test uses the shared harness.** Never create a raw Session or
   manual provider. Use `createTestSession()` and `EventStream`.

2. **Every event stream is collected via `collectEvents()`.** Never manually
   drain the AsyncGenerator. The collector handles edge cases.

3. **Real API calls are gated.** Tests that need LLM responses use
   `describe.skipIf(!HAS_KEY)`. They are never mocked in e2e tests.

4. **Fixtures are recorded, not hand-written.** The harness saves real
   event streams to `fixtures/`. Feed them to Sonnet for automated review.

5. **Every new tool gets a tool test.** Every new event type gets an SSE
   pattern test. Every new sub-agent pattern gets a subagent test.

6. **Tests must be idempotent.** Each test file creates its own sandbox.
   No shared state across files.

7. **No `any` types in test code.** Use the typed helpers from the harness.

8. **Keep API tests cheap.** Use haiku where possible. Use small prompts
   and low maxTokens. Every cent counts across thousands of test runs.

## Entry Point

The harness provides one main function:

```typescript
import { createTestSession } from './harness/index.js'

const ts = await createTestSession({
  model: 'anthropic:claude-haiku-4-5-20251001',
  tools: 'coding',          // preset: 'coding' | 'readonly' | 'full' | Tool[]
  maxTurns: 5,
  permissionMode: 'allow-all',
})

const stream = await ts.run('What is 2 + 2?')
assertStreamCompleted(stream)
assertTextContains(stream, '4')

await ts.cleanup()
```

## Event Types (27 total)

| Event | When | Key Fields |
|-------|------|------------|
| `session.start` | Loop begins | sessionId, model |
| `session.end` | Loop completes | reason, totalUsage, turnCount |
| `turn.start` | Turn begins | turnIndex |
| `turn.end` | Turn completes | stopReason, usage |
| `text.delta` | Text chunk | text |
| `text.complete` | Text segment end | text |
| `thinking.delta` | Thinking chunk | text |
| `thinking.complete` | Thinking end | text |
| `tool.call.start` | Tool invoked | toolCallId, toolName, input |
| `tool.call.args_delta` | Streaming args | toolCallId, delta |
| `tool.call.progress` | Tool progress | toolCallId, message |
| `tool.call.end` | Tool result | toolCallId, result, isError, durationMs |
| `compaction.start` | Compaction begins | strategy, preTokenCount |
| `compaction.end` | Compaction done | pre/postTokenCount |
| `recovery` | Error recovery | reason, attempt, detail |
| `permission.request` | Approval needed | requestId, toolName, reason |
| `permission.response` | User decided | requestId, granted |
| `agent.spawn` | Sub-agent launched | agentId, profileName |
| `agent.complete` | Sub-agent done | agentId, result, durationMs |
| `checkpoint.saved` | State saved | checkpointId |
| `security.block` | Hard block | toolName, level, reason |
| `security.redact` | Output redacted | toolName, redactedCount |
| `audit.entry` | Audit log | toolName, decision |
| `error` | Stream error | code, message, recoverable |

## Adding a New Test

1. Identify which layer the test belongs to (sse-patterns, tools, subagents, etc.)
2. Create the file with the appropriate suffix (`.sse.ts`, `.tool.ts`, `.subagent.ts`)
3. Use `createTestSession()` for setup
4. Use `collectEvents()` or `ts.run()` for execution
5. Use typed assertions from `assertions.ts`
6. Call `recorder.record()` if the test produces event streams worth reviewing
7. Clean up with `ts.cleanup()`

## Production Quality Bar

- Every test has a timeout aligned with expected runtime
- No `console.log` in production tests
- No `any` types
- Every async operation is awaited
- Every test that calls real APIs is gated on env vars
- Every fixture has metadata (prompt, expectedBehavior)
- Tests catch regressions in: streaming, tools, sub-agents, permissions, abort, recovery
