# Adding New Tests

## Step-by-Step

### 1. Identify the Layer

| If testing... | Create in... | Suffix |
|--------------|-------------|--------|
| Event stream patterns | `sse-patterns/` | `.sse.ts` |
| Tool execution | `tools/` | `.tool.ts` |
| Sub-agent behavior | `subagents/` | `.subagent.ts` |
| Provider streaming | `providers/` | `.provider.ts` |
| Scale/concurrency | `stress/` | `.stress.ts` |
| MCP integration | `mcp/` | `.mcp.ts` |

### 2. Write the Test

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import {
  createTestSession,
  type TestSession,
  assertStreamCompleted,
  assertHasEvent,
  assertTextContains,
} from '../harness/index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

describe.skipIf(!HAS_KEY)('Your Test Suite', () => {
  let ts: TestSession

  afterEach(async () => {
    if (ts) await ts.cleanup()
  })

  it('your test case', async () => {
    ts = await createTestSession({
      tools: 'none',       // Choose appropriate tools
      maxTurns: 3,          // Keep low for safety
      maxTokens: 256,       // Keep low for cost
    })

    const stream = await ts.run('Your prompt here')

    // Always record for LLM review
    ts.recordFixture('your-test-name', stream, {
      prompt: 'Your prompt here',
      expectedBehavior: 'What should happen',
    })

    // Assert
    assertStreamCompleted(stream)
    assertTextContains(stream, 'expected text')
  }, 60_000) // Always set a timeout
})
```

### 3. Tips for Reliable Tests

**System prompts matter.** If the test requires tool use, include:
```typescript
systemPrompt: 'You MUST use the calculate tool for math. NEVER compute in your head.'
```

**Use Sonnet for tool compliance.** Haiku sometimes ignores tool instructions:
```typescript
model: 'anthropic:claude-sonnet-4-20250514'
```

**Tolerate LLM non-determinism.** Don't assert on exact text:
```typescript
// Bad: exact match
expect(stream.text()).toBe('The answer is 42')

// Good: contains check
assertTextContains(stream, '42')
```

**Tolerate fast tools.** `durationMs` can be 0 for sync tools:
```typescript
expect(tool.durationMs).toBeGreaterThanOrEqual(0)  // Not > 0
```

**Permission tests need HITL registration.** `createTestSession` auto-registers a no-op handler. Use `runWithResponder` for interactive flows.

### 4. Update Documentation

- Add event type coverage to `docs/03-events-spec.md`
- Add pattern description to `CLAUDE.md` if it's a new SSE pattern
- Run the full suite to verify no regressions: `npx vitest run tests/framework/`

### 5. Run and Verify

```bash
# Your test
npx vitest run tests/framework/your-layer/your-test.sse.ts

# Full suite
npx vitest run tests/framework/

# With fixtures
RECORD_FIXTURES=1 npx vitest run tests/framework/
```

## Naming Conventions

- Files: `NN-descriptive-name.{sse,tool,subagent,stress,provider,mcp}.ts`
- Suites: `describe('SSE Pattern N: Name', ...)`
- Tests: `it('specific behavior under test', ...)`
- Fixtures: `ts.recordFixture('NN-pattern-name', stream, metadata)`
