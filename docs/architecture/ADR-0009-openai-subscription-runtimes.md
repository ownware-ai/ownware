# ADR-0009: OpenAI subscription runtime boundaries

- **Status:** Accepted
- **Date:** 2026-07-26
- **Decision owners:** Ownware maintainers

## Context

Ownware supports model providers through its own agent loop. OpenAI also
provides Codex as a complete external agent runtime and allows eligible users
to authenticate Codex with a ChatGPT account.

Those are different mechanisms:

- changing model access while retaining Ownware's loop keeps Ownware's prompt,
  tool, memory, compaction and event semantics, subject to the selected
  transport accepting them;
- selecting Codex as an external runtime hands the loop to Codex, so prompts,
  tools, approvals, history and events must be translated at the kernel
  boundary.

Treating both as provider credentials would conceal the change in execution
semantics. Treating an OAuth credential as proof of subscription billing or
capability would also overclaim what authentication establishes.

The official Codex app-server is a new local process dependency and a new
provider data path. OpenAI explicitly documents app-server as an embedding
surface, including ChatGPT login and an experimental host-managed ChatGPT
token input. A direct ChatGPT Codex transport is a separate, experimental data
path because those documents do not establish an independent third-party
Responses transport contract. This narrows Ownware's support claim; it does
not infer a legal conclusion from provider silence.

## Decision

### Execution runtime and model access are separate types

Runtime selection is represented as a strict union of valid pairs:

| Execution runtime | Model access route | Support |
|---|---|---|
| `ownware` | `provider-api` | supported, existing default |
| `ownware` | `openai-chatgpt-direct` | experimental |
| `openai-codex` | `openai-chatgpt-managed` | supported subscription route |

An absent selection retains `ownware` + `provider-api` for existing profiles.
Unknown values, extra fields and invalid runtime/access pairs are rejected at
the configuration boundary. They never fall back to a known route.

Support status is derived by Ownware from the selected mechanism. A caller
cannot relabel the direct route as supported.

### Runtime ownership

The Ownware runtime continues through the existing engine session.

The OpenAI Codex runtime is implemented as an external runtime in the kernel.
It starts and supervises `codex app-server`, translates its protocol to
Ownware's canonical events and permission requests, and never adds
app-server/CLI branches inside the engine.

The direct route remains an engine provider/access transport. Credential
resolution and token custody stay behind the kernel credential boundary; the
engine receives only the narrow request transport it needs.

### Capability claims carry evidence

A runtime plan records capability assessments as
`supported | unsupported | unknown`. Every assessment includes:

- an open-world capability key;
- a plain-language detail;
- the authority and source establishing the assessment;
- when it was observed; and
- an expiry timestamp or explicit `null` when no defensible freshness window
  exists.

An absent expiry produces `unknown` freshness, not “current.” Expired evidence
is stale. Capability keys are open strings so adding a capability does not
require a central enum edit; evidence authorities and statuses are bounded
because they control claim semantics.

A schema declaration or provider self-description does not prove a tool or
effect. Later slices must observe tool invocation at the handler/effect
boundary and account/quota state at the route-specific authority.

### Threads are bound immutably

A thread records one runtime selection when it is created. Repeating the same
binding is idempotent. Attempting to change the runtime or access route on the
same thread fails with a typed conflict.

Switching routes is an explicit migration that creates a different thread and
records the source thread ID. Conversation material may be copied later, but
hidden runtime state, tool effects, approvals, checkpoints and memories are
not implied to migrate.

There is no silent failover or automatic replay across runtimes. If a failure
occurs after a request may have produced output or an effect, Ownware reports
an ambiguous outcome and requires a person to choose recovery.

### Official app-server data path

The supported subscription route is:

```
Ownware kernel → local codex app-server → OpenAI
```

Codex owns ChatGPT login, token persistence and refresh for this route.
Ownware consumes app-server account, model and rate-limit methods and stores
only safe local references/status required by its own thread lifecycle.

The child process runs with an Ownware-managed, isolated Codex configuration.
It must not inherit arbitrary global MCP servers, plugins, skills or tool
settings. Profile-approved Ownware tools are exposed through a run-scoped MCP
bridge and existing permission enforcement.

