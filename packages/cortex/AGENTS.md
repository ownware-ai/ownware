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
├── provider-hub/         # Central provider/model/route/price/verification control plane
├── storage/              # Adapter contracts/lifecycle, logical schema, codecs, transfer preflight
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
| `provider-hub/schema.ts` + `service.ts` | Secret-free central provider/model/connection contract, catalog views and honest verification/pricing projections | Changing Provider Hub semantics or public catalog behavior |
| `gateway/state.ts` | Composes adapter repositories with process-local sessions/runtimes | Adding persistence backends or changing state ownership |
| `gateway/db/schema.ts` + `migration-safety.ts` | Immutable SQLite migration manifest, exact applied-history validation, snapshots and recovery | Adding a migration or changing database startup safety |
| `gateway/run-store.ts` + `effect-receipt-store.ts` + `permission-intent.ts` | Durable run lifecycle/consequence authority, immutable payload-free per-tool-action evidence, and canonical exact permission identities/one-use consumption | Changing retry safety, permission/effect authority semantics or public run evidence |
| `storage/contracts.ts` + `sqlite-adapter.ts` | Async adapter lifecycle, guarded repository/transaction scopes, savepoints and typed operational failures | Changing storage startup, shutdown or transaction ownership |
| `storage/core-repositories.ts` + `sqlite-core-repositories.ts` | Backend-neutral async domain ports for threads, messages, usage and agent events, with the SQLite implementation | Changing durable core reads/writes or adding a storage backend |
| `storage/security-repositories.ts` + `sqlite-security-repositories.ts` | Backend-neutral async ports for credentials, grants, principals, runs/effect/egress receipts, permissions, idempotency, refresh leases and runtime thread references | Changing security/run/effect/egress authority persistence or adding a storage backend |
| `storage/source-repositories.ts` + `sqlite-source-repositories.ts` | Backend-neutral async ports for source registration, uploads, quotas, source jobs, Data Views and deletion, with the SQLite implementation | Changing durable source authority or adding a storage backend |
| `storage/platform-repositories.ts` + `sqlite-platform-repositories.ts` | Backend-neutral async ports for connectors, channels, schedules, approvals, tasks, memory, candidates and teams, with the SQLite implementation | Changing remaining platform persistence or adding a storage backend |
| `storage/logical-schema.ts` + `value-codec.ts` | Exact live-schema classification and driver-neutral durable value normalization | Adding/changing a stored column or adapter value mapping |
| `storage/migration-manifest.ts` + `postgresql-migrations.ts` | Shared post-baseline migration identities plus immutable PostgreSQL dialect SQL, fingerprints and semantic postconditions | Adding a logical migration after the PostgreSQL baseline or changing migration certification |
| `storage/sqlite-transfer-preflight.ts` + `canonical-storage-digest.ts` | Read-only exact SQLite source preflight plus bounded, typed, content-free table/database receipts | Building or changing cross-adapter transfer validation |
| `storage/postgresql-transfer-preflight.ts` + `postgresql-catalog-certification.ts` | Read-only target identity/ownership/emptiness/privilege classification and exact behavioral catalog receipt | Changing transfer target admission or PostgreSQL schema certification |
| `storage/postgresql-canonical-snapshot.ts` | Bounded canonical read of all transferable PostgreSQL tables in one repeatable-read snapshot | Changing post-copy equality verification |
| `storage/sqlite-to-postgresql-transfer.ts` | Offline SQLite writer fence, transactionally bounded copy into one certified empty PostgreSQL target, and pre/post-commit canonical equality verification; it never selects the target | Changing transfer execution, failure states or explicit-cutover evidence |

### SQLite migration identity

- `_migrations` is authoritative; `PRAGMA user_version` is a diagnostic mirror.
- Applied rows must be the exact contiguous version/name prefix of the compiled
  manifest. Migration 82 introduces nullable fingerprints: legacy rows remain
  name-validated because their historical SQL cannot be proven retroactively;
  migration 82 and every later row must match the exact compiled fingerprint.
- Never edit an applied migration definition. Add a new migration. Never
  “repair” a divergent database by renaming history rows to look canonical.
- Identity refusal happens before snapshot or schema/application writes and
  uses a content-free support error. Tests use disposable databases only.

### PostgreSQL migration identity

