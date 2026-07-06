# Loom

**Loom is the open-source agent runtime inside [Ownware](https://github.com/ownware-ai/ownware) — the full engine, exposed as a standalone library.**

> Part of Ownware ("build your own AI agent"). Loom is the model-agnostic engine; [`@ownware/cortex`](https://www.npmjs.com/package/@ownware/cortex) wraps it into the profiles + gateway you run as `ownware serve`. Use Loom directly when you want just the engine.

It gives you the agent loop that reads your files, runs commands, drives browsers, calls MCP servers, and spawns sub-agents — all streaming, all auditable — with 7-level security classification that blocks dangerous *combinations* of calls (like "read a secret, then make a network request") that other frameworks miss. Zero framework dependencies, strict TypeScript, bring your own model.

---

What you get out of the box:

- **Deep filesystem access** — `readFile`, `writeFile`, `editFile`, `listFiles`, `glob`, and a **ripgrep-powered** `grep` with regex, multiline, `.gitignore` respect, and output caps
- **Shell execution** with a 5-level security classifier (L1 never allowed, L5 PII detection always on)
- **Full browser automation** (Chrome DevTools Protocol: navigate, click, type, screenshot, snapshot, scroll, evaluate JS, tab management)
- **MCP clients** over stdio / SSE / HTTP / WebSocket with OAuth2 PKCE
- **Sub-agent spawning** with parallel fan-out, pipelines, and map-reduce
- **Streaming everything** — text deltas, thinking deltas, tool progress, cache status, context pressure, security blocks — as an `AsyncGenerator`
- **Zone-based security** (7 levels: `safe`, `workspace`, `build`, `network`, `external`, `machine`, `never`) with combination rules (e.g. "read secret + network call" → block)
- **Input guards** — declarative per-tool policies (`allowPrefixes`, `denyPatterns`, shell L-levels) that reject bad calls before execution, no permission prompt, no LLM-trust loop
- **Lifecycle hooks** — run your code at `session.start`, before/after every tool (`tool.pre` can veto), `session.end`, and `error`; outcomes are fed back to the model as reminders
- **Automatic compaction** when context fills; **checkpointing** to memory, file, or Postgres
- **Prompt caching, pricing math, retry with jitter, stall detection, provider fallback chain** — all built in

Zero framework dependencies. Strict TypeScript. Built-in providers for Anthropic, OpenAI, and Google — bring your own for anything else.

---

## Install

```bash
npm install @ownware/loom
# or
bun add @ownware/loom
```

`@vscode/ripgrep` auto-installs the correct platform binary for `grep` via postinstall. No manual setup.

---

## 60-second quick start

```ts
import { Loom } from '@ownware/loom'

const result = await Loom.run('anthropic:claude-sonnet-4-6', 'What is 2+2?')
console.log(result.text)   // "4"
console.log(result.usage)  // { inputTokens, outputTokens, cacheReadTokens, model, costUsd, ... }
```

Stream events instead of collecting:

```ts
for await (const event of Loom.stream('sonnet', 'Summarize package.json', {
  tools: filesystemTools,
})) {
  if (event.type === 'text.delta') process.stdout.write(event.text)
  if (event.type === 'tool.call.start') console.log(`→ ${event.toolName}(${JSON.stringify(event.input)})`)
}
```

Set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` in your env.

---

## Call patterns

Loom gives you four equivalent ways to run an agent. Pick the one that matches how much control you need.

### 1. One-shot — `Loom.run`

```ts
const { text, usage, turnCount } = await Loom.run('sonnet', 'Explain monads')
```

### 2. Streaming — `Loom.stream`

```ts
for await (const e of Loom.stream('gpt-4o', 'Write a haiku')) {
  if (e.type === 'text.delta') process.stdout.write(e.text)
}
```

### 3. Builder — `Loom.create(...).build()`

Composable, re-runnable, good for shaping an agent once and invoking many times.

```ts
const agent = Loom.create('sonnet')
  .withSystemPrompt('You are a legal analyst')
  .withTools(filesystemTools)
  .withMaxTurns(20)
  .withPermissionMode('ask')
  .build()

for await (const e of agent.run('Analyze this contract')) { /* ... */ }
```

### 4. Full session — `new Session(...)`

Multi-turn conversations that remember prior context. Compaction and checkpointing live at this layer.

```ts
import { Session, AnthropicProvider, builtinTools } from '@ownware/loom'

const session = new Session({
  config: createDefaultConfig('sonnet'),  // a model string, not an object
  provider: new AnthropicProvider(),
  tools: builtinTools,
})

for await (const e of session.submitMessage('Remember: code is ALPHA-7')) {}
for await (const e of session.submitMessage('What is the code?')) {
  if (e.type === 'text.delta') process.stdout.write(e.text) // "ALPHA-7"
}
```

---

## Built-in tools

Import the whole kit, a category, or pick individual tools.

```ts
import {
  builtinTools,          // everything below
  filesystemTools,       // readFile, writeFile, editFile, listFiles, glob, grep
  shellTools,            // shell_execute
  browserTools,          // 17 browser tools
  memoryTools,           // memory_store, memory_search, memory_forget
} from '@ownware/loom'
```

| Category | Tool | Read-only | What it does |
|---|---|---|---|
| **Filesystem** | `readFile` | ✓ | Line-numbered read with offset/limit, binary detection, sensitive-file gate |
| | `writeFile` | — | Atomic create-only (`wx` flag) — refuses to overwrite, blocks `.ssh/` etc. |
| | `editFile` | — | Exact-string replace; errors on ambiguous match unless `replace_all` |
| | `listFiles` | ✓ | Directory listing, dirs first, human-readable sizes |
| | `glob` | ✓ | Pattern match (`**/*.ts`), mtime-sorted, VCS/`node_modules` pruned, `hidden:true` opt-in |
| | `grep` | ✓ | **ripgrep**-backed; literal / regex / multiline; `.gitignore` respected; per-line truncation (default 500 chars); 20MB output cap; falls back to JS walker if rg unavailable |
| **Shell** | `shell_execute` | — | Subprocess with 5-level security classifier, 120s default timeout, stdout+stderr capture |
| **Browser** | `browser_navigate` / `_click` / `_type` / `_screenshot` / `_snapshot` / `_evaluate` / `_tab_list` / `_tab_open` / `_tab_close` / `_console` / `_hover` / `_select` / `_press_key` / `_drag` / `_fill_form` / `_wait` / `_scroll` | mixed | Full Chrome DevTools Protocol |
| **Memory** | `memory_store` / `memory_search` / `memory_forget` | mixed | Pluggable store — inject your own backend (sqlite, vector DB, …) |
| **Web** | `web_search` | ✓ | Pluggable strategies: DuckDuckGo (no key), Brave, Tavily |
| | `web_fetch` | ✓ | HTTP GET with html→text conversion hook |
| **Media** | `image_generate` | — | Pluggable provider — bring your own (DALL·E, SD, …) |
| | `speech_synthesize` / `speech_transcribe` | mixed | TTS / STT — pluggable |
| **Coordination** | `agent_spawn` | ✓ | Spawn a sub-agent with scoped tools, own prompt, optional faster model |
| | `ask_user` | ✓ | Structured human-in-the-loop question |

Every tool has a `description`, an `inputSchema`, `requiresPermission`, `isReadOnly`, optional `timeoutMs`, and an `execute(input, context)` (or `execute(input, context)` as an `async*` generator for progress).

---

## Custom tools

```ts
import { defineTool } from '@ownware/loom'

const weather = defineTool({
  name: 'get_weather',
  description: 'Get current weather for a city.',
  category: 'custom',
  isReadOnly: true,
  requiresPermission: false,
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  async execute(input) {
    const { city } = input as { city: string }
    const r = await fetch(`https://api.example.com/weather?city=${city}`)
    return { content: await r.text(), isError: false }
  },
})

await Loom.run('sonnet', 'What is the weather in Tokyo?', { tools: [weather] })
```

Generator tools can emit `tool.call.progress` events mid-execution:

```ts
async function* execute(input, ctx) {
  yield { type: 'progress', message: 'step 1/3' }
  // ... work ...
  yield { type: 'progress', message: 'step 2/3' }
  return { content: 'done', isError: false }
}
```

---

## Security — three orthogonal layers

Loom has **no opinions** baked in. You compose the posture you want from three independent systems.

```
tools.allow / tools.deny          →  which tools EXIST
ToolGuard (compileToolPolicies)   →  which INPUTS those tools accept
Zones + permissions               →  auto-run vs ask vs never (at call time)
```

### Layer 1 — input guards (declarative per-tool policies)

Compile a list of policy specs → one wrapped tool list. Input that fails the guard is rejected before the tool runs. The agent sees a normal `isError: true` result with a `metadata.policy: 'deny'` flag — no permission prompt, no LLM trust.

```ts
import {
  Loom,
  compileToolPolicies,
  wrapToolsWithGuards,
  shellTools,
} from '@ownware/loom'

const guards = compileToolPolicies([
  {
    kind: 'shell',
    tool: 'shell_execute',
    allowPrefixes: ['ls', 'git log', 'git status', 'git diff'],
    denyPatterns: ['^rm ', '^sudo ', 'git (push|reset|add|commit)'],
    allowDangerous: false,   // leave shell L2 closed (rm -rf, sudo, chmod 777)
    allowInjection: false,   // leave shell L3 closed ($( ) and backticks)
  },
])

const tools = wrapToolsWithGuards(shellTools, guards)
await Loom.run('sonnet', 'list files', { tools })
```

**Policy fields:**

| Field | Role |
|---|---|
| `tool` | Tool name or glob (`shell_execute`, `mcp__github__*`, `*`) |
| `kind` | `"shell"` (only kind today; more coming) |
| `allowPrefixes` | If non-empty, command MUST start with one of these — whitelist |
| `denyPatterns` | Regex sources; any match → hard deny. Highest priority. |
| `allowDangerous` | Opens shell L2 (`rm -rf`, `sudo`, `chmod 777`) |
| `allowInjection` | Opens shell L3 (`$(...)`, backticks) |

**Enforcement order:** `denyPatterns` → `allowPrefixes` (if set) → shell L1/L2/L3/L4/L5.
**L1 / L4 / L5 cannot be bypassed, even with `allowDangerous: true`:**

- **L1** `mkfs`, `reboot`, `shutdown`, fork bombs
- **L4** exfiltration patterns (`curl | sh` from untrusted hosts)
- **L5** PII redaction in output

**What the agent sees on deny:**

```ts
{
  isError: true,
  content: 'Blocked by policy: command not in profile allowlist',
  metadata: {
    policy: 'deny',
    reason: '...',
    ruleId: 'shell:shell_execute:allowlist',
    tool: 'shell_execute',
  },
}
```

The agent reads the reason and adapts. No approval prompt surfaces to the human — the policy is the floor.

### Layer 2 — zones (runtime classification)

Every tool call is classified into one of 7 zones at call time. Your policy says which zones auto-allow, which ask the user, which are forbidden.

| Level | Zone | Examples |
|---:|---|---|
| 0 | **safe** | Read workspace, read-only commands, web search, save memory |
| 1 | **workspace** | Write / edit / delete in workspace, local git ops |
| 2 | **build** | Shell in workspace, package install, run tests |
| 3 | **network** | Fetch URLs, API calls, download packages |
| 4 | **external** | `git push`, create PR, deploy, send messages, MCP writes |
| 5 | **machine** | Read outside workspace, browser with auth, cloud CLI |
| 6 | **never** | `rm -rf /`, `sudo`, `.ssh` writes — always blocked |

```ts
import { ZoneManager, createZoneConfig, ZoneLevel } from '@ownware/loom'

const zones = new ZoneManager(createZoneConfig({
  maxAutoZone: ZoneLevel.BUILD,       // auto-allow up to "build"
  maxAskZone: ZoneLevel.EXTERNAL,     // ask human for "network" / "external"
  // anything above "external" is denied outright
}))
```

**Combination rules** catch multi-step attacks the model couldn't predict: read a secret (`safe`) + then make a network call (`network`) within N turns → **blocked**. Ships with `DEFAULT_COMBINATION_RULES`; extend or replace.

### Layer 3 — permissions (human-in-the-loop)

When a zone decision is "ask," the `HumanInTheLoop` class pauses the loop, emits a `permission.request` event, and waits for your UI to answer.

```ts
import { HumanInTheLoop, SessionPermissionStore, PermissionEvaluator } from '@ownware/loom'

const hitl = new HumanInTheLoop({ timeoutMs: 60_000 })  // auto-deny after 60s (optional)

// Register a handler, then respond(requestId, approved) with the decision.
hitl.onApprovalNeeded(async (req) => {
  const approved = await myUi.askUser(req.toolCall.name, req.reason)  // your UI
  hitl.respond(req.requestId, approved)
})
```

Decisions can be remembered for the session (`SessionPermissionStore`), cached by tool, or always re-ask.

### Rule presets — fast start

```ts
import {
  PermissionEvaluator,
  CODING_AGENT_RULES,      // dev tools, blocks destructive cmds, flags secrets
  ENTERPRISE_AGENT_RULES,  // legal/finance, strict shell, PII detection
  SANDBOX_AGENT_RULES,     // minimal, only blocks OS-level destruction
} from '@ownware/loom'

const evaluator = new PermissionEvaluator({ safetyRules: CODING_AGENT_RULES })
```

---

## Lifecycle hooks

Bind your own logic to fixed points of the agent loop — audit every action, veto a tool call, meter every model call, feed context back to the model, archive every run. Events: `session.start`, `tool.pre`, `tool.post`, `model.pre` (before each provider call; its `additionalContext` lands on that very request), `model.post` (per-call usage/cost/stop-reason/tool-count — the metering moment), `session.end`, `error` (plus `user.prompt.submit`, reserved — declared but not fired yet).

```ts
import {
  Session, HookRegistry, HookRuntime,
  ReminderInjector, createDefaultRegistry,
} from '@ownware/loom'

const registry = new HookRegistry()

// Guard: block a tool call before it runs — the model gets a denied
// result with your reason and adapts instead of retrying.
registry.register('tool.pre', {
  type: 'fn',
  name: 'no-prod',
  fn: (ctx) =>
    ctx.event === 'tool.pre' && String(ctx.toolInput['file_path'] ?? '').startsWith('/srv/prod')
      ? { continue: false, reason: 'Production paths are off-limits.' }
      : { continue: true },
})

// Observe: session.end fires on EVERY exit — normal end, abort, limits,
// error — with the terminal reason. An audit trail that skips aborted
// runs is not an audit trail.
registry.register('session.end', {
  type: 'fn',
  name: 'archive',
  fn: async (ctx) => {
    if (ctx.event === 'session.end') await archive(ctx.sessionId, ctx.reason)
    return { continue: true }
  },
})

// One injector, shared by runtime and session — hook outcomes become
// <system-reminder> fragments the model reads on its next turn.
const reminders = new ReminderInjector(createDefaultRegistry())
const hooks = new HookRuntime({ registry, reminders })
const session = new Session({ config, provider, tools, hooks, reminders })
```

`command` specs follow the standard shell-hook convention (context as JSON on stdin, exit 0 allows, non-zero blocks, stdout JSON upgrades to a structured result) — the same contract as git hooks. `tool.pre` can block; `tool.post`, `session.end`, and `error` are informational (post-hooks can't roll back). Hooks are steering and observability — the security floor stays in guards and zones above.

Serving profiles through the gateway instead of embedding? Declare hooks in `agent.json` — including `approve`, which pauses the run for a human decision from the web UI, terminal, or a chat channel. See [docs/agents/hooks.md](../../docs/agents/hooks.md).

---

## MCP (Model Context Protocol)

Loom is an MCP client. Connect to any MCP server over any transport and adopt its tools and resources.

```ts
import { MCPManager, adaptAllMCPTools } from '@ownware/loom'

const mcp = new MCPManager()

await mcp.addServer({
  name: 'github',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN! },
})

await mcp.addServer({
  name: 'linear',
  transport: 'sse',
  url: 'https://mcp.linear.app/sse',
  auth: { type: 'oauth2', preset: 'linear' },  // PKCE flow ships in-box
})

const mcpTools = adaptAllMCPTools(await mcp.getTools())

await Loom.run('sonnet', 'Create an issue for the bug I just fixed', {
  tools: [...builtinTools, ...mcpTools],
})
```

**Transports:** `stdio` (local processes), `sse`, `http`, `websocket`.
**Auth:** OAuth2 PKCE with `startOAuthFlow` / `refreshTokens` — works with Linear, Notion, Atlassian, and any RFC-7636 server.

Resource tools (`createListResourcesTool`, `createReadResourceTool`) expose MCP resources as read-only tools for the agent.

---

## Streaming events (the public contract)

Loom's loop is a provider-agnostic `AsyncGenerator<LoomEvent>`. Every event has a `type` discriminator. Filter in a `for await` — no event emitter, no callbacks.

| Event type | When |
|---|---|
| `session.start` / `session.end` | Top-level session boundaries |
| `turn.start` / `turn.end` | Each model call |
| `text.delta` / `text.complete` | Streamed assistant text |
| `thinking.delta` / `thinking.complete` | Extended thinking (Claude) |
| `tool.call.start` / `tool.call.args_delta` / `tool.call.progress` / `tool.call.end` | Full tool call lifecycle |
| `tool_result.drop` | A tool result dropped by compaction to reclaim context |
| `agent.spawn` / `agent.complete` | Sub-agent orchestration |
| `permission.request` / `permission.response` | HITL tool approvals |
| `credential.request` / `credential.response` | HITL credential prompts |
| `compaction.start` / `compaction.end` | Auto-compaction |
| `context.pressure` | Context approaching the window |
| `cache.status` | Prompt-cache hit / miss / write |
| `checkpoint.saved` | Session state persisted |
| `security.block` / `security.redact` | Zone or rule-triggered denial / redaction |
| `audit.entry` | Structured audit-log entry |
| `recovery` | Recoverable retry after provider error |
| `error` | Fatal |

Helpers:

```ts
import { collectText, collectResult, filterEvents } from '@ownware/loom'

const text = await collectText(agent.run('Hello'))
const { text, usage, turnCount } = await collectResult(agent.run('Hello'))
for await (const e of filterEvents(agent.run('Hello'), 'tool.call.end')) {
  console.log(`${e.toolName} took ${e.durationMs}ms`)
}
```

---

## Providers

Five built in and auto-registered — Anthropic, OpenAI, Google, OpenRouter, and Ollama (local, keyless):

```ts
await Loom.run('anthropic:claude-sonnet-4-6', '...')
await Loom.run('openai:gpt-4o', '...')
await Loom.run('google:gemini-2.5-pro', '...')
await Loom.run('openrouter:...', '...')
await Loom.run('ollama:llama3.2', '...')   // local, no API key

// Short aliases
await Loom.run('sonnet', '...')
await Loom.run('opus', '...')
await Loom.run('haiku', '...')
```

**Custom base URL / proxy:**

```ts
import { OpenAIProvider, registerProvider } from '@ownware/loom'

registerProvider(new OpenAIProvider({ baseURL: 'https://my-proxy.com/v1' }))
```

**Your own provider:** implement the `ProviderAdapter` interface — its core is `async *stream(request): AsyncGenerator<ProviderChunk>`, plus `name`, `countTokens`, `supportsFeature`, `formatTools`, and `getModelPricing` — then `registerProvider(new MyProvider())`. Works with every feature in the library.

**Fallback chain** — primary fails, secondary takes over mid-stream:

```ts
import { createFallbackProvider, AnthropicProvider, OpenAIProvider } from '@ownware/loom'

const provider = createFallbackProvider([
  new AnthropicProvider(),
  new OpenAIProvider(),
])
```

**Prompt caching & pricing:**

```ts
import { calculateCost, getModelPricing } from '@ownware/loom'
// getModelPricing(provider, model) → ModelPricing | null;
// calculateCost(pricing, inputTokens, outputTokens, cacheReadTokens?, cacheCreationTokens?)
const pricing = getModelPricing('anthropic', 'claude-sonnet-4-6')
const cost = pricing ? calculateCost(pricing, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens) : 0
```

---

## Compaction

When history approaches the context window, Loom rewrites it:

```ts
const config = {
  compaction: {
    trigger: { type: 'fraction', threshold: 0.80 },  // fire at 80% full
    retain: { type: 'messages', count: 6 },           // keep last 6 turns raw
    strategy: 'summarize',                            // or 'truncate' / 'sliding_window' / 'hierarchical'
  },
}
```

`strategy` is one of the named presets (`summarize` · `truncate` · `sliding_window` · `hierarchical` · `snapshot`) — a string, not an interface you implement.

---

## Checkpointing

```ts
import { FileCheckpointStore } from '@ownware/loom'

const store = new FileCheckpointStore('./checkpoints')
const session = new Session({ config, provider, tools, checkpoint: store })

// Auto-saved after each tool turn. Restore later:
const snap = await store.load(sessionId)
session.restore(snap)
```

Ships with `MemoryCheckpointStore`, `FileCheckpointStore`. Implement `CheckpointStore` for Postgres, S3, Redis, anything.

---

## Prompt assembly — fragments & CLAUDE.md

Loom builds the system prompt from composable fragments. You can use the defaults, replace specific slots, or build from scratch.

```ts
import {
  PromptBuilder,
  createIdentityFragment,
  createToolsFragment,
  createSafetyFragment,
  createMemoryFragment,
  createContextFragment,
} from '@ownware/loom'

const prompt = new PromptBuilder()
  .addFragment(createIdentityFragment(soulMd))                  // (soulMd: string | null, label?)
  .addFragment(createToolsFragment(tools))                     // (tools: Tool[], options?)
  .addFragment(createSafetyFragment())                         // built-in "act with care" rules (label?)
  .addFragment(createMemoryFragment(agentsMd))                 // (agentsMd: string, label?)
  .addFragment(createContextFragment({ cwd: process.cwd() })) // { date?, platform?, cwd?, gitBranch? }
  .build()
```

**Project instructions / `AGENTS.md`.** `createContextFragment` emits environment facts only (date, platform, cwd, git branch) — it does **not** read any file. To inject `AGENTS.md`/project instructions, read the file yourself and pass its contents to `createMemoryFragment(agentsMd)`. `createSafetyFragment()` injects Loom's built-in "act with care" guidance (its only argument is an optional `label`).

**Skills** — bundle reusable prompt + tool + guide triples. `createSkillsFragment(skills)` injects them and `skills/matcher.ts` activates them based on the user message.

---

## Multi-agent coordination

```ts
import {
  fanOut, pipeline, mapReduce,
  AnthropicProvider, builtinTools, createDefaultConfig,
} from '@ownware/loom'

// Coordination options every worker runs with. fanOut/pipeline build the
// isolated AgentSpawner internally from these — you don't pass a spawner.
// Each worker is an AgentSpec ({ name, systemPrompt?, model?, tools? }) — no `prompt` field.
const opts = { provider: new AnthropicProvider(), tools: builtinTools, config: createDefaultConfig('sonnet') }

// Parallel fan-out
const results = await fanOut(
  [
    { name: 'security-review', systemPrompt: 'Audit auth.ts for CVEs; list findings.' },
    { name: 'perf-review',     systemPrompt: 'Find hot loops in loop.ts; list them.' },
    { name: 'style-review',    systemPrompt: 'Check naming conventions; list issues.' },
  ],
  opts,
) // → AgentResult[]

// Sequential pipeline: researcher → writer → reviewer. One initial `input`
// string flows through; each stage receives the previous stage's output.
const final = await pipeline(
  [
    { name: 'researcher', systemPrompt: 'Gather the key facts on the topic you are given.' },
    { name: 'writer',     systemPrompt: 'Draft a clear article from the facts you receive.' },
    { name: 'reviewer',   systemPrompt: 'Critique and polish the draft you receive.' },
  ],
  'The history of the printing press',
  opts,
) // → AgentResult
```

Sub-agents get **isolated tool lists, messages, and config** (`isolator.ts`) — no context leakage back to the parent.

---

## CLI

```bash
npx loom "What is 2+2?"
npx loom --model openai:gpt-4o "Explain quantum computing"
npx loom --tools "Read package.json and explain this project"
npx loom --system "You are a poet" "Write a haiku about TypeScript"
npx loom --tools --max-tokens 32000 "Fix the bug in src/index.ts"
npx loom --json "Hello" | jq '.type'
```

| Flag | Purpose |
|---|---|
| `-m, --model` | Model string. Default: auto-selected (first provider key in env, else local Ollama). |
| `-t, --tools` | Enable built-in tools (filesystem + shell) |
| `-s, --system` | Custom system prompt |
| `--max-turns` | Max model calls (default: 50) |
| `--max-tokens` | Max output tokens per turn (default: 16384) |
| `--mode` | Permission mode (`ask` / `auto`) — parsed but not yet wired into the CLI run; use the library API for real permission control |
| `-v, --verbose` | Show sessions, turns, permissions, compaction |
| `--json` | Emit events as JSONL |
| `-h, --help` | Show usage |

---

## Architecture at a glance

```
User ──► Session ──► Loop ──► Provider.stream() ──► Tools ──► Loop ──► ...
            ▲          ▲           ▲                  ▲
         Checkpoint  Compaction  Permissions       Guards + Zones
```

- `core/loop.ts` — the `while(true)` loop. Everything flows through here.
- `core/events.ts` — the public event contract (discriminated union).
- `provider/*` — Anthropic / OpenAI / Google adapters + fallback + retry + pricing.
- `tools/*` — tool interface, executor, orchestrator (parallel reads, serial writes), guards.
- `permissions/*` + `zones/*` + `security/*` — the three security layers.
- `hooks/*` + `reminders/*` — lifecycle hooks + the model-visible reminder loop-back.
- `mcp/*` — client, manager, transports, OAuth2 PKCE.
- `agents/*` — spawner, isolator, forker, coordinator, channel protocol.
- `compaction/*` + `checkpoint/*` — history management + state persistence.

Loom is the engine inside [Ownware](https://github.com/ownware-ai/ownware); the full engine docs live in the monorepo under [`docs/engine/`](https://github.com/ownware-ai/ownware/tree/main/docs/engine).

---

## Design principles

- **No framework dependencies.** Raw Node. Direct SDK calls. No Express, no LangChain, no magic.
- **Strict TypeScript.** `strict: true`. No `any`. No `@ts-ignore`. `readonly` on every config field.
- **AsyncGenerator everywhere.** Consumers pull at their own pace. No event emitters.
- **Discriminated unions.** Every event, error, and config variant has a `type` field.
- **Fail loudly.** Invalid state throws immediately; silent degradation is a bug.
- **Unopinionated engine.** No default system prompt, no pre-selected tools, no baked-in safety rules. Consumers compose the posture they need.

---

## License

Apache 2.0 — see [LICENSE](./LICENSE).