The managed configuration is replaced atomically and parsed under
`--strict-config`. It disables analytics, apps, plugins and ambient skill
search, and declares exactly one loopback MCP server. Configuration intent is
not accepted as proof: before a turn the kernel disables every discovered ambient
skill and re-lists it, requires `app/installed` to expose no enabled/callable
app, requires `plugin/installed` to expose no enabled installed plugin, and
requires `mcpServerStatus/list` to expose only the run's exact immutable tool
set. Missing, malformed or additional capability state blocks the turn.

Each run registration has an unguessable bearer capability. The bridge
validates tool definitions and arguments, executes through the normal engine
tool permission/redaction boundary, deduplicates identical request identities
and rejects conflicting reuse. Receipts contain digests and bounded state, not
arguments or results. Handler entry for a mutating tool proves only
`effect_possible`; `effect_confirmed` requires a caller-supplied durable-effect
observer with a named authority. Observer failure is outcome-unknown. Writing
an HTTP response does not prove delivery, so delivery remains unknown until a
later app-server event can be correlated.

The pinned sandbox denies network and constrains writes to canonical approved
roots, but it does not confine host reads. Ownware therefore presents a
content-bound `host_read_scope` limitation and requires explicit acceptance.
Unknown sandbox modes, symlink root identities, broad network and
`dangerFullAccess` fail. Native command and file approval callbacks map into
Ownware's existing one-turn permission channel; direct permission expansion
and provider-proposed persistent amendments are denied.

The app-server protocol is versioned independently. Ownware declares a tested
version/platform envelope, validates initialization before a customer turn and
fails visibly for missing, incompatible or malformed implementations.

The first supported envelope is Codex `>=0.145.0 <0.146.0`, generated and
tested against the installed `0.145.0` schema. Initialization identifies the
client as `ownware`; an enterprise distribution must use OpenAI's documented
known-client registration path rather than another product's identity.

The process receives an absolute, Ownware-managed `CODEX_HOME`, and the
initialize response must report the same canonical filesystem identity. Parent
`HOME` is not rewritten. Stdout is strict JSONL. Stderr content is never
retained; diagnostics contain only bounded process metadata. Teardown closes
stdin, escalates through `SIGTERM` and `SIGKILL`, and reports failure unless
process exit is observed.

Codex remains the credential custodian. Ownware starts/cancels the documented
browser or device login RPCs and consumes redacted account state; it never
reads or copies Codex's auth file. Account email, provider error prose,
authorization URLs and device codes do not enter inspectable runtime state or
logs. One-time login presentation values are returned only to the initiating
caller.

`account/read` with Codex-managed refresh is the pre-turn authentication
authority, while the later model request remains the authority for whether a
turn is actually served. `model/list` is the only official-route catalogue and
its ordering is preserved. ChatGPT allowance comes only from
`account/rateLimits/read` and sparse updates; missing or malformed information
is `unknown`, never zero. All observations are timestamped with no invented
freshness interval.

### Official thread, event and recovery authority

The app-server's original notification/request order is consumed through one
bounded queue. Separate notification and approval consumers may filter that
queue, but they cannot duplicate or reorder the underlying wire stream.

A live turn becomes terminal only from one exact, scope-matching
`turn/completed` notification. Interrupt acknowledgement records only that
cancellation was requested. Retry errors, item/text completion and process
exit cannot imply turn success. Unknown event payloads are discarded after a
bounded source-type classification and make the execution indeterminate where
their meaning could affect authority.

Ownware persists a columnar thread reference containing only local/remote
thread IDs, a keyed HMAC account binding, model/provider, accepted
profile/sandbox report IDs, timestamps, active consequence and the last
provider-authoritative terminal. It has no JSON or free-form metadata column.
Each semantic transition increments a revision, and SQLite writes use
compare-and-swap so a stale process cannot erase an active turn or convert
`outcome_unknown` back to ready. Deleting the local thread cascades the
reference.

A restart with an active turn does not automatically replay. `thread/read`
with history may establish that the exact turn reached a terminal state. That
history authority can close an output-only turn, but if any external effect
was possible or confirmed, recovery remains `outcome_unknown` and needs a
person. Provider history content is not copied into the safe reference.