- PostgreSQL begins with one exact generated baseline at logical version 82.
  Every later schema change has one shared logical version/name plus separate
  immutable SQLite and PostgreSQL implementations; omission or disagreement is
  a manifest failure, not an adapter fallback.
- Applied history must be the exact contiguous compiled prefix. PostgreSQL
  fingerprints the exact dialect SQL, applies the complete pending suffix and
  its receipts inside one transaction under the fixed advisory migration lock,
  and certifies both each new effect and the exact current schema before commit.
- A coherent next version from a newer binary is reported separately from a
  malformed, gapped or divergent history. Neither case is repaired or rewritten.
  Health is ready only when the compiled head is also the durable history head.
- Compatibility tests may supply an internal old/new manifest directly to the
  adapter. This is not a public configuration field and never permits callers
  to supply migration SQL through `GatewayOptions`.
- Migration 83 adds the internal per-thread `messages.message_seq` authority.
  Repository `add` assigns it transactionally at durable acceptance; `list`,
  hydrate, export and newest-message patching use it. Caller timestamps remain
  display/event time and opaque random IDs remain identity only—neither may be
  used to infer conversation order. Legacy rows retain their previously
  observable `(created_at, id)` order; that backfill is deterministic
  preservation, not a claim to recover unknowable historical causality.

### Storage value boundary

- The logical manifest is pinned to the exact fresh live schema. A column add,
  removal, rename or declared-type change fails certification until its meaning
  is classified and tested.
- PostgreSQL-shaped `BIGINT` strings, booleans, timestamps and JSON must pass
  through the shared codecs before entering domain code. Raw driver values are
  not domain values.
- SQLite transfer validation inspects `typeof(column)` in addition to declared
  affinity. Read integers in exact/safe-integer mode; never validate after a
  driver may already have rounded int64 data.
- Transfer errors contain stable reason codes plus certified table/column/PK
  names and deterministic row ordinal only—never primary-key values or stored
  customer content.
- A SQLite preflight receipt proves one read-only transaction and any source
  change it actually observes; it does not prove that writers are stopped and
  never authorizes target writes. The offline transfer must establish its own
  writer fence/fixed source snapshot, repeat the receipt comparison, and recheck
  target emptiness/ownership inside the transfer transaction.
- Offline transfer requires the earlier exact source and target receipts. It
  holds a SQLite `BEGIN IMMEDIATE` fence from source revalidation through target
  commit and verification, and it always rolls that source transaction back.
- Target copy runs in one PostgreSQL `SERIALIZABLE READ WRITE` transaction under
  the transfer advisory lock plus `ACCESS EXCLUSIVE` locks on every business
  table. Ownership, catalog identity and exact emptiness are revalidated after
  those locks; transfer never truncates, adopts or resumes a non-empty target.
- Rows are read in deterministic primary-key order and copied in bounded batches
  through the strict logical codecs. Foreign-key order comes from the certified
  target catalog, deferrable constraints are checked before commit, and the full
  canonical source/target receipt must match both before and after commit.
- Transfer success is only evidence that a committed verified target is ready
  for an explicit operator cutover. It never changes gateway configuration,
  starts the target or makes PostgreSQL authoritative; unchanged SQLite remains
  the rollback source until the target accepts runtime writes.
- Cancellation and confirmed failures roll the entire empty target transaction
  back so the exact transfer can restart. Ambiguous commit/rollback outcomes
  remain explicit uncertainty that requires a fresh authoritative inspection;
  never present them as success or automatically repair, truncate or adopt them.
- Canonical table/database digests are equality evidence, not harmless telemetry:
  low-entropy stored values can make them dictionary oracles. Keep receipts
  local with restrictive permissions; never emit them to normal logs, HTTP/SSE,
  analytics or support reports. Report only stable failure categories there.
- PostgreSQL target certification compares authoritative catalog definitions,
  not object counts or names alone: column defaults, every constraint, exact
  indexes/predicates/operator classes, trigger events, function bodies and the
  identity-sequence configuration are part of the current receipt. Unknown or
  version-divergent catalog output is non-success.

### Storage lifecycle and transactions

- SQLite remains the configuration-free default. `GatewayState` still opens it
  eagerly for pre-1.0 constructor compatibility, while gateway startup awaits
  the selected adapter lifecycle before any listener can become ready.
  PostgreSQL is explicit, tenant-owned and never a fallback after SQLite or
  PostgreSQL startup failure.
