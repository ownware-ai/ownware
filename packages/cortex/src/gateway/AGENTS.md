# Gateway — Hydration & Streaming Contract

## Transport (HTTP/2-over-TLS by default)

The gateway serves **HTTP/2 over TLS** by default (`GatewayOptions.tls`,
default `true`). HTTP/2 multiplexes unlimited concurrent streams over one
TCP connection, which removes the browser's 6-connection-per-origin
HTTP/1.1 cap — that cap was starving plain `fetch`es behind the long-lived
SSE streams during a heavy run (~18s stalls). Browsers require TLS for h2,
so the gateway uses a per-install self-signed loopback cert at
`<dataDir>/tls/` (`tls.ts`); a desktop host can pin-trust it by
fingerprint. `allowHTTP1: true` keeps HTTP/1.1 clients working.

Set `tls: false` (or `OWNWARE_GATEWAY_TLS=0`) for plain HTTP/1.1 — used by
the test harness and BYO-cloud packaging, where a platform proxy
terminates TLS upstream. Consequence for SSE handlers: never set a
`Connection` header (forbidden on h2; redundant on h1) — `startSSE` omits it.

## Scope

The gateway exposes two strictly separated surfaces for reading a
thread's history. Do not mix them in any new client code.

| Purpose | Endpoint | Source | Use it when |
|---|---|---|---|
| **Hydrate a thread** (display any thread, live or archived) | `GET /api/v1/threads/:threadId/hydrate` | `messages` table + agents index + live-run flag | Every time the UI opens a thread |
| **Read consolidated message history alone** | `GET /api/v1/threads/:threadId/messages` | `messages` table | Back-compat / export paths |
| **Live-tail an agent's event stream** (mid-turn streaming) | `GET /api/v1/threads/:threadId/agents/:agentId/events` (SSE) | `agent_events` replay + EventBus | Only for active runs, and only after `/hydrate` reports `runningAgentId != null` |
| **Mid-run reconnect** | same SSE endpoint with `?since=N` | `agent_events` from seq N | Only when tearing a dropped SSE back up |
| **One-shot raw event dump** (tests, admin) | `GET /api/v1/threads/:threadId/agents/:agentId/events/history` | `agent_events` | Not for normal UI |

## Why this split

`agent_events` is raw, per-agent, append-only. It is the live-tail
substrate, and a resume cursor for dropped SSE connections. It is **not**
the source of truth for historical thread UI. Retention prunes it for
terminal threads.

`messages` is the consolidated snapshot: one row per user turn, one row
per assistant turn, plus system rows for compaction, recovery, security
blocks, and errors. Every UI field a client needs (tool cards,
sub-agent cards, permissions, thinking, usage) is already denormalized
into the assistant row by `session-runner.ts:accumulateEvent`. This is
the durable-forever source.

Message order comes from the storage-assigned per-thread `message_seq`,
allocated inside the same transaction that accepts the row and updates the
thread aggregate. `ThreadMessage.timestamp` is presentation/event time and can
collide or move backwards; message IDs are opaque. Hydrate, message reads,
portable export, and “newest matching message” logic must never reintroduce
timestamp/ID ordering.

## Hydration contract (what `/hydrate` returns)

```ts
{
  thread: Thread
  messages: ThreadMessage[]
  agents: Array<{ agentId, parentAgentId, eventCount }>
  runningAgentId: string | null    // 'root' when a run is live, else null
  runningRunId: string | null      // public durable active run, when one exists
  maxSeq: number                   // highest seq on the root agent
  lastClosedTurnEndSeq: number     // highest seq of `turn.end` on root
}
```

