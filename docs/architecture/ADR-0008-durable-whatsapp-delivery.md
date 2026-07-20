# ADR-0008: Durable WhatsApp ingress, delivery and handoff

- **Status:** Accepted
- **Date:** 2026-07-20
- **Decision owners:** Ownware maintainers

## Context

The WhatsApp Cloud API adapter already verifies Meta webhook signatures, checks
the addressed phone-number identity, drives a Gateway run and sends text replies.
Its reliability boundary is nevertheless process-local: webhook message IDs are
kept in an in-memory LRU, the provider is acknowledged before work is durably
owned, thread bindings disappear on restart, and a successful send request is
treated as delivery even though later webhooks carry the delivered/read/failed
outcome. A crash or lost HTTP response can therefore duplicate a run, lose an
inbound message, or blindly resend an effect whose provider acceptance is
unknown.

The generic Cortex channel-job store owns channel *setup procedures*. Reusing it
for customer messages would mix unrelated state machines and place raw channel
data in the kernel. Runtime message bytes and provider delivery semantics belong
to the Shuttle data-plane adapter that receives and sends them.

REC-08 selects one target only: the official WhatsApp Cloud API, inbound and
outbound text inside a customer-initiated conversation. Templates, media,
campaigns, cross-channel abstractions and claims about Meta-side queue depth are
outside this decision.

## Decision

### Ownership and storage

Shuttle owns an encrypted, local durable WhatsApp delivery store beside the
encrypted channel configuration. The store contains only the minimum material
needed to recover the flow: channel and phone-number identities, provider WAMID,
sender, pending text, deterministic run idempotency key, session-key to Gateway
thread binding, state timestamps,
content digests/lengths for outbound chunks, provider message IDs and status
codes. Pending inbound text is erased when processing reaches a terminal or
human-owned state. Secrets, headers, full webhook envelopes and provider
responses are never stored or logged.

Every mutation uses an atomic encrypted snapshot guarded by a cross-process lock.
The first durable write of a new `(channel_id, inbound_wamid)` happens before the
webhook returns `200`. A duplicate WAMID returns `200` without creating another
run. Records without a WAMID are unsupported and ignored rather than being
processed without a dedupe identity.

### Run recovery

Each inbound WAMID deterministically derives one UUID run-idempotency key. The
Shuttle adapter supplies it to `POST /run`. Owner and loopback-owner run starts
honour the same idempotency fence. Reprocessing a queued/ interrupted inbound
therefore reconnects to the original accepted run rather than submitting the
customer prompt again. An indeterminate Gateway start remains indeterminate and
is not replaced with a new run.

### Outbound effect truth

Before each text chunk is sent, the store records a delivery intent and attempt.
The transition model is:

`prepared -> accepted -> sent -> delivered -> read`

with terminal alternatives `rejected`, `failed` and `unknown`. A non-2xx Graph
response is a known rejection. A transport failure, malformed successful
response, or restart with an attempt stranded in `prepared` is `unknown`, because
Meta may have accepted the message. Unknown attempts are never resent
automatically. Status webhooks reconcile by provider message ID and may advance
accepted messages or mark them failed. "Replied" means every chunk was accepted;
"delivered" is used only after Meta emits that status.

### Human handoff

Handoff is an explicit protocol, not a text classifier. The exact customer
command `/human` creates one durable request and acknowledges that a person has
been requested. An authenticated local operator uses the channel CLI to list,
accept and later resume that request. Requested or accepted conversations do not
start agent runs; the operator answers through the connected WhatsApp Business
app/provider inbox. If that human reply surface is unavailable, handoff is not a
supported deployment claim.

Accept and resume are compare-and-set transitions. Resume affects only future
messages; it never replays messages received while a human owned the
conversation. The adapter does not infer a handoff from sentiment, keywords,
model prose or tool names.

### Recovery and retention

On boot, queued records are dispatched. Interrupted processing with no outbound
effect is re-queued under the same run idempotency key. A stranded prepared
outbound attempt becomes unknown. An inbound whose complete chunk set is already
accepted becomes replied without re-running. Provider status events are accepted
only for the configured phone-number identity.

Terminal dedupe/status metadata is retained for a bounded default of seven days;
pending, unknown, failed and human-owned records are retained for operator
recovery. Retention removes only terminal metadata and never changes an unknown
effect into a retryable one.

## Consequences

- WhatsApp text delivery survives process restarts without relying on the
  channel-setup job engine.
- The webhook can acknowledge durable ownership quickly while processing stays
  asynchronous.
- Operators can distinguish accepted, delivered, failed and unknown effects.
- A real provider/account round trip remains an owner-run verification lane;
  fake Graph fixtures prove the contract-shaped adapter, not Meta availability.
- Other channels receive none of this machinery until their own provider flow
  demonstrates the same need and maps its different receipt semantics.

## Rejected alternatives

- **Use the Cortex channel-job store.** It owns setup procedures, not runtime
  customer data or per-message provider effects.
- **Keep an in-memory WAMID LRU.** It cannot survive restart or prove durable
  ownership before acknowledgement.
- **Retry every failed fetch.** A lost response leaves provider acceptance
  unknown and a resend may duplicate the customer-visible message.
- **Treat Graph send success as delivery.** It proves only provider acceptance;
  status webhooks establish later states.
- **Detect handoff with keywords, regexes or model output.** That is a heuristic
  pretending to be authority. The first contract uses an exact command and an
  authenticated operator transition.
- **Build a provider-neutral durable delivery framework first.** WhatsApp is the
  only selected consumer and its WAMID/status/window semantics are provider
  specific.
