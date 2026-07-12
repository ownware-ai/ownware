# ADR-0003: Durable run idempotency and retention boundary

- **Status:** Accepted
- **Date:** 2026-07-12
- **Decision owners:** Ownware maintainers

## Context

`POST /api/v1/run` currently relies on an in-memory map keyed by thread ID.
That prevents two simultaneous turns on one known thread in one process, but it
is not an idempotency contract. A retry without a thread ID can create another
thread; a retry after restart can append another user message and start another
provider/tool loop. The handler currently writes thread, session, message and
event state before the runner is started, so a disconnect or crash does not
tell the caller whether execution began.

The root-agent event stream is durable in SQLite, but optional retention can
delete all root events for a quiet thread. There is not yet an immutable run ID,
run snapshot or retained cursor floor. Returning an empty replay therefore
cannot honestly distinguish "nothing happened" from "the requested cursor was
pruned".

## Decision

### Idempotency key and scope

Public run start accepts an `Idempotency-Key` header containing a UUID. One key
identifies one logical `runs.start` request and must not be reused for different
input. Existing owner clients may omit the header for v1 compatibility.
Delegated principals must provide it before a run mutation is attempted.

The durable uniqueness scope is:

1. public operation identifier;
2. authenticated principal continuity key; and
3. idempotency key.

The owner continuity key is the local owner role. A delegated continuity key
is derived from its verified delegate, workspace, profile, purpose and channel
claims, so a short-lived token can be renewed without losing retry protection.
No bearer token or signing material enters the idempotency row.

### Request fingerprint

The Gateway canonicalises the validated operation input and computes a salted
SHA-256 digest. Each row has a random salt so a database reader cannot cheaply
dictionary-test short prompts against an unsalted digest. The raw request,
prompt, attachment bytes, credentials and headers are never stored in the
idempotency table.

The same scoped key with a different fingerprint returns typed
`idempotency_conflict` before mutation. The key does not mean "run this latest
body once"; it means "identify this exact logical request."

### Durable states and crash truth

An additive table records `in_progress`, `completed` or `indeterminate` plus a
random process lease owner, timestamps and a bounded safe result snapshot.
Claiming a new key and detecting an existing key are one SQLite transaction.

- A new claim becomes `in_progress` before thread, message, event, provider or
  tool mutation.
- A retry of a `completed` claim returns the same thread/result reference and
  does not call the runner.
- A matching `in_progress` claim owned by this boot returns typed
  `idempotency_in_progress` with retry guidance.
- An `in_progress` claim from another boot is atomically changed to
  `indeterminate`. It is never executed automatically because the prior process
  may have crossed an external-effect boundary.
- Any failure after a claim which cannot prove that no mutation occurred marks
  it `indeterminate`. Recovery is an explicit inspect/cancel/reconcile flow,
  not a blind retry.

The first result snapshot contains only the public run-start identifiers and
model/status fields needed to replay the accepted response. It contains no
prompt, attachment metadata or execution output. ADR-0004 adds the immutable
run ID and truthful run snapshot without weakening this fence.

### Retention

Completed idempotency records are retained for seven days by default. Within
that documented window, a matching retry is guaranteed not to start another
run. In-progress and indeterminate rows are not age-pruned automatically;
deleting uncertainty would make a later retry look safe. Clients generate a
fresh UUID for each new logical action and must never deliberately recycle an
expired key.

The current root-event retention switch remains an internal, default-off
facility. It is not a public cursor-retention guarantee. It must not be enabled
for a deployment claiming the public reconnect contract unless it also has:

- immutable run identity and terminal snapshot;
- the earliest retained cursor/watermark;
- typed `cursor_invalid`, `cursor_mismatch` and `cursor_expired` responses; and
- a tested snapshot-then-tail recovery path.

Run-snapshot retention is therefore a separate public-contract decision. This
ADR deliberately does not infer run identity from thread identity or claim that
the existing messages snapshot proves execution/effect completion.

## Consequences

- A network retry or process restart cannot silently duplicate an accepted run
  inside the seven-day guarantee window.
- A crash at an ambiguous boundary stays visible as indeterminate; it is not
  converted into invented success or an automatic rerun.
- The Gateway uses its existing SQLite data-plane database; no new persistence
  system, queue or cross-tenant path is introduced.
- Schema migration, store transitions, conflict/replay behavior and a real
  Gateway restart require tests. The first tracer covers one completed replay,
  one payload conflict and one prior-boot in-progress claim.
- Capability and SDK documentation must state whether a run start used the
  durable fence. Route existence alone is not proof of support.

## Rejected alternatives

- **Use thread ID as the idempotency key.** A thread has many turns, and a new
  request often has no thread yet.
- **Keep a process-local key map.** It loses the only fact needed after a crash.
- **Hash the request without a random salt.** Short prompts are guessable from a
  copied database.
- **Delete or retry stale in-progress rows on boot.** The old process may have
  called a provider or tool before dying.
- **Store the full response/request for replay.** It unnecessarily duplicates
  prompts, attachment names and other runtime data.
- **Promise cursor retention from the current event table.** Pruning has no
  retained floor or run snapshot, so that promise would be false.
