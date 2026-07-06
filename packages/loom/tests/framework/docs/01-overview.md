# Loom Testing Framework — Overview

## Purpose

This framework is the comprehensive, end-to-end testing system for `@ownware/loom`, the agent runtime engine. It tests every event type, every tool execution path, every sub-agent pattern, every permission flow, and every error recovery path.

## Architecture: Engine-Level Testing

Unlike the Cortex framework (which tests the HTTP gateway), this framework tests the engine directly:

```
Test Code ──→ Session.submitMessage() ──→ AsyncGenerator<LoomEvent>
           ←── yield event ←─────────────┘
           ←── yield event ←─────────────┘
           ←── yield event ←─────────────┘
```

No HTTP server. No SQLite database. No gateway routing. Direct engine access.

## Test Layers

| Layer | Directory | What It Tests | API Key? |
|-------|-----------|--------------|----------|
| **Harness** | `harness/` | Framework foundation (sandbox, collection, assertions) | No |
| **SSE Patterns** | `sse-patterns/` | Event stream patterns (13 patterns) | Yes |
| **Tools** | `tools/` | Per-tool execution (filesystem, shell, agent-spawn) | Yes |
| **Sub-agents** | `subagents/` | Agent spawning, isolation, abort | Mixed |
| **Providers** | `providers/` | Per-provider streaming behavior | Yes |
| **Stress** | `stress/` | Parallel sessions, long-running, concurrency | Yes |

## Test Count

| Category | Files | Tests |
|----------|-------|-------|
| Harness (smoke) | 1 | 7 |
| SSE Patterns | 11 | 15 |
| Tools | 3 | 9 |
| Sub-agents | 2 | 5 |
| Providers | 1 | 4 |
| Stress | 2 | 3 |
| **Total** | **22** | **46** |

## Running Tests

```bash
cd packages/loom

# All framework tests
npx vitest run tests/framework/

# Specific layer
npx vitest run tests/framework/sse-patterns/
npx vitest run tests/framework/tools/
npx vitest run tests/framework/subagents/
npx vitest run tests/framework/stress/

# Record fixtures for LLM review
RECORD_FIXTURES=1 npx vitest run tests/framework/sse-patterns/
```

## Key Design Decisions

1. **Direct Session access** — No HTTP layer between test and engine
2. **Real API calls** — Gated on `ANTHROPIC_API_KEY`, never mocked for e2e
3. **Cheap models** — Haiku by default, Sonnet only when tool compliance matters
4. **Strong system prompts** — Force tool use when testing tool paths
5. **Fixture recording** — Every real stream saved for automated LLM review
6. **Isolated sandboxes** — Each test gets its own temp directory
7. **Tolerant assertions** — Accept LLM non-determinism where safe (e.g., durationMs >= 0)