Remote inspect, archive and delete use the exact pinned schema. An opaque read
rejection is reported as unavailable; Ownware does not infer that a thread is
missing from an error code that does not authoritatively prove that fact.

### Official profile compatibility

An Ownware profile is not assumed to be capability-equivalent across the
external-loop boundary. Before app-server wire input is emitted, the kernel builds
a compatibility report whose mapped entries name the pinned protocol field
that carries them and whose limitations are either blocking or require an
explicit continue-with-limitations decision.

The decision is content-bound. Its report ID covers the relevant profile
configuration, trusted instructions, selected account-catalogue model,
approved source revisions, image bytes, selected skill files and working
directory. Reusing a decision after any of that material changes fails as
stale. Reports and stable errors contain none of the underlying private text or
paths.

Mapping is deliberately narrow:

- SOUL/inline profile identity is a developer instruction via
  `thread/start.developerInstructions`; Ownware does not replace Codex base
  instructions.
- The user request and approved source material remain text user input. Source
  material is labelled untrusted data and excluded from developer
  instructions.
- A model is accepted only from the current `model/list` observation and is
  passed through `thread/start.model`.
- An approved image is a typed `localImage`, never a textual placeholder. Its
  canonical path must remain inside an approved root and its bytes must fit
  Ownware's declared preflight envelope and a supported image signature.
- An explicit skill uses both the documented `$skill` marker and typed `skill`
  input. It must be active, unchanged, nested under the profile as
  `<skill>/SKILL.md`, and must not rely on an unenforced Ownware tool allowlist.

Arbitrary file attachments, unknown profile/attachment fields, hooks, critical
reminders, spend caps and tool policies do not cross silently. Profile tools
cross only when the exact assembler output, immutable run registration and
app-server MCP discovery agree; a tool-bearing runtime for a tool-free profile
blocks. Other loop-owned behavior—memory, compaction, delegation, granular
context toggles, token/turn limits and tuning—is reported as a semantic
difference.

The profile mapper retains a read-only/no-approval preview fence. The official
run-plan composer replaces it only after the profile compatibility decision,
sandbox limitation decision and live scoped-tool authority are all ready. This
is not a claim of complete Ownware security-policy equivalence.

The compatibility report proves deterministic mapping and explicit customer
choice. It does not prove that the model will obey source-data guidance, that a
provider will accept an attachment, or that a later turn will be served.

### Experimental direct data path

The experimental route is:

```
Ownware engine → direct ChatGPT Codex transport → OpenAI
```

It uses only the person's own local account and does not pool accounts, share
credentials, evade provider limits or substitute an API key. Selection
requires the literal opt-in `experimentalOptIn: true` and the exact accepted
capability envelope `openai-chatgpt-direct.v1`; a missing opt-in, old loose
configuration or unknown future envelope fails at the configuration boundary.
It has a separately probed model/request capability envelope. Unsupported
fields are rejected before sending or surfaced as provider failures; they are
never deleted silently.

Authentication and billing remain independent. OAuth does not establish a
subscription allowance, a subscription allowance is not represented as a
zero-priced metered call, and a missing metered price is `unknown`. Generic
HTTP rate-limit headers and 429s are response-scoped provider signals, not
authority for plan allowance or proof that the plan is exhausted.

Direct-token refresh coordination lives at the durable SQLite boundary, not
inside one manager object. A credential-scoped lease is acquired atomically,
renewed while the issuer call is in flight and released by owner identity.
After acquisition the token is re-read through the normal credential gates,
so a waiter observes a winner's rotation rather than refreshing the consumed
token again. Rotation and terminal health writes use an opaque revision of
the encrypted value plus credential status as a compare-and-swap fence; an
operator revocation or another token writer cannot be overwritten by a stale
refresh result. Normal `lastUsedAt`/display-metadata writes do not create
false token conflicts.

Lease rows contain only the Ownware credential id, an opaque owner nonce and
timestamps; token material remains solely in the encrypted credential value.
A crashed process can be replaced only after the bounded lease expires. Loss
of lease ownership or a stale conditional write is a visible coordination
failure, never permission to return an unpersisted token.

