# @ownware/client

Talk to your Ownware agent from anywhere. The typed SDK over the gateway
wire contract (HTTP + SSE) — **zero dependencies**, works in Node and
the browser.

The server half is the [`ownware`](../ownware) package (`OwnwareGateway`, or just
`ownware serve`). This is the plug that connects to it.

## Five lines

```ts
import { OwnwareClient } from '@ownware/client'

const ownware = new OwnwareClient({ baseUrl: 'http://localhost:4000', token })
const { runId } = await ownware.run({ profileId: 'assistant', prompt: 'hello' })
if (!runId) throw new Error('Gateway does not support run snapshots')
for await (const ev of ownware.streamReply(runId)) {
  if (ev.type === 'delta') process.stdout.write(ev.text)
}
```

`token` is only needed when gateway auth is on (any non-loopback bind).
Read it from `<dataDir>/gateway-token`, or `gateway.token` in-process.

## The surface

| Method | Wire call | What it does |
|---|---|---|
| `capabilities(requirements?)` | `GET /api/v1/capabilities` | Negotiate a contract major and required capabilities as `available`, `unavailable`, or `incompatible` before a dependent mutation. |
| `issueDelegation(input)` | `POST /api/v1/auth/delegations` | Owner-only: mint a short-lived workspace/profile/purpose/operation-scoped bearer. Never give a browser the owner token. |
| `revokeDelegation(tokenId, reason)` | `POST /api/v1/auth/delegations/:id/revoke` | Owner-only: immediately revoke one delegated bearer by its public token ID. |
| `registerSource(input)` | `POST /api/v1/sources` | With a scoped delegated bearer and UUID idempotency key, register safe logical-source metadata without paths, URLs, bytes or storage detail. |
| `sources(options?)` | `GET /api/v1/sources` | Read a bounded page of safe manifests from only the bearer’s workspace/profile scope. |
| `source(id)` | `GET /api/v1/sources/:id` | Read one safe manifest; cross-scope identities are indistinguishable from absence. |
| `createSourceUploadSession(sourceId, input, idempotencyKey)` | `POST /api/v1/sources/:id/upload-sessions` | Open one bounded source-scoped upload with declared total bytes, checksum and media type. |
| `writeSourceUploadChunk(uploadId, input)` | `PATCH /api/v1/source-uploads/:id` | Stream one exact-offset, checksum-bound chunk; identical retries replay without a second append. |
| `completeSourceUpload(uploadId)` | `POST /api/v1/source-uploads/:id/complete` | Verify the whole object and atomically create or replay one immutable source version. |
| `sourceVersion(sourceId, versionId)` | `GET /api/v1/sources/:sourceId/versions/:versionId` | Read the safe immutable version manifest without placement or source content. |
| `validateCandidate(input)` | `POST /api/v1/candidates/validate` | Validate bounded base64 Agent Kit bytes and receive only an opaque identity and safe findings; never installs or activates. |
| `stageCandidate(input)` | `POST /api/v1/candidates/stage` | Revalidate and privately stage exact candidate bytes with explicit ready/failure state; never activates. |
| `activateCandidate(input)` | `POST /api/v1/candidates/activate` | Compare-and-set one ready candidate against the expected active identity; returns the actual active state. |
| `rollbackCandidate(input)` | `POST /api/v1/candidates/rollback` | Restore a named ready candidate under CAS; distinguishes rollback failure and actual active identity. |
| `pauseProfile(input)` | `POST /api/v1/profiles/:id/pause` | With an exact revision and UUID idempotency key, block every new run while reporting existing pinned runs. |
| `resumeProfile(input)` | `POST /api/v1/profiles/:id/resume` | Reverify the active candidate, then reopen new-run acceptance under an exact revision fence. |
| `candidate(id)` | `GET /api/v1/profile-candidates/:id` | Read safe lifecycle, size and deletion eligibility without host paths or profile bytes. |
| `candidates(profileId)` | `GET /api/v1/profiles/:id/candidates` | List bounded candidate status in one profile scope. |
| `deployment(profileId)` | `GET /api/v1/profiles/:id/deployment` | Read active candidate, monotonic revision, routing, observed health and drain count. |
| `deleteCandidate(id)` | `DELETE /api/v1/profile-candidates/:id` | Delete only an unreferenced candidate; active, in-flight and rollback-retained candidates reject. |
| `profiles()` | `GET /api/v1/profiles` | Read the minimal safe catalog; delegated callers see only their scoped profile. |
| `run(input)` | `POST /api/v1/run` | Send a message with optional bounded one-turn untrusted attachments. Pass a UUID `idempotencyKey` and reuse it only to retry the exact request; delegated principals require one, plus `runs.attachments` when attachments are present. |
| `runSnapshot(runId)` | `GET /api/v1/runs/:runId` | Read the bounded durable lifecycle for one execution, including truthful indeterminate restart state. |
| `streamReply(runId, opts?)` | SSE `GET /runs/:id/events` | ONE bounded reply as `delta` → `done`/`error`. A legacy thread ID still uses the older unbounded thread route. |
| `events(runId, opts?)` | same SSE | The RAW event stream for one run — tool calls, permission requests, usage, everything. |
| `resume(threadId, { action })` | `POST /threads/:id/resume` | Owner-only legacy UI compatibility; delegated/public callers cannot use this bulk-capable route. |
| `decidePermission(runId, requestId, input)` | `POST /runs/:runId/permissions/:requestId/decision` | Decide one exact request using its emitted `operationHash`; never bulk-decides siblings. |
| `cancel(runId)` | `POST /runs/:runId/cancel` | Durably request cancellation of one exact run; `cancel_requested` is not confirmed cancellation. |
| `abort(threadId)` | `POST /threads/:id/abort` | Owner-only legacy UI compatibility; delegated/public callers cannot use this thread route. |
| `models()` | `GET /api/v1/models` | The catalog with live availability (`hasCredentials`). |
| `health()` | `GET /api/v1/health` | Liveness (the one unauthenticated route). |

