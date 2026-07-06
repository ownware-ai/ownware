# @ownware/loom — Repository Guidelines

Guidance for working in the Loom engine package — for humans and AI tools alike.

## What This Package Is

`@ownware/loom` is the **agent runtime engine**. It's a `while(true)` loop that calls models, executes tools, and handles everything in between: streaming, retry, compaction, permissions, checkpointing, and multi-agent coordination.

Loom has **no opinions**. No default system prompt, no pre-selected tools, no baked-in safety rules. Consumers (the Cortex kernel, CLI, TUI, web) make those choices.

**Loom imports nothing from cortex.** Loom is the foundation. If a task requires a cortex-shaped or client-shaped concern, that's a signal the code belongs in another package — flag it.

## Architecture

```
src/
├── index.ts              # Public API — Loom class, exports, event helpers
├── cli.ts                # CLI runner — npx loom "prompt"
├── core/
│   ├── loop.ts           # THE HEART — while(true) agent loop (~760 lines)
│   ├── session.ts        # Session lifecycle, multi-turn state
│   ├── config.ts         # LoomConfig with defaults
│   ├── events.ts         # 27 event types (discriminated union)
│   ├── errors.ts         # Error hierarchy (Provider, Tool, Abort, etc.)
│   └── abort.ts          # AbortController utilities
├── provider/
│   ├── types.ts          # ProviderAdapter interface
│   ├── anthropic.ts      # Claude adapter
│   ├── openai.ts         # GPT/O-series adapter
│   ├── google.ts         # Gemini adapter
│   ├── registry.ts       # Provider resolution by name
│   ├── router.ts         # Model string parsing + aliases
│   └── retry.ts          # Exponential backoff + jitter
├── tools/
│   ├── types.ts          # Tool interface + defineTool()
│   ├── executor.ts       # Single tool execution lifecycle
│   ├── orchestrator.ts   # Parallel reads, serial writes
│   ├── hooks.ts          # PROGRAMMATIC per-tool interceptors (embedders; input-mutation power)
│   ├── policy.ts         # Tool allow/deny filtering
│   ├── formatter.ts      # Schema conversion per provider
│   ├── partial-json.ts   # Streaming JSON arg parser
│   └── builtins/         # readFile, writeFile, editFile, glob, grep, shell, …
├── hooks/                # LIFECYCLE hooks — session.start / user.prompt.submit /
│                         # tool.pre / tool.post / session.end / error; fn + command
│                         # specs; outcomes route through the reminder injector.
│                         # Distinct from tools/hooks.ts ON PURPOSE: input-mutation
│                         # power must never become profile-declarable.
├── reminders/            # <system-reminder> injector — model-visible runtime signals
├── permissions/          # Evaluator, HITL, session store
├── security/             # Rule presets (coding, enterprise, sandbox)
├── agents/               # Spawner, isolator, forker, coordinator, protocol
├── compaction/           # Manager, summarize, truncate, sliding window
├── messages/             # Provider-agnostic message format
├── prompt/               # Fragment-based prompt builder
├── memory/               # AGENTS.md loading, corrections, recall
├── skills/               # Skill registry, loader, matcher
├── checkpoint/           # Memory, file, postgres stores
├── backend/              # Local, sandbox, zone routing
├── mcp/                  # MCP adapter, client, manager
├── profile/              # Profile discovery, validation
└── observability/        # Logger, metrics, tracer (skeleton)
```

## Critical Files — Change with Care

| File | Why it's critical | What breaks if you change it |
|------|-------------------|------------------------------|
| `core/loop.ts` | The agent loop — everything flows through here | All agent execution |
| `core/events.ts` | Event types — the public contract for all consumers | UI clients, SDK, tests |
| `provider/types.ts` | ProviderAdapter interface | All provider adapters |
| `tools/types.ts` | Tool interface | All tools (builtin + custom) |
| `index.ts` | Public API surface | All consumers of the package |
| `core/config.ts` | LoomConfig shape | Everything that reads config |

## Tool UI Descriptor

Each built-in tool in `tools/builtins/` declares an optional
`uiDescriptor` on its `Tool` definition. The descriptor is pure data
(no React, no zod) describing how the tool should render in a client's
chat-stream — kind, summary verb + primary input field, optional
chevron preview body, optional [Open] click target.