Client flow:
1. Call `/hydrate`. Render immediately from `messages`.
2. If `runningRunId != null`, prefer its bounded run-event stream. Otherwise,
   if `runningAgentId != null`, open SSE on that agent with
   `?since={lastClosedTurnEndSeq}`. Replaying from the last closed turn
   boundary lets the reducer rebuild any in-flight turn (turn.start +
   deltas + open tool calls) that hasn't yet hit turn.end. Using
   `maxSeq` as the cursor would skip the in-flight turn.start and
   subsequent deltas would land on a closed reducer state.
3. On SSE disconnect during an active run, reconnect with the new
   `lastDeliveredSeq` as `?since`.
4. On thread switch or tab close, drop the SSE. Next open re-hydrates.

Clients MUST NOT open SSE for archived threads. `runningAgentId = null`
is the authoritative signal that the thread is terminal.

`runningRunId` is deliberately narrower than liveness. It is present only when
the process-local active runner identity is confirmed by the durable public run
repository. Internal/legacy live work may therefore have `runningAgentId =
'root'` and `runningRunId = null`. Archived hydration does not guess a latest or
per-message run ID. Delegated hydration additionally requires
`threads.hydrate`, exact workspace/profile scope and the thread's durable
principal binding; owner access to unbound owner threads is unchanged.

## Ordered turn timeline (`messages.parts`)

Live UIs see events in arrival order and render correctly. Hydrated
UIs need the same ordering — without it, a turn that streamed
"text → tool → text → tool" hydrates as concatenated text plus two
trailing tool cards.

`ThreadMessage.parts` is the ordered timeline:

```ts
parts: ReadonlyArray<
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; toolCallId: string }       // resolves in tools[]
  | { kind: 'subagent'; agentId: string }       // resolves in subAgents[]
  | { kind: 'permission'; requestId: string }   // resolves in permissions[]
>
```

Cross-references are by stable id from Loom — toolCallId, agentId,
requestId — not array indices. Clients look up the rich record in the
existing helper arrays.

Optional for back-compat: messages written before this field was
added load with `parts: undefined`. Clients fall back to the legacy
"text + trailing tools" layout. New writes always populate `parts`.

## Slow-consumer protection

Each SSE connection caps in-flight writes (`MAX_PENDING_WRITES`,
default 1000) and the phase-1 replay buffer (`MAX_REPLAY_BUFFER`,
default 5000). On overflow the gateway emits

```
event: stream.shutdown
data: { "type":"stream.shutdown", "reason":"slow_consumer", "retryAfterMs":10000, ... }
```

and closes the socket. Clients should treat `slow_consumer` as a
"reload via /hydrate then re-open SSE only if the thread is still
running" event, not as a generic disconnect.

Tunable via `OWNWARE_SSE_MAX_PENDING_WRITES` and
`OWNWARE_SSE_MAX_REPLAY_BUFFER` env vars (positive integers).

## Retention invariant

When `agent_events` retention is enabled:

- Terminal threads (`status IN ('completed','error')`) older than
  `OWNWARE_EVENT_RETENTION_DAYS` may have their **root-agent** event
  rows pruned. Sub-agent rows (`agent_id != 'root'`) survive — those
  carry transcripts that have no equivalent in `messages` yet, so
  pruning them would blank the "View thread" modal on archived helpers.
- `messages` rows are **never** pruned by the retention job.
- `/hydrate` remains complete for pruned threads because it reads
  `messages`. SSE reopen on a pruned thread is meaningless (the thread
  is terminal) and the gateway enforces this via `runningAgentId = null`.

## Partial-turn finalizer

When a run terminates outside `turn.end` (abort, error, timeout,
gateway shutdown), `session-runner.consumeLoop` flushes the accumulator
to `messages` as a final assistant row and publishes a
`turn.interrupted` gateway event to `agent_events` + EventBus.

Invariants:
- Pending sub-agents are downgraded from `running` → `error` with a
  synthetic `<interrupted: parent $reason>` result.
- Pending permission requests are saved with `decision: 'pending'`.
- The partial row is still `role: 'assistant'`. The interruption signal
  lives on the trailing `turn.interrupted` event in the raw log; the
  thread's `status` carries the run-level verdict.