If a permanent issuer denial cannot be persisted, Ownware surfaces a distinct
credential-state persistence error and quarantines that credential for the
remaining process lifetime. This cannot claim cross-process durability while
the database write boundary itself is unavailable; the explicit error is the
honest fallback. Quota observers are isolated from the answer path, but every
observer exception must be sent to a separate required diagnostic observer so
reporting cannot remain silently broken.

Provider acceptance of a real request is required before this route can be
called operational. Synthetic issuer/endpoint tests prove only Ownware's
wiring.

The engine-side Responses translator is manually wired and is not a provider
registry default. It owns syntax and stream normalization only; the kernel still
owns route selection, credential resolution and the experimental support
decision. The translator reconciles deltas against item and terminal
snapshots, fails on unknown material output, and never treats a passing fake
transport as provider acceptance.

The kernel exposes one direct-provider constructor at that boundary. It accepts
only the explicit `ownware/openai-chatgpt-direct` selection, an OAuth access
token source, per-attempt audit context and an explicit HTTPS route
configuration. It rejects embedded URL credentials, query/fragment endpoint
configuration, a pre-materialised `/responses` URL, protected static
credential headers, account-header collisions and unknown account modes.
When the route requires an account identifier, absence fails before the model
endpoint. The constructor disables SDK-internal retry so a local credential
or route-authority failure is not repeated or relabelled as a network error;
higher-level retry remains governed by the normal Ownware loop.

The constructor marks provider usage as `subscription_allowance`. The engine keeps
the provider's token counts but does not apply the API-key pricing table.
That basis survives turn/session totals, side calls, metrics and checkpoint
restore; mixed billing bases become `unknown` rather than a false unified
claim. A numeric zero in those records is therefore an accumulator
placeholder, not a claim that the model has a zero-dollar API price.

This constructor is not a gateway/CLI selection surface. Public selection,
immutable thread binding and migration remain separate follow-up work. Constructibility
does not establish the current real endpoint, login transaction, entitlement,
model catalogue or provider acceptance.

Opaque reasoning state is outside the current generic message contract.
A one-turn reasoning summary may be displayed, but the direct adapter does not
declare general thinking support and rejects prior thinking blocks rather than
replaying summary prose as provider state. Reasoning across tool turns remains
unsupported; reasoning-plus-tools fails before the request so no tool effect
can create an unreplayable continuation. A future provider-state contract must
retain issuer-bound opaque items without leaking them across endpoints.

## Consequences

- Existing profiles retain their current behavior.
- The official subscription route can be added without making the engine aware
  of external CLIs or app-server protocol details.
- The direct route can preserve Ownware-native behavior without being confused
  with the official Codex loop.
- A new external runtime adds one strict runtime/access branch plus a kernel
  adapter and contract tests. A new capability does not require a central
  catalogue edit.
- Runtime selection and capability evidence are public package contracts, but
  no app-server execution is implied until its adapter slice ships.
- Thread migration is additive and explicit; in-place switching remains
  structurally unavailable.

## Verification

The first contract slice proves:

- legacy/default and both explicit selections;
- rejection of mismatched, unknown and extra configuration;
- derived supported/experimental status;
- supported, unsupported and unknown capability evidence;
- current, stale and unknown freshness;
- duplicate/malformed evidence rejection;
- idempotent thread binding, in-place switch rejection and explicit
  new-thread migration; and
- export through the `@ownware/cortex` public boundary.

Process supervision, authentication, live capability discovery, tools and real
provider calls are intentionally separate slices with their own contract and
real-flow tests.

The process-supervision slice additionally proves version rejection before
spawn, both accepted response-envelope shapes, concurrent request correlation,
malformed/corrupt output, unknown methods, bounded queues, startup and request
timeouts, mid-request exit, stderr-content redaction, interrupt framing,
idempotent bounded shutdown, isolated configuration, model listing and
persisted-thread create/delete against the installed app-server. Authentication,
account/quota translation, profile semantics, tools and full turn mapping
remain separate decisions.

The profile-compatibility slice additionally proves developer-instruction
authority, source/user-role separation, account-catalogue model binding,
content-bound stale decisions, open-world failure, typed image containment and
signature checks, explicit nested-skill invocation, private-content redaction,
and visible native-engine limitations.

