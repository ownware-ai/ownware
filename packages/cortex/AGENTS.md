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

## Runtime selection

Execution runtime and model access are separate contracts
(`src/runtime/selection.ts`, ADR-0009):

- `ownware` uses the existing engine loop. It may use the normal provider API
  route or an explicitly experimental direct ChatGPT access route.
- `openai-codex` is an external runtime. The kernel supervises and translates
  its app-server protocol; the engine is not invoked for that thread.
- Runtime/access pairs are a strict union. Unknown values and invalid pairs
  fail at configuration parsing rather than falling back.
- A thread is bound to one pair. Changing pairs creates an explicit new thread;
  never replay or fail over silently.
- Capability assessments carry authority, observation time and freshness.
  `unknown` is a valid honest result.

External-runtime discovery, process control, native-event translation and
configuration isolation belong under `src/runtime/`, not in the engine or a UI
client.

`src/runtime/port.ts` is the execution seam:

- `SessionRunner` consumes `ExecutionRuntime`; it does not branch on providers.
- The legacy path is wrapped by `createOwnwareRuntimeDriver`. Explicit external
  runtime state must not require a native-engine `Session` or `HumanInTheLoop`.
- Drivers return an authoritative `succeeded | failed | indeterminate`
  completion. Clean process exit alone is not success.
- Native events carry monotonic source positions. Duplicate, late, unknown, or
  unresolved-permission completion fails visibly and cannot imply success.
- Consequence evidence is monotonic. A model tool result proves only
  `effect_possible`; `effect_confirmed` requires observation at the effect
  boundary.
- `close()` is bounded and idempotent. A teardown timeout leaves outcome
  indeterminate.
- External test drivers live under `tests/`; production `src/` never exports a
  fake provider, process, issuer, or runtime.

`src/runtime/codex/app-server-client.ts` is the official external-process
boundary:

- Support is pinned to the generated Codex `0.145.x` protocol. A new minor
  version must regenerate schemas, add compatibility fixtures and pass a real
  installed lifecycle before widening the range.
- Stdout is JSONL protocol only. Malformed envelopes and unknown response IDs
  poison the connection because request correlation is no longer authoritative.
- `CODEX_HOME` is an absolute Ownware-managed directory and initialization must
  report the same canonical filesystem identity. Preserve the parent `HOME` so
  explicitly granted shell tools can still use the operator's normal programs.
- Never retain app-server stderr text. Diagnostics may expose bounded metadata
  (byte count, version, stable failure code, exit code/signal), never tokens,
  account identity, prompts or tool results.
- Close means observed process exit. The bounded order is stdin close,
  `SIGTERM`, `SIGKILL`; no observed exit becomes `shutdown_timeout`.
- Initialize as `clientInfo.name = "ownware"`. Enterprise distribution requires
  following OpenAI's documented known-client registration path; do not
  impersonate another client identity.

`src/runtime/codex/account.ts` is the redacted subscription-status boundary:

- Codex owns login, token persistence and refresh. The kernel consumes app-server
  RPCs and must never read, copy, parse, log or persist Codex `auth.json`.
- `account/read` is account-state authority, but authentication is not proof a
  model request will be served. Refresh it immediately before a turn and let
  the later turn response remain authoritative.
- `account/updated` is a refresh signal, not proof of authentication. Login
  completions are correlated by exact login ID; stale completions cannot alter
  the current attempt.
- Browser URLs and device codes are one-time presentation values. Do not place
  them in snapshots, diagnostics, persistence or logs. Provider error prose and
  account email are discarded at the adapter boundary.
- The available model set and reasoning-effort order come only from
  `model/list`. Refresh replaces the catalogue; a removed model fails preflight
  instead of falling back to a handwritten/API-key catalogue.
- Official subscription quota comes from `account/rateLimits/read` and its
  sparse update notification. Sparse null/missing fields never erase known
  values. Invalid or empty shapes become `unknown`, never zero.
- Account, model and quota observations carry their authority, timestamp and
  `validUntil: null`; the provider declares no freshness window.

Direct OAuth credentials use the existing credential boundary, with additional
rotation invariants:

- Refresh single-flight is a durable per-credential lease, not an in-memory
  promise or manager-instance lock. After acquiring it, re-read through the
  credential gates so a waiter observes the persisted winner.
- Rotation and terminal health writes compare the opaque encrypted-value
  revision plus status. Do not use display metadata or `updatedAt` as the
  token-revision authority.