## Exact permission decisions

`POST /api/v1/runs/:runId/permissions/:requestId/decision` is the exact public
decision route. The client must echo the HMAC `operationHash` published with
that request; the durable binding also includes the run, request, root/helper
agent, canonical tool input and immutable run policy revision. A decision only
moves `pending` to `approved` or `denied`. Approval is consumed atomically once
by `authorizeToolExecution` immediately before the supported dispatch boundary.

- Never execute from the HTTP success, `permission.response`, HITL boolean or
  operation-hash equality alone. The one-use durable consume is the authority.
- Changed input, helper identity or policy revision, replay, stale delivery,
  cancellation, terminalization and restart block/expire the unconsumed action.
- Durable permission/event evidence contains bounded identity metadata, not raw
  tool input. The HMAC proves equality to the bound bytes, not action safety,
  remote target freshness, effect success or absence of secrets.
- Persistent tool/folder grants remain a compatibility policy mutation, not
  the `runs.permissions.decide` one-action guarantee. Do not describe one as the
  other.
- A held schedule action must win its separate atomic claim before dispatch.
  If it carries a target revision, dispatch only through the tool's declared
  authority-backed conditional-effect API. An interrupted claim is
  `indeterminate`, never automatically retried.

## Run-scoped outbound enforcement

`RunEgressControl` is the Cortex policy/durability boundary for Loom's egress
seam. A pre-dispatch receipt must commit before a platform-owned transport is
invoked. Terminal or restart reconciliation converts every still-open attempt
to explicit `outcome_unknown`; it never manufactures a success or failure.

- `local-only` admits only `platform_fetch` to a literal `127.0.0.0/8` or `::1`
  origin. DNS names, custom fetch, remote/redirected origins and unknown or
  uncontained routes fail closed.
- Session assembly is part of the boundary: do not import custom-tool modules,
  start MCP transports, resolve uncontained connector providers, probe remote
  fallbacks or enter an external runtime for a local-only run.
- The effective mode is the stricter profile/request mode and is immutable for
  a cached session. A mode change requires a new thread.
- Receipts are content-free structural observations. Never add paths, queries,
  headers, bodies, credentials, prompts, results or arbitrary diagnostics.
- Declarations are trusted only for the unmodified core/adapters under contract
  test. Arbitrary in-process extensions enlarge the trusted computing base; a
  declaration alone does not prove containment.

## Exact skill activation receipts

`skill-activation-evidence.ts` binds the assembled profile and each frozen skill
to install-local keyed digests. `skill-activation-receipt-store.ts` persists the
engine's exact dispatcher observation before `EventIngestor` can publish the
corresponding `skill.activation` event.

- Root receipts are accepted only from the native in-process engine, with a
  concrete dispatcher call and the active profile identity.
- Helper receipts are accepted only from `AgentSpawner` for the concrete helper
  identity and an explicit `grant.skills` resolution, before the helper's first
  provider request. The root lazy skill tool is never shared into the helper.
- Same-name tools, metadata, reminders, profile prose and external-runtime
  canonical events are not authority and cannot create receipts.
- SQLite and PostgreSQL allocate one gap-free per-run receipt sequence, preserve
  exact idempotence, reject conflicting identity reuse and keep rows immutable.
- HTTP/SSE expose identities, correlation, order and time only. Never add the
  skill body, description, trigger, caller args, prompt or tool result.
- The receipt proves exact conversation placement, not provider processing,
  behavioral compliance, model correctness, tool success or external effects.

## Exact effect reversal offers

`effect-reversal-adapters.ts` wraps only the exact final root `remember` tool
object assembled by Cortex. Its private one-use result mark may create an offer
only when the call inserted a new pending memory proposal and the durable
`tool.call.start` effect identity already exists. Tool names, metadata, prose,
helpers and external-runtime events are not authority.

