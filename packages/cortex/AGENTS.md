# @ownware/cortex — Repository Guidelines

Guidance for working in the Cortex kernel package — for humans and AI tools alike.

## What This Package Is

`@ownware/cortex` is the **kernel** of the Ownware agent OS. It sits between the engine (Loom) and the consumers (CLI, TUI, web, gateway). Its job: take an agent profile directory and produce a fully-configured, ready-to-run Loom session.

```
Profile Directory          @ownware/cortex              @ownware/loom
─────────────────          ─────────────────             ──────────────
agent.json           →     loadProfile()           →
SOUL.md              →     assembleAgent()          →     Session
AGENTS.md            →       ↳ resolve provider     →       .submitMessage()
skills/              →       ↳ assemble tools        →       yields LoomEvents
                             ↳ build system prompt
                             ↳ apply security
                             ↳ create checkpoint store
```

**Security boundary lives in cortex.** Credentials, tokens, OAuth state,
zone enforcement, permission decisions — all live here. Never log
secrets. Never leak them to clients. Never store plaintext.

**Cortex never imports from a UI client.** It serves clients via the
gateway. Inversions are a signal the code belongs elsewhere — flag it.

## Architecture

```
src/
├── index.ts              # Public API — all exports
├── profile/
│   ├── schema.ts         # Zod-validated profile config (ProfileSchema)
│   ├── loader.ts         # Load profile from disk directory
│   ├── assembler.ts      # Convert LoadedProfile → Loom Session config
│   ├── registry.ts       # Discover, cache, and manage profiles
│   ├── context.ts        # Git, OS, date, project context fragments
│   ├── custom-tools.ts   # Dynamic tool loading from TS/JS files
│   ├── tool-policy.ts    # Allow/deny glob patterns for tools
│   ├── hooks.ts          # Declarative agent.json hooks → Loom HookRuntime (trust-gated)
│   ├── env.ts            # Environment variable resolution
│   └── timeout.ts        # Human-readable timeout parsing (5m, 2h, 1d)
├── connector/            # Connectors: builtin / MCP / Composio, credentials vault
├── credential/           # Runtime credential handling (.env import, redaction)
├── gateway/              # HTTP/2 gateway: handlers, db, SSE, session runner
├── memory/               # DB-backed memory with approval gating
├── permissions/          # Permission store + zones
├── schedules/            # Cron-style proactive schedules
├── team/                 # Board-orchestrated multi-agent teams
├── terminal/             # Agent PTY + user PTY
└── tools/                # Kernel-level tools (currently empty — the legacy desktop pane tools were removed)
```

### Key Module Responsibilities

| File | What it does | When to change it |
|------|-------------|-------------------|
| `profile/schema.ts` | Defines every field in agent.json/yaml with Zod validation | Adding new profile config options |
| `profile/loader.ts` | Reads profile directory, validates, loads markdown + skills | Changing how profiles are discovered on disk |
| `profile/assembler.ts` | Wires everything into Loom config — THE critical path | Changing how profiles become running agents |
| `profile/registry.ts` | Profile discovery, caching, lazy loading | Adding new profile sources |
| `profile/context.ts` | System prompt context fragments (git, os, date, project) | Adding new context types |
| `profile/hooks.ts` | Compiles `agent.json` `hooks` into the engine `HookRuntime` + shared `ReminderInjector`. Loud-or-dead validation at assembly; observe actions (`log`/`webhook`/`save_json`) never block; `approve` (onToolCall only, optional `tools` globs) PAUSES the run on the injected `requestHookApproval` channel — the gateway wires it to the thread's permission HITL, so the decision arrives from the web UI, terminal chat, or a messaging channel via `POST /threads/:id/resume`; no channel wired → fail-closed deny; `command` actions are operator-gated (`OWNWARE_ALLOW_COMMAND_HOOKS=1`, default OFF — a downloaded profile must never mean shell execution); `OWNWARE_DISABLE_HOOKS=1` kill switch; `OWNWARE_HOOK_WEBHOOK_ALLOWLIST` narrows egress; payloads scrubbed via the credential redactor. Session wiring: pass BOTH `hookRuntime` and `reminderInjector` from `AssembledAgent`. | Adding hook actions/events or changing the trust policy |
| `gateway/types.ts` | HTTP wire format types (Thread, Profile, etc.) | Changing the gateway API |
| `gateway/state.ts` | Thread/session state over SQLite | Adding persistence backends |

## Profile Directory Structure

```
profiles/my-agent/
├── agent.json          # Required — validated by ProfileSchema
├── SOUL.md             # Optional — system prompt (identity, rules, persona)
├── AGENTS.md           # Optional — memory (learned preferences, context)
├── skills/             # Optional — skill definitions (markdown + frontmatter)
│   └── summarize.md
└── tools/              # Optional — custom tool implementations (TS/JS)
    └── my-tool.ts
```

### agent.json Structure

```json
{
  "name": "my-agent",
  "description": "What this agent does",
  "model": "anthropic:claude-sonnet-4-20250514",
  "tools": {
    "preset": "coding",
    "allow": ["readFile", "editFile", "shell.*"],
    "deny": ["shell_execute"],
    "custom": [{ "file": "./tools/my-tool.ts" }]
  },
  "security": {
    "level": "standard",
    "permissionMode": "ask"
  },
  "context": {
    "git": true,
    "os": true,
    "cwd": true,
    "datetime": true,
    "project": true
  },
  "execution": {
    "mode": "foreground",
    "timeout": "30m"
  }
}
```

