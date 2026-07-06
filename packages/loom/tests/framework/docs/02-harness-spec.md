# Harness Specification

## Files

| File | Purpose |
|------|---------|
| `session.ts` | `createTestSession()` — wraps Loom Session for testing |
| `event-collector.ts` | `collectEvents()` — drains AsyncGenerator into EventStream |
| `sandbox.ts` | `createSandbox()` — isolated temp workspace |
| `tools-fixture.ts` | Pre-built tool sets and custom test tools |
| `fixture-recorder.ts` | Save event streams to JSON for LLM review |
| `assertions.ts` | Custom matchers with detailed error messages |
| `index.ts` | Barrel export |

## createTestSession(opts)

Creates a fully-configured Loom Session for testing.

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `model` | string | `anthropic:claude-haiku-4-5-20251001` | Model string |
| `tools` | ToolPreset \| Tool[] | `'none'` | Tool configuration |
| `systemPrompt` | string | `'You are a concise test assistant...'` | System prompt |
| `maxTurns` | number | `5` | Safety limit |
| `maxTokens` | number | `1024` | Max output tokens |
| `maxBudgetUsd` | number | `0.10` | Cost safety limit |
| `permissionMode` | string | `'allow-all'` | `'allow-all'` \| `'deny-all'` \| `'ask'` |
| `createSandbox` | boolean | `true` | Create temp workspace |
| `enableAgentSpawning` | boolean | `false` | Create AgentSpawner |
| `recordFixtures` | boolean | env | Enable fixture recording |
| `configOverrides` | Partial\<LoomConfig\> | `{}` | Additional config |

### Returns: TestSession

| Property | Type | Description |
|----------|------|-------------|
| `session` | Session | The real Loom Session |
| `provider` | ProviderAdapter | Resolved provider |
| `tools` | Tool[] | Active tools |
| `sandbox` | Sandbox \| null | Temp workspace |
| `hitl` | HumanInTheLoop | For permission tests |
| `spawner` | AgentSpawner \| null | For sub-agent tests |
| `recorder` | FixtureRecorder | Fixture recording |
| `config` | LoomConfig | Resolved config |

### Methods

- `run(prompt, timeoutMs?)` — Submit and collect all events
- `runWithResponder(prompt, decide, timeoutMs?)` — Submit with permission auto-responder
- `submit(prompt)` — Get raw AsyncGenerator for manual processing
- `recordFixture(name, stream, metadata?)` — Record stream for review
- `cleanup()` — Release all resources

## EventStream

Returned by `collectEvents()` and `ts.run()`.

### Properties

- `events: readonly LoomEvent[]` — All events in order
- `count: number` — Event count
- `result: LoopResult | null` — Final result
- `error: Error | null` — If generator threw

### Methods

- `text()` — Accumulated text.delta content
- `thinking()` — Accumulated thinking.delta content
- `tools()` — Completed tool call records
- `agents()` — Sub-agent records
- `permissions()` — Permission records
- `usage()` — Total usage across turns
- `hasEvent(type)` — Check event presence
- `eventsOfType<T>(type)` — Get typed events
- `eventCounts()` — Event histogram
- `completed()` — Session ended without error
- `errors()` — Error events
- `recoveries()` — Recovery events
- `endReason()` — Session end reason
- `turnCount()` — Number of turns

## Tool Presets

- `'full'` — All builtin tools
- `'coding'` — Filesystem + shell
- `'readonly'` — Read-only filesystem
- `'none'` — No tools
- `'calculator'` — Calculator test tool

## Custom Test Tools

- `calculatorTool` — Deterministic math, no side effects
- `failingTool` — Always returns error
- `slowTool` — Configurable delay
- `permissionTool` — Requires HITL approval

## Assertions

All assertions throw with detailed context on failure.

### Stream Lifecycle
- `assertStreamCompleted(stream)` — Session ended without error
- `assertEndReason(stream, reason)` — Specific end reason

### Event Presence
- `assertHasEvent(stream, type)` — Event exists
- `assertNoEvent(stream, type)` — Event absent
- `assertEventCount(stream, type, count)` — Exact count

### Content
- `assertTextContains(stream, substring, caseSensitive?)` — Text includes
- `assertTextNotContains(stream, substring)` — Text excludes

### Tools
- `assertToolCalled(stream, name)` — Tool was called
- `assertToolSucceeded(stream, name)` — Tool succeeded
- `assertToolFailed(stream, name)` — Tool errored

### Ordering
- `assertEventOrder(stream, before, after)` — Event A before event B