- The first supported inverse is deliberately narrow: reject that exact new
  pending proposal while its profile, thread and captured `created_at` revision
  still match. Accepted, edited, rejected, missing or otherwise changed targets
  resolve the offer as stale without overwriting user state.
- The persisted adapter ref/revision selects a trusted host registry after
  restart. Unknown identities fail closed; there is no generic fallback and no
  tool-name catalogue. Compensation remains a distinct future adapter effect.
- Target transition, terminal offer status and immutable execution receipt are
  one SQLite/PostgreSQL transaction. A UUID idempotency key replays the one
  receipt; a different key cannot execute a terminal offer again.
- Public offer/receipt routes are authenticated, principal-scoped and
  `no-store`. They expose effect/tool correlation, adapter identity, operation,
  status and time only—never target IDs/revisions, profile/thread scope, memory
  content, tool arguments or results.
- A confirmed receipt proves the pending proposal is now rejected at Ownware's
  memory authority. It does not erase history, undo arbitrary effects, prove
  compensation, or claim that a remote system accepted an inverse.

## Never do

- Do not write to `agent_events` from anything other than `EventIngestor`.
- Do not add a second "snapshot" table — `messages` is the snapshot.
- Do not version the messages format without also bumping the wire types
  in `gateway/types.ts` and shipping a back-compat reader.
- Do not let clients read `agent_events` for archived threads. That is
  the exact inconsistency this contract was written to remove.

## Codex subscription control plane

The six `/api/v1/runtimes/codex*` routes are an owner-side control plane, not a
run transport and not delegated profile authority. Keep these invariants:

- auth-enabled installs require the owner bearer; auth-disabled loopback is the
  local install owner; delegated principals are always denied;
- every response is `Cache-Control: no-store`;
- status is redacted and never includes account identity, provider prose,
  login IDs, authorization URLs, device codes or tokens;
- login start is the only one-time presentation boundary;
- the Gateway owns one lazy control process in its managed data directory and
  closes it during bounded shutdown;
- model discovery refreshes and authorizes the managed account first and fails
  closed when signed out; it does not fall back to an API-key catalogue.

## Provider Hub control plane

The `/api/v1/provider-hub*` routes centralize secret-free provider families,
execution routes, model facts, price scopes, connection state and independent
verification evidence. Catalog claims are not execution evidence: unknown or
untested capabilities remain explicit, and catalog-only routes are never made
connectable without a registered runtime adapter. Custom OpenAI-compatible
configuration persists only credential references; submitted keys go through
the encrypted credential store. Settings and audit access must stay on async
repository ports so SQLite and PostgreSQL retain the same behavior.

## Files

- `handlers/threads.ts` — `/hydrate` and message CRUD.
- `handlers/agent-events.ts` — SSE live-tail + mid-run resume.
- `session-runner.ts` — event consumption + messages reducer + partial-
  turn finalizer.
- `egress-control.ts` + `egress-receipt-store.ts` — run policy, durable
  pre-dispatch authority, content-free observations and terminal reconciliation.
- `skill-activation-evidence.ts` + `skill-activation-receipt-store.ts` — exact
  install-local skill identity and immutable content-free placement evidence.
- `effect-reversal-store.ts` + `effect-reversal-adapters.ts` — private exact
  target binding, content-free offers and atomic restart-safe inverse receipts.
- `event-ingestor.ts` — single write path for `agent_events`.
- `event-bus.ts` — in-process fan-out for live SSE subscribers.
- `events.ts` — gateway event contract (Loom events + gateway-owned
  wrapper events, including `user.message` and `turn.interrupted`).
- `handlers/codex-runtime.ts` — redacted owner-only account/login/model routes.
- `handlers/provider-hub.ts` — central provider reads, refresh and compatible-
  connection lifecycle.
- `../runtime/codex/control-plane.ts` — lazy process ownership and the single
  ordered app-server inbound pump.