Continue a conversation by passing the same `threadId` to the next `run`, but
stream each returned `runId` independently. Reconnect a dropped stream by
passing the highest `seq` you saw as `{ since }`. Invalid, earlier-run,
ahead-of-run and expired cursors fail explicitly instead of replaying from zero;
`runSnapshot(runId).earliestRetainedCursor` reports the current safe floor.
When a profile uses immutable candidates, both `run()` and `runSnapshot()`
carry the candidate identity pinned before execution. A later activation does
not rewrite an existing run; the next run rebuilds a cached thread when needed.
Pause is durable routing state: API, scheduled and channel work share the same
acceptance fence, while already accepted runs keep their candidate pin and
drain. Health is observed evidence with a timestamp; missing evidence remains
`unknown`, never healthy by default.
Candidate deletion uses the content-addressed candidate ID as its natural retry
identity. A successful response means the runtime verified the bytes are gone;
`delete_failed` is explicit non-success. Active, non-terminal-run and immediate
rollback references remain protected.

Source registration creates a logical resource and a pending multi-dimensional
health manifest; it does not upload or expose content. Workspace and profile
authority come only from the delegated bearer. Equal metadata under distinct
idempotency keys stays separate, while retrying one exact key replays the same
`sourceId`. `currentVersionId` remains `null` until an accepted immutable
version exists. Upload sessions accept only declared bytes through bounded
chunks—never paths or URLs—and completion verifies whole-object checksum and
text/PDF shape before advancing the logical manifest. Missing inspection or
freshness evidence stays explicit rather than being projected as ready.

For a write-safe retry, generate one UUID per logical turn and pass it as
`idempotencyKey`. Matching retries within seven days replay the accepted
thread reference; conflicting input or an indeterminate prior-boot outcome
throws a typed `OwnwareError` instead of starting another run.

An available capability result also includes the limits enforced by that
Gateway instance: the 10 MiB parsed-JSON ceiling, candidate file/decoded-byte/name
limits, run-attachment limits, the source page ceiling, delegation lifetimes,
seven-day idempotency replay window, and its enabled/disabled rate-limit
values. A successful `run()` result carries `timeoutMs`, the wall-clock limit
selected from the resolved profile. Older v1 Gateways may omit `limits` and
`timeoutMs`; the SDK keeps both optional for additive compatibility.

## What it handles for you

- **SSE over `fetch`, not `EventSource`** — bearer auth needs headers;
  `EventSource` can't send them.
- **Run termination** — the root SSE never closes on its own; a reply is
  finished at a terminal `turn.end` (stop reason not `tool_use` /
  `pause_turn`) or on interrupt/error/shutdown. `streamReply` encodes
  that so you never hang on a finished run.
- **Resume cursors** — every event carries `seq`; `{ since }` resumes
  a dropped connection without replaying history.
- **Typed safe failures** — HTTP failures throw `OwnwareError` with
  `status`, stable `code`/`category`, an opaque `correlationId`, and optional
  `retryAfterSeconds`. Unknown legacy bodies are not copied into the message.

## The wire contract

The endpoints and event vocabulary this SDK wraps are versioned next to
the code: [`spec/openapi.yaml`](./spec/openapi.yaml) (REST) and
[`spec/asyncapi.yaml`](./spec/asyncapi.yaml) (SSE events). Anything not
in the spec is internal and may change without notice.

Call `capabilities()` when your integration depends on an optional or
newer operation. Capability absence is `unavailable`; a different URL
contract major is `incompatible`. Do not probe undocumented routes.
See [`COMPATIBILITY.md`](./COMPATIBILITY.md) for the v1 revision matrix.

Prefer no SDK at all? The contract is small enough to use raw — see
[`examples/custom-client/chat.mjs`](../../examples/custom-client/chat.mjs),
a complete client in ~100 lines of plain `fetch`.