- Lease loss, stale conditional writes and failed health persistence are
  distinct visible failures. Never return an unpersisted rotated token or
  silently reuse a terminally rejected revision.
- Observer failures are isolated from the answer path but require a separate,
  content-free diagnostic path.
- Test issuers prove lifecycle wiring only. They do not establish provider
  authorization, endpoint compatibility or subscription entitlement.

`src/runtime/codex/profile-mapping.ts` is the official-route profile
compatibility boundary:

- Build and present a compatibility report before emitting wire input.
  Unsupported behavior is either blocking or requires an explicit decision
  bound to the exact report ID. A changed profile, source, image, skill,
  catalogue or model makes an earlier decision stale.
- Trusted profile identity uses `thread/start.developerInstructions`. Never
  replace Codex base instructions and never put profile authority into an
  ordinary user message.
- User requests and approved source text remain `turn/start` text input.
  Source material is labelled untrusted data and never copied into developer
  instructions. This preserves the authority boundary; it does not claim a
  model can make prompt injection impossible.
- A selected model must occur in the supplied `model/list` observation.
  Static provider/API-key catalogues are not authority for this route.
- Images cross only as typed `localImage` items after absolute-path,
  canonical-root, size and signature checks. Arbitrary files and text
  placeholders for lost images are unsupported.
- Skills cross only when explicitly selected, active, profile-local, nested as
  `<skill>/SKILL.md`, unchanged since load and free of an unenforced Ownware
  tool allowlist. Native skill-trigger matching is not implied.
- Profile tools map only through `CodexScopedToolAuthority`: the exact profile
  assembler output, immutable run registration and `mcpServerStatus/list`
  observation must agree. Missing, extra, stale or unrequested tools block.
  Hooks, critical reminders, spend caps and tool input policies still block.
  Memory, compaction, delegation, context toggles and tuning differences
  remain visible limitations.
- Compatibility mappings retain a fixed `approvalPolicy=never` +
  `sandbox=read-only` preview fence. Only
  `composeCodexOfficialRunPlan()` may replace it, and only after both the
  profile decision and the separate sandbox limitation decision are ready.
- Reports and stable errors contain no profile text, source text, skill body,
  attachment path or provider prose. Successful preflight does not guarantee a
  later provider response.

The official tool/sandbox boundary is split across
`mcp-tool-bridge.ts`, `run-isolation.ts`, `native-approval-bridge.ts` and
`official-run-plan.ts`:

- App-server always starts with strict config from an explicitly marked
  Ownware-managed `CODEX_HOME`. The generated config disables apps, plugins,
  ambient skill search, analytics and all MCP servers except the loopback
  `ownware_run` bridge.
- Configuration is not proof. Before a turn, disable every discovered ambient
  skill and re-list; require `app/installed` to report no enabled/callable app,
  `plugin/installed` to report no enabled installed plugin, and
  `mcpServerStatus/list` to report exactly one server with the exact registered
  tools. Malformed or unavailable observations fail closed.
- One loopback hub may serve many runs, but an unguessable bearer capability
  selects one immutable tool map. Validate the declared schema and invocation
  arguments before handler entry. Duplicate request identity with identical
  material executes once; conflicting reuse fails.
- The bridge executes through the native tool executor, permission events
  and output redaction. Unknown tool names and provider/private error prose do
  not enter returned errors or receipts.
- A successful mutating handler proves only `effect_possible`. Only a named
  observer at the durable effect boundary may emit `effect_confirmed`.
  Observer failure becomes `outcome_unknown`; it is not safe to retry.
- HTTP response write proves only `responseState=written`.
  `deliveryEvidence=unknown` remains until a later app-server event provides
  authoritative correlation. Teardown revokes the run capability, aborts handlers and
  closes active sockets.
- Built-in sandbox shapes deny network and limit writes to canonical approved
  roots. They do not confine reads to the workspace. The
  `host_read_scope` limitation must be accepted explicitly; symlink root
  identities, unknown modes, broad network and `dangerFullAccess` are
  unsupported.
- Native command/file callbacks use exact thread/turn/item identity and emit
  canonical permission request/response events. File changes require matching
  item-lifecycle context. Decisions are only one-turn `accept` or `decline`;
  provider-proposed persistent amendments are ignored and direct permission
  expansion is denied.

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
