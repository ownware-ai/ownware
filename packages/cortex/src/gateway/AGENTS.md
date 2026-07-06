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

## Hydration contract (what `/hydrate` returns)

```ts
{
  thread: Thread
  messages: ThreadMessage[]
  agents: Array<{ agentId, parentAgentId, eventCount }>
  runningAgentId: string | null    // 'root' when a run is live, else null
  maxSeq: number                   // highest seq on the root agent
  lastClosedTurnEndSeq: number     // highest seq of `turn.end` on root
}
```

Client flow:
1. Call `/hydrate`. Render immediately from `messages`.
2. If `runningAgentId != null`, open SSE on that agent with
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

## Never do

- Do not write to `agent_events` from anything other than `EventIngestor`.
- Do not add a second "snapshot" table — `messages` is the snapshot.
- Do not version the messages format without also bumping the wire types
  in `gateway/types.ts` and shipping a back-compat reader.
- Do not let clients read `agent_events` for archived threads. That is
  the exact inconsistency this contract was written to remove.

## Files

- `handlers/threads.ts` — `/hydrate` and message CRUD.
- `handlers/agent-events.ts` — SSE live-tail + mid-run resume.
- `session-runner.ts` — event consumption + messages reducer + partial-
  turn finalizer.
- `event-ingestor.ts` — single write path for `agent_events`.
- `event-bus.ts` — in-process fan-out for live SSE subscribers.
- `events.ts` — gateway event contract (Loom events + gateway-owned
  wrapper events, including `user.message` and `turn.interrupted`).