- The SQLite driver is synchronous internally. Its async adapter surface
  serializes transaction callbacks; it does not make SQLite work non-blocking
  and never passes an async callback to `better-sqlite3.transaction()`.
- Root and transaction repository implementations must call their supplied
  `assertActive` guard at every operation boundary. Transaction scopes expire
  after commit/rollback. Nested roots are rejected; intentional nesting uses
  the transaction's savepoint API.
- Arbitrary callbacks are never replayed. Adapter-owned failures are
  content-free and typed; only a SQLite busy/locked failure before callback
  invocation is marked retryable, and callers still need an explicitly
  idempotent boundary before retrying.
- `OwnwareGateway.start()` and `stop()` share their in-flight transitions.
  Storage closes last on success, cancellation, listen failure and ordinary
  shutdown. A stopped gateway instance is terminal; construct a new instance
  to reopen the same database.
- `storage/sqlite-driver.ts` is the only production module allowed to import
  `better-sqlite3`. SQLite physical repositories import its handle aliases;
  gateway/domain callers use async repository ports. The AST architecture test
  enforces the single dependency edge, quarantined raw compatibility accessors
  and adapter-only `CortexDatabase` construction.
- SQLite history inspection, snapshot, migration and corruption recovery run
  under the adapter-owned migration lock database. The uncommitted write is
  the cross-process lock; a process crash releases it through SQLite/the OS.
  This prevents competing startup restores but does not claim that two gateway
  processes may share one SQLite database for ordinary runtime work.
- `GatewayState.rawDbHandle`, `GatewayState.rawDatabase` and
  `CortexDatabase.rawMainHandle` are deprecated SQLite-only compatibility
  surfaces. Do not use them in production code and do not add an equivalent to
  another adapter; removal requires a declared major release.

### Core storage repositories and event ordering

- Gateway production paths access threads, messages, usage and agent events
  through the async interfaces in `storage/core-repositories.ts`. New backends
  implement those ports directly; do not expose a driver or SQL dialect to
  handlers, runners or public gateway types.
- Every SQLite repository operation checks its active scope and converts driver
  failures to content-free `StorageRepositoryError` metadata. Never attach the
  raw driver error as a cause or copy its message: either can contain SQL,
  filesystem paths or customer data and later reach a log.
- `EventIngestor` is the ordering boundary for live agent events. It serializes
  each stream and awaits the durable append before publishing to the live bus.
  An append failure must reject the ingest, publish nothing and leave the next
  successful event with the next contiguous durable sequence.
- Deterministic repository ordering needs an explicit final tie-breaker. Shared
  contract tests must cover null fidelity, ordering, pagination, reopen/replay
  and an unfamiliar valid value—not only the examples currently in fixtures.

### Security storage repositories and authority

- Gateway production paths access credentials/audit/spend/import, delegated
  principals, thread bindings, grants, runs, permission requests, idempotency,
  OAuth refresh leases and runtime thread references through
  `storage/security-repositories.ts`. Construct their SQLite stores only in the
  SQLite repository factory; handlers, runners, resolvers and CLI commands do
  not receive `rawDbHandle` for these domains.
- Credential encrypted-value revision plus status is the rotation CAS. Refresh
  ownership uses owner plus generation; idempotency mutations use the current
  lease owner. Explicit permission decisions bind one run, request, agent,
  canonical tool input, policy revision and tool surface through an HMAC
  operation identity, then atomically consume one approved request immediately
  before supported dispatch. Cancellation, terminalization and restart expire
  approved-but-unconsumed requests. A stale or losing writer must visibly lose;
  it never becomes an idempotent-looking success.
- Delegated thread creation and its principal binding are one adapter-owned
  write transaction. Failure rolls back the thread and workspace/profile count;
  a delegated caller must never observe an unbound thread.
- Audit append and credential `lastUsedAt` metadata are separate durable
  operations. The audit append is required before a resolver returns a handle;
  the metadata update is best-effort. Do not claim they are one transaction.
- Driver errors are discarded at the repository boundary. Secret-canary tests
  must cover thrown errors, logs and durable rows; never attach a raw error as a
  cause. Shared security repository contracts must run unchanged for every
  adapter and cover independent-owner contention plus reopen continuity.

### Source storage repositories and effects

- Gateway production paths access source registrations, upload sessions,
  quotas, source jobs, Data View metadata and deletion state through
  `storage/source-repositories.ts`. Construct their SQLite stores and shared
  quota policy only in the SQLite repository factory; handlers and workers do
  not receive a raw database handle for these domains.