Every field has a sensible default. Minimal valid config: `{ "name": "my-agent" }`.

## Testing

```bash
npm test                    # All tests
npm run test:unit           # Unit tests only (fast, no I/O)
npm run test:integration    # Integration tests (loads real profiles)
npm run test:e2e            # E2E tests (real API calls, needs keys)
```

### Test Patterns

- Unit tests use fixtures from `tests/helpers/fixtures.ts`
- Profile tests create temp directories with `createTempProfile()`
- Integration tests load real profile directories
- E2E tests need `ANTHROPIC_API_KEY` (or `OPENROUTER_API_KEY` for OpenRouter-routed tests)
- Tests that need API keys detect the `OWNWARE_TEST_DUMMY` sentinel from `tests/setup/env.ts` and skip themselves

### Gateway Test Isolation (critical)

Gateway tests **must** pass both `profilesDir` AND `dataDir` to `OwnwareGateway`:

```ts
const tempDir = await mkdtemp(join(tmpdir(), 'cortex-test-'))
gateway = new OwnwareGateway({
  port: 0,
  profilesDir: join(tempDir, 'profiles'),
  dataDir: join(tempDir, 'data'),
})
```

**Why:** Without `dataDir`, the gateway defaults to the user's real data
dir. Any profile created via the API (POST, PUT, duplicate) writes to
`dataDir/profiles/`, not `profilesDir`. Missing `dataDir` leaks test
profiles into the user's real `~/.ownware/profiles/` directory, polluting
the system and registering as MCP tools.

**Rules:**
- Always pass `dataDir` pointing to a temp directory
- Clean up both `profilesDir` AND `dataDir` in `afterAll`
- Never create new test profile names — use `test-agent` (the standard fixture name) or reuse an existing built-in profile from `profiles/`
- For framework/contract tests, use `createTestGateway()` from the harness — it handles isolation automatically
- Do not create profiles in `~/.ownware/` from tests — ever

## What Goes Here vs. What Goes in Loom

| Concern | Cortex (this package) | Loom (engine) |
|---------|----------------------|---------------|
| Profile loading | Yes | No |
| System prompt assembly | Yes | No |
| Tool preset resolution | Yes | No |
| Security rule selection | Yes | No |
| Agent loop execution | No | Yes |
| Streaming events | No | Yes |
| Provider adapters | No | Yes |
| Compaction | No | Yes |
| Custom tool loading | Yes (from disk) | No |
| Context fragments | Yes (git, os, etc.) | No |

**Rule: If it's about WHAT agent to run, it goes in Cortex. If it's about HOW to run an agent, it goes in Loom.**

## Tool UI Descriptor relay

The `/api/v1/connectors` response carries an optional `uiDescriptor`
on each `ConnectorAction`. A UI client's chat-stream dispatcher pairs
it with a bespoke renderer or feeds it to a generic renderer.

Three sources of the descriptor:

- **Builtins (`source: 'builtin'`):** the descriptor is declared on
  the Loom `Tool` object in `packages/loom/src/tools/builtins/`. Cortex
  relays it through `builtinActionEntry` in `connector/registry.ts` —
  pure pass-through, no synthesis.
- **MCP servers (`source: 'mcp'`):** when the server's `toolsMetadata`
  is available, `connector/registry.ts` synthesizes a descriptor via
  `synthesizeUiDescriptor(actionName)` — explicit name patterns map
  to file-write / file-read / file-edit / search / image / shell;
  unmatched names default to `external-action` with a humanized verb.
- **Composio (`source: 'composio'`):** today the source emits
  `toolNames: null` with no `actions[]`, so wire-side descriptors
  aren't reachable. A client-side name-based fallback covers Composio
  actions until a future change populates `actions[]` with synthesized
  descriptors.

**Rule:** the schema lives in `connector/schema.ts` as
`ToolUIDescriptorSchema`. It is the wire contract — adding a new
optional field is fine; renaming or removing one is a breaking change
that requires updating Loom's TS mirror and any client-side mirror in
lockstep.

## Gateway Realtime Contract

- Every SSE channel emits `{ type: 'heartbeat', ts }` every 30 seconds, regardless of real traffic.
- Clients track `lastMessageTime`; if no message (including heartbeat) arrives for >60s, the client force-reconnects. This defeats half-open TCP connections that `onclose` never fires for.
- On reconnect, the client does a **full re-fetch of all subscribed query keys**. Assume everything is stale.
- **SSE never carries business payloads** — it carries `{ type, resource_id }` invalidation hints only. Clients re-fetch via HTTP to get the actual data. This keeps the cache as the single source of truth and avoids race conditions between SSE writes and HTTP reads.

## PR Guidelines

- Schema changes (`schema.ts`) must update `tests/unit/schema.test.ts`
- New config fields need Zod validation with sensible defaults
- Assembler changes must be tested end-to-end (profile → Session)
- Gateway type changes affect all consumers — discuss first
- Profile examples in `profiles/` should demonstrate real use cases
- Every new file gets a corresponding test file