```ts
defineTool({
  name: 'writeFile',
  category: 'filesystem',
  uiDescriptor: {
    kind: 'file-write',
    summary: { verb: 'Wrote', primaryField: 'file_path' },
    preview: { contentField: 'content', format: 'code', truncateAtLines: 10 },
    openAction: { target: 'file-pane', pathField: 'file_path' },
  },
  // ... inputSchema, execute, etc.
})
```

Eight kinds: `file-write`, `file-read`, `file-edit`, `shell`,
`search`, `image`, `external-action`, `conversational`. The
`conversational` kind opts a tool out of inline chat-row rendering —
clients route it to their own card surface (ask_user → a question
card, agent_spawn → a sub-agent card, etc.). Use it for tools whose
"rendering" is a dialog or panel, not a one-line summary.

**Rule:** every new builtin declares a `uiDescriptor`. Clients render
the descriptor via a generic descriptor-driven renderer (no client
code change required). The descriptor types live in `tools/types.ts` —
pure data, mirrored by cortex's `ToolUIDescriptorSchema` (the wire
validator at the gateway boundary).

**Don't change the descriptor type without an architecture review.**
It's a contract: cortex parses it with zod, UI clients read it across
the wire, and consumers in TUI/SDK rely on its stability. Adding a
new optional field is fine; renaming or removing one is not.

## Testing

```bash
npm test              # All tests
npm run test:unit     # Unit only (fast, no API keys)
npm run test:e2e      # E2E (needs ANTHROPIC_API_KEY / OPENROUTER_API_KEY)
npm run typecheck     # Type check without building
```

### Test Locations

- `tests/unit/` — provider, permissions, agents, compaction, messages, checkpoint
- `tests/integration/` — provider streaming, permissions flow, compaction strategies
- `src/__tests__/unit/` — memory, skills, profile, security, mcp
- `src/__tests__/integration/` — prompt assembly, skill lifecycle
- `src/__tests__/e2e/` — real API agent execution

### Patterns

- Mock providers: use `createMockProvider()` from `tests/helpers/mock-provider.ts`
- Mock messages: use `userMsg()`, `assistantMsg()` from `tests/helpers/fixtures.ts`
- API tests: wrap in `describe.skipIf(!process.env.ANTHROPIC_API_KEY)` (or the relevant key)
- Keep API test prompts short and `maxTokens` low to minimize cost

## What Goes Here vs. Cortex Kernel

| Loom (this package) | Cortex (`packages/cortex/`) |
|---|---|
| Agent loop execution | Profile loading from disk |
| Provider adapters | System prompt assembly |
| Tool execution + orchestration | Tool preset resolution |
| Streaming events | Context fragments (git, os) |
| Compaction strategies | Security level → rule set mapping |
| Retry + error recovery | Checkpoint store selection |
| Message format | Gateway HTTP types |
| Security primitives | Custom tool loading from files |

**Rule: Loom runs agents. Cortex configures them.**

## Runtime-Agnostic Execution

- Loom is **ONE executor**, not the only one. External CLI runtimes implement the same `ProviderAdapter`-shaped contract at a higher level (the runtime level, not the provider level).
- **Runtime selection happens in Cortex**, never in Loom. Loom stays opinion-free — it receives a session config and executes it. Whether this session is one of many possible runtimes is invisible to Loom.
- If a profile is assigned to an external runtime, **Loom's loop is not used for that profile** — the external CLI's loop is, shelled out by the Cortex daemon. Loom still governs every profile assigned to `loom-local`.
- Do not add external-CLI code paths inside Loom. Do not add runtime discovery, CLI detection, or shell-out logic. Those belong in Cortex's daemon layer.
- Events, tool schemas, and permission decisions from Loom are the canonical shape. External runtimes are expected to translate their native events into Loom's event vocabulary at the Cortex boundary — not the other way around.

## PR Checklist

- [ ] `npm run build && npm run typecheck && npm test` passes
- [ ] Tests added for new functionality
- [ ] No new runtime dependencies added
- [ ] If events or the public API changed → update the relevant docs
- [ ] CLAUDE.md updated if module responsibilities changed
