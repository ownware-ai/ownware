# ADR-0004: Immutable run identity and durable snapshots

- **Status:** Accepted
- **Date:** 2026-07-12
- **Decision owners:** Ownware maintainers

## Context

The Gateway currently treats a conversation thread as both conversation
identity and execution identity. One thread may contain many turns, but the
runner map, start response, SSE route and status recovery expose only the
thread ID. Consequently a client opening `streamReply(threadId)` from cursor
zero can stop at an earlier turn's terminal event, and two turns cannot be
addressed or inspected independently.

Thread status is also not execution truth. Every run flips the thread between
`active` and `completed`/`error`; boot recovery rewrites every orphaned active
thread to `completed`; and the abort watchdog can write `completed` and delete
runtime while non-abort-aware work is still executing. Socket close likewise
proves only transport state, not provider/tool completion or cancellation.

The durable idempotency record added by ADR-0003 replays a thread-shaped start
result, but it cannot describe the lifecycle of the execution it fenced.

## Decision

### Identity and ownership

Every accepted execution gets an opaque immutable UUID `runId`. A run belongs
to exactly one thread, workspace (when present), profile and resolved model.
Multiple runs may belong to one thread; at most one may be locally executing on
that thread at a time under the existing runner guard.

Run identity is minted by the Gateway before the user message/event or provider
loop is started. It is never derived from thread ID, message ID, request ID or
an external provider identifier.

When a durable idempotency claim exists, the claim is linked to the run. A
matching replay returns the same `runId` and thread reference. The link stores
only opaque IDs and safe request metadata; prompts, attachments, tool inputs,
results and bearer material do not enter the run table.

### Durable state machine

The first public state vocabulary is:

- `accepted` — the Gateway durably reserved the run but the loop does not yet
  own it;
- `running` — the local runner owns the execution;
- `waiting` — execution is durably known to be paused on a bounded human or
  credential decision;
- `cancel_requested` — cancellation was requested but execution/effects have
  not yet been proven stopped;
- `succeeded` — the loop reached a normal terminal result;
- `failed` — the loop terminated with a safe classified failure;
- `cancelled` — user/system cancellation was observed by the loop and its
  finalizer completed;
- `timed_out` — the configured wall-clock limit was observed by the loop and
  its finalizer completed; and
- `indeterminate` — this Gateway can no longer prove the outcome, normally
  because the owning process disappeared at a non-atomic boundary.

`succeeded`, `failed`, `cancelled`, `timed_out` and `indeterminate` are terminal
for automatic local execution. `indeterminate` explicitly has
`outcomeKnown=false`: it must not be rendered as success, retried blindly or
treated as proof that external effects stopped. An explicit future reconcile
or operator correction may supersede it with audited evidence.

The transition policy is compare-and-set and forward-only. A terminal run
cannot be silently reopened. Cancellation changes a live run to
`cancel_requested`; only the runner finalizer may confirm `cancelled` or
`timed_out`. A watchdog may emit evidence and leave the run cancel-requested,
but it may not invent completion or delete the runtime sentinel while work is
known to remain active.

### Snapshot

`GET /api/v1/runs/{runId}` returns a bounded safe snapshot containing:

- run, thread, workspace and profile IDs;
- resolved model and enforced timeout;
- status, `terminal` and `outcomeKnown`;
- accepted, started, updated and optional terminal/cancel-request timestamps;
- root-event `startSeq`, optional `endSeq` and earliest retained cursor when
  that fact exists; and
- a stable safe failure/interruption code, never raw provider/tool text.

Authorization binds the run's persisted workspace/profile to the verified
principal before returning the snapshot or accepting a run-scoped action.

### Events and cursor boundary

A run owns a contiguous root-event interval on its thread because concurrent
runs on one thread are forbidden. `startSeq` is the root max sequence before
the run's `user.message`; `endSeq` is fixed by the finalizer after its last
terminal marker. These bounds are sufficient for the first additive snapshot
and two-turn fix.

The run-scoped event API uses this interval and exposes its retained-cursor
floor. If late/background producers can write outside the interval, those
writes must carry `runId` explicitly rather than extending bounds
heuristically. A client must not infer its run interval by scanning for the
first terminal event on the whole thread.

### Restart and retention

At boot, every `accepted`, `running`, `waiting` or `cancel_requested` row owned
by the vanished process becomes `indeterminate` with safe code
`gateway_restarted`. It never becomes succeeded/completed merely because no
in-memory loop survived.

Run rows are stored in the existing Gateway SQLite database and initially live
for the lifetime of their thread. Thread deletion cascades to its runs. No
automatic run pruning ships until snapshot/event/idempotency retention can be
proved together; deleting the last record of an uncertain outcome is unsafe.

## Consequences

- Two turns on one conversation have different run IDs and independently
  addressable snapshots.
- The start response and idempotency replay add `runId` without removing
  `threadId`, preserving older v1 clients.
- Thread status remains a legacy conversation/UI hint; public execution truth
  comes from the run snapshot.
- Migration, store transitions, two-turn identity, idempotency linkage and real
  restart recovery require tests before the public snapshot capability ships.
- SDK streaming must use run bounds rather than replaying from thread cursor
  zero. Public cancellation remains gated until abort no longer invents
  completion and confirmed finalizer states are verified.

## Rejected alternatives

- **Use thread ID as run ID.** A thread contains many turns.
- **Use the first/last terminal event found by a client.** Replaying a whole
  thread makes earlier terminals indistinguishable from the requested run.
- **Mark orphaned work completed on boot.** Process disappearance is not
  evidence of success or effect cancellation.
- **Treat abort acceptance as cancellation confirmation.** An abort signal may
  not stop a provider, tool or external effect.
- **Store raw errors or event payloads in the run row.** The event/message data
  plane already owns them; snapshots need safe codes and references only.
- **Add a separate run database or queue.** The existing transactional Gateway
  database is sufficient for this lifecycle record.