The scoped-tool slice additionally proves strict managed configuration,
ambient skill/app/plugin denial, exact MCP discovery, per-run bearer
capabilities, schema/argument rejection, one-execution duplicate handling,
permission denial and channel failure, native approval identity, path/symlink
containment, network denial, secret redaction, effect ambiguity, capability
revocation and installed-process teardown. A local installed `0.145.0` canary
observed three exact tools, disabled nineteen ambient skills, saw zero callable
apps and zero enabled plugins, performed one approved temporary write, verified
it by read-after-write, invoked one synthetic tool, deleted the disposable
thread and removed the managed home. No model call or subscription credential
was used.

The thread/runtime slice additionally proves ordered translation, exact
terminal scope, duplicate/conflicting terminal rejection, native approval
round trips, cancellation acknowledgement versus completion, process-death
ambiguity, exact account/model/plan/prompt binding, MCP delivery correlation,
columnar CAS persistence, restart history recovery, effectful no-replay, and
strict inspect/archive/delete acknowledgement. Its deterministic contract lane
has 164 passing tests across 15 files. The real subscription-backed
multi-turn/tool/cancel/restart matrix remains a release gate rather than being
inferred from fixtures.

The direct-risk slice additionally proves explicit experimental opt-in,
versioned capability-envelope rejection, derived experimental status,
authentication/billing separation, unknown missing metered price, and
response-scoped rate-limit language. Its focused lane has 157 passing tests
across nine files; a public-boundary dry run rejected an old loose config and
a future envelope without attempting login or a model call. Synthetic
issuer/endpoint tests remain wiring proof only. Real direct-provider
acceptance remains required before the route can be described as supported.

The direct-token lifecycle checkpoint additionally proves durable
credential-scoped lease ownership across independent SQLite connections,
lease heartbeat/loss/expiry, winner re-read, encrypted-value revision + status
CAS, operator-revocation race rejection, explicit state-persistence failure
with process-local quarantine, and isolated quota-observer diagnostics. Its
focused lane has 92 passing tests across five files; the full credential lane
has 661, and eight migration tests include a real v79→v80 upgrade. The full
kernel suite has 3,588 passed / 23 skipped and the full engine suite has 1,157
passed. No login, subscription credential, issuer or model call was used;
actual provider login/refresh/revocation remains a release gate.

The provider-independent Responses checkpoint additionally proves canonical
text/image/custom-function request translation, dynamic bearer/header/base-URL
construction per call, ordered terminal snapshot reconciliation, strictly
monotonic stream sequencing, usage/refusal/incomplete mapping, cancellation,
stall handling, tool pairing, unknown-event failure and stable error
redaction. Its focused lane has 27 tests; the broader provider lane has 302;
and the keyless engine suite has 2,698 passed / 76 skipped. Engine typecheck,
package build, built-export smoke and scoped lint pass. All model credential
variables were blank, so this remains codec/SDK proof rather than direct
provider acceptance.

The kernel construction checkpoint additionally proves strict direct-route
selection, OAuth bearer/account-header composition, protected-header and URL
rejection, pre-network required-account failure, native-loop execution and
subscription billing-basis propagation. Ten direct-construction tests and
fifteen side-call/cost tests pass; the keyless engine suite has 2,700 passed /
76 skipped and the keyless kernel suite has 4,489 passed / 166 skipped.
Kernel/engine builds and typechecks, the built kernel export smoke, focused
runtime/OAuth/provider tests and diff hygiene pass. The CLI and gateway run
schema were not changed, and no login, account, token or real model endpoint
was used.

## Rejected alternatives

- **Implement app-server as an engine provider.** It would run two agent loops
  while pretending only a model transport changed.
- **Infer execution from credential type.** OAuth proves an authentication
  mechanism, not runtime ownership, subscription allowance or cost.
- **Use one loose `{ runtime, access }` object.** It permits semantically false
  combinations and pushes failure deep into execution.
- **Accept unknown values as the default.** A future runtime or typo would
  silently execute through the wrong loop.
- **Inherit the user's global Codex configuration.** Unrelated tools and
  permissions could enter a profile without a grant.
- **Silently retry in the other runtime.** A lost acknowledgement could replay
  an external effect.
- **Advertise the direct transport as equivalent or supported.** Its provider
  contract and capability envelope are not the same as app-server or the
  platform API.