- Source bytes and Data View artifacts remain filesystem effects behind
  `SourceByteStore`; database and filesystem mutation are not one atomic
  transaction. Preserve the explicit ordering, ownership fences, rollback and
  restart reconciliation at each workflow boundary rather than claiming
  cross-resource atomicity.
- Job, Data View and deletion mutations conditionally match their current
  claim owner/token. Lease heartbeats are non-overlapping and failure-contained,
  and stale owners must visibly lose after expiry or takeover.
- `uploads.getScoped` is a write operation because it may durably expire a live
  session. Repository operation classifications describe effects, not method
  name conventions.
- Shared source repository contracts must cover independent-adapter quota and
  claim contention, stale-owner rejection, public Data View manifests,
  deletion cancellation, thaw and restart continuity. A real gateway journey
  must additionally prove uploaded bytes, delegated field/row enforcement,
  revocation and physical deletion.

### Platform storage repositories and coordination

- Gateway production paths access connector connections, channel jobs and
  receipts, schedules and held approvals, thread tasks, memory and proposals,
  profile candidates, and team boards/runs/tasks/leases through
  `storage/platform-repositories.ts`. Construct their SQLite stores only in the
  SQLite repository factory; handlers, workers and schedulers receive async
  ports rather than a raw database handle.
- Await the durable transition before publishing an invalidation, dispatching
  a dependent effect or returning success. Memory proposal acceptance publishes
  both memory and proposal events only after their shared transaction commits.
- Channel claim tokens/checkpoints, candidate expected-active/revision checks,
  schedule cursor/run coupling, team task ordinals/resource leases and approval
  pending decisions are authority predicates. Held schedule approvals bind the
  exact schedule/run/thread/policy/tool/input/declared-target identity and move
  through one atomic `pending -> executing` claim before dispatch. Startup turns
  an interrupted claim into `indeterminate`; it never retries an uncertain
  external effect. A stale/conflicting writer must return a visible non-success
  and cannot be treated as idempotent completion.
- Shared platform repository contracts run unchanged for every adapter and
  cover independent-connection contention plus reopen continuity. The real
  gateway lifecycle journey supplements those contracts with public HTTP reads;
  it does not replace their internal ownership/fencing assertions.

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
- Every runtime route that can request permission must supply the same final
  `authorizeToolExecution` callback and immutable run policy revision. Missing,
  stale or replayed binding fails closed at the last Ownware-controlled dispatch
  boundary; an earlier approval event or provider-native accepted boolean is not
  execution authority.
- Consequence evidence is monotonic. A model tool result proves only
  `effect_possible`; `effect_confirmed` requires observation at the effect
  boundary.
- `close()` is bounded and idempotent. A teardown timeout leaves outcome
  indeterminate.
- External test drivers live under `tests/`; production `src/` never exports a
  fake provider, process, issuer, or runtime.

`src/runtime/codex/app-server-client.ts` is the official external-process
boundary:

- Support is pinned to the exact generated-and-proven Codex protocol minors
  `0.145.x` and `0.147.x`. `0.146.x` is intentionally unsupported: version
  ordering is not protocol-compatibility evidence. Every additional minor must
  regenerate schemas, add compatibility fixtures and pass a real isolated
  installed lifecycle before widening the set.
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

`src/runtime/codex/control-plane.ts` and
`gateway/handlers/codex-runtime.ts` expose the owner-side connection flow:

- The control process is lazy and uses `<dataDir>/runtimes/openai-codex`; merely
  starting the Gateway must not start Codex or inspect an account.
- Status, login, logout and model catalogue routes are install-owner only and
  `Cache-Control: no-store`. Delegated principals remain denied even if they
  advertise the matching operation.
- One inbound pump owns app-server notifications and rejects unexpected server
  requests. HTTP handlers never race separate consumers over the wire queue.
- Inspectable status contains no account identity, login correlation, login URL
  or device code. Only login start returns one-time presentation material.
- Both managed and direct ChatGPT routes remain `experimental`. The official
  app-server route is operationally distinct from the unproven direct transport
  and must never fail over to it.

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
  expansion is denied. The native approval bridge and loopback MCP bridge both
  require final exact authorization before returning accept or entering a tool
  handler; an unwired adapter denies.

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
