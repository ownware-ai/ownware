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
| `issueDelegation(input)` | `POST /api/v1/auth/delegations` | Owner-only: mint a short-lived workspace/profile/purpose/operation-scoped bearer. Bind an explicit `subjectId` for protected content reads/searches and Data View queries; never give a browser the owner token. |
| `revokeDelegation(tokenId, reason)` | `POST /api/v1/auth/delegations/:id/revoke` | Owner-only: immediately revoke one delegated bearer by its public token ID. |
| `connections(options?)` | `GET /api/v1/connections` | Owner-only: list the latest provider-neutral connection states and fixed recovery guidance without vendor, credential, session, install-identity or raw-error detail. |
| `registerSource(input)` | `POST /api/v1/sources` | With a scoped delegated bearer and UUID idempotency key, register safe logical-source metadata without paths, URLs, bytes or storage detail. |
| `sources(options?)` | `GET /api/v1/sources` | Read a bounded page of safe manifests from only the bearer’s workspace/profile scope. |
| `source(id)` | `GET /api/v1/sources/:id` | Read one safe manifest; cross-scope identities are indistinguishable from absence. |
| `createSourceUploadSession(sourceId, input)` | `POST /api/v1/sources/:id/upload-sessions` | Open one bounded source-scoped upload with declared total bytes, checksum and media type; `input.idempotencyKey` identifies the logical request. |
| `writeSourceUploadChunk(uploadId, input)` | `PATCH /api/v1/source-uploads/:id` | Stream one exact-offset, checksum-bound chunk; identical retries replay without a second append. |
| `completeSourceUpload(uploadId)` | `POST /api/v1/source-uploads/:id/complete` | Verify the whole object and compare-and-set one immutable source version against its server-captured base. |
| `sourceVersion(sourceId, versionId)` | `GET /api/v1/sources/:sourceId/versions/:versionId` | Read the safe immutable version manifest without placement or source content. |
| `createSourceJob(sourceId, versionId, input)` | `POST /api/v1/sources/:sourceId/versions/:versionId/jobs` | With a UUID idempotency key, enqueue the allowlisted format inspection for one exact immutable version. |
| `createSourcePreparation(sourceId, versionId, input)` | `POST /api/v1/sources/:sourceId/versions/:versionId/preparations` | With a UUID idempotency key, enqueue `extract_text` or strict CSV `prepare_data_view` for one eligible inspected current version. |
| `sourceJob(jobId)` | `GET /api/v1/source-jobs/:jobId` | Poll safe durable inspection or preparation progress, including implementation and either the published resource or Data View identity, without worker, storage, cells, content, or raw diagnostic detail. |
| `sourceResource(resourceId)` | `GET /api/v1/source-resources/:resourceId` | Read the closed content-free lineage, policy, coverage and freshness manifest for one derived resource. |
| `sourceDataView(dataViewId)` | `GET /api/v1/source-data-views/:dataViewId` | With separate authority, read validated field identities, untrusted header labels, lineage, counts and freshness without cells, row values or private placement. |
| `createDataViewQueryGrant(dataViewId, input)` | `POST /api/v1/source-data-views/:dataViewId/access-grants` | Owner-only: grant one explicit subject exact current fields and one bounded row window under a fixed observe-only query fence. |
| `querySourceDataView(dataViewId, input)` | `POST /api/v1/source-data-views/:dataViewId/query` | With subject-bound delegation and a matching live grant, return only an exact field list and bounded row window with verified current lineage. |
| `createAccessGrant(resourceId, input)` | `POST /api/v1/source-resources/:resourceId/access-grants` | Owner-only: create one observe-only subject/purpose/consent fence for protected text read or search. |
| `accessGrant(grantId)` | `GET /api/v1/access-grants/:grantId` | Owner-only: read one current immutable grant revision without content or private placement. |
| `accessGrants(options?)` | `GET /api/v1/access-grants` | Owner-only: list a bounded page of current grant revisions and lifecycle truth. |
| `revokeAccessGrant(grantId, input)` | `POST /api/v1/access-grants/:grantId/revoke` | Owner-only: compare-and-set exact grant revision to revoked with durable idempotent replay. |
| `readSourceContent(resourceId, input)` | `POST /api/v1/source-resources/:resourceId/content` | With subject-bound delegation and a matching live read grant, return one verified bounded UTF-8 range. |
| `searchSourceContent(resourceId, input)` | `POST /api/v1/source-resources/:resourceId/content/search` | With separate subject-bound search authority and grant, return bounded byte-addressed literal evidence. |
| `cancelSourceJob(jobId)` | `POST /api/v1/source-jobs/:jobId/cancel` | Request cancellation; poll until `cancelled` or another terminal state because a request is not confirmation. |
| `createSourceDeletion(sourceId, input)` | `POST /api/v1/sources/:sourceId/deletions` | With an exact expected revision and UUID idempotency key, freeze the source and enqueue verified deletion. |
| `sourceDeletion(jobId)` | `GET /api/v1/source-deletions/:jobId` | Poll closed affected/remaining counts and safe lifecycle timestamps, or read the minimal verified tombstone. |
| `cancelSourceDeletion(jobId)` | `POST /api/v1/source-deletions/:jobId/cancel` | Request cancellation only before destructive work starts; poll for the terminal result. |
| `retrySourceDeletion(jobId)` | `POST /api/v1/source-deletions/:jobId/retry` | Requeue only the remaining inventory of a `partially_deleted` job. |
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
For delegated callers, continuation and every run-scoped read or action require
the thread's durable authority binding to match the verified delegate,
workspace, profile, subject, purpose and channel context. Unbound or mismatched
threads fail before mutation. Delegated runs also receive none of the runtime's
legacy unscoped identity, database memory, AGENTS.md fallback or remember tool.
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
text/PDF shape before advancing the logical manifest. Concurrent refreshes are
fenced by the server-captured revision/current version; a stale completion
throws `OwnwareError` with `code: 'source_upload_refresh_conflict'` and validated
`actualRevision`/`actualCurrentVersionId`, while the winning version remains
current. The runtime removes the rejected private placement before confirming
that conflict; an unverified removal remains the explicit
`source_upload_cleanup_failed` state rather than hidden success. Accepting a
refresh resets current inspection and preparation truth so the new bytes cannot
inherit readiness from their predecessor. Missing inspection or freshness
evidence stays explicit rather than being projected as ready. Source job creation
accepts only `inspect_format` for one exact version and replays an exact
idempotency key across restart. Cancellation remains `cancel_requested` until
in-flight work yields; terminal jobs reject stale cancellation.

Preparation has separate authority from inspection: delegated callers need
`source_preparations.create` to enqueue `extract_text` or strict CSV
`prepare_data_view`, and `source_jobs.read` to poll the unified job. Text
extraction additionally needs `source_resources.read` to read its resulting
manifest. Granting
`source_jobs.create` implies none of these. The flow is prepare, poll the returned
job until `succeeded`, then read its non-null `resourceId`. That final endpoint is
a closed metadata manifest only. Reading bytes is a separate protected flow: the
install owner creates a short-lived grant for one subject/resource/purpose/channel,
and a subject-bound delegated client carrying `source_content.read` requests only the UTF-8 byte
range it needs. Discovery is separately fenced: the owner creates a
`source_content.search` grant and a subject-bound delegated client carrying that operation can
run a bounded literal `searchSourceContent` scan. Search returns byte-addressed
passages and stable evidence IDs; it does not invoke a model or durable index.
Its `observedAt` is the evidence-snapshot creation time. An equivalent repeated
search may retain that timestamp; callers must not treat it as proof of current
authorization, cache state, response time, or source freshness.
Both retrieval methods derive the subject from the verified principal; their
request bodies cannot select or override a subject.
An owner token cannot use either content route, and route authority
without a matching live grant is denied. Revocation takes effect on the next read.
A refresh marks manifests from the prior current
version `stale` with `staleAt` but keeps their immutable lineage readable. Work
already in flight may finish as stale, and neither case labels the replacement
version prepared; inspect and prepare that new current version separately.
Data View preparation accepts only a current inspected `structured_export`
whose verified media is UTF-8 text. Its public job exposes `dataViewId` only
after success; the private artifact locator and all rows/cells remain runtime-
private. Reading the content-free manifest additionally requires
`source_data_views.read`; cross-scope and deleting-source identities look absent.
The manifest exposes stable field IDs and untrusted header labels but no cells,
and it grants no query authority. Querying is a separate least-privilege flow:
the owner admits an explicit subject, field list and exact row window, then a
subject-bound delegated principal carrying `source_data_views.query` can request
only a field list and row window inside that live grant. Identity, purpose,
channel, operation, observe-only autonomy and permission mode come from verified
server context, never the query body. Results include exact current lineage,
stable field/row identities, completeness and observation time. Formula-like or
instruction-like cell strings remain inert data. Protected denial, revocation,
expiry, stale/deleting state, lineage drift, tamper and races return no cells via
`source_data_view_unavailable`; malformed requests use
`source_data_view_query_invalid`, and declared ceiling excess uses
`source_data_view_query_limit_exceeded`. The query is a retry-safe read POST and
offers no SQL, filter, sort, aggregation, expression or arbitrary predicate.

A connection or source registration is not permission. The connection inventory
is install-owner-global in this contract revision because runtime connection
records are not workspace/profile resources. It exposes an Ownware-owned opaque
identity, provider-neutral capability, reduced-precision state timestamps and
fixed recovery guidance only. Explicit revocations disappear; an unconfirmed
provider revocation remains a fixed `failed` / `verify_revocation` state instead
of optimistic success. Connection state never grants profile, tool, subject,
purpose, channel, resource or action authority; use still requires a separate
scoped grant and the live evaluator.

Registration does not
grant inspection, preparation, retrieval, deletion, Data View, search, or any
connected-system operation. Source deletion has four separate delegated
authorities for create, read, cancel, and retry; granting any one implies none of
the others and no source-use authority. Creation fences the caller's exact
`expectedRevision` and requires a UUID idempotency key whose exact retry replays
the original job. Cross-workspace/profile deletion identities remain
indistinguishable from absence.

Deletion progress exposes only its source/job identities, state, timestamps,
and closed affected/remaining counts. `cancel_requested` is not cancellation;
destruction can be cancelled only before it begins. `partially_deleted` remains
frozen and can retry only that job's remaining inventory. `deleted` means every
declared store was verified absent and the runtime retained only a minimal opaque
tombstone. No artifact identity, path, object key, worker claim, or raw failure is
published, and deletion grants no retrieval, Data View, or search authority.

Source growth is bounded by the effective workspace and profile ceilings in
`limits.sourceQuota`. The runtime reserves capacity atomically when it accepts
growth: an upload session reserves its declared `expectedBytes` before any chunk
is written, and a preparation reserves both a nonterminal job and its derived-
resource slot. Retained bytes and outstanding reservations count together;
reservations convert to retained resources or are released only by the runtime's
safe terminal accounting, so concurrent requests cannot oversubscribe a ceiling.
Quota checks gate only growth. Reads and non-growing recovery, including writing
or completing an accepted upload and reading or cancelling accepted work, remain
available when an installation is already over its effective limit.

The four affected creation calls return HTTP 409 with
`code: 'source_quota_exceeded'` and a typed `resourceClass` when either scope
would exceed a ceiling. The response does not reveal usage, which scope failed,
resource identities, or paths. It has no `Retry-After` header or body hint because
time alone does not guarantee capacity; clients should not retry until capacity
or the effective negotiated limit changes.

For a write-safe retry, generate one UUID per logical turn and pass it as
`idempotencyKey`. Matching retries within seven days replay the accepted
thread reference; conflicting input or an indeterminate prior-boot outcome
throws a typed `OwnwareError` instead of starting another run.

An available capability result also includes the limits enforced by that
Gateway instance: the 10 MiB parsed-JSON ceiling, candidate file/decoded-byte/name
limits, run-attachment limits, the source page ceiling, source inspection byte/
time/attempt limits, source preparation byte/time/attempt and one-resource limits,
effective workspace/profile source quota ceilings, delegation lifetimes,
seven-day idempotency replay window, and its enabled/disabled rate-limit
values. A successful `run()` result carries `timeoutMs`, the wall-clock limit
selected from the resolved profile. Older v1 Gateways may omit `limits` and
`timeoutMs`; the SDK keeps both optional for additive compatibility.

The owner-side grant methods are `createAccessGrant`, `createDataViewQueryGrant`, `accessGrant`,
`accessGrants`, and `revokeAccessGrant`; protected delegated retrieval is
`readSourceContent` and `searchSourceContent`. Grant mutations use caller-generated UUID idempotency keys
and return only immutable mutation receipts. Negotiate the four
`access_grants.*`, `source_content.read`, `source_content.search`, and
`source_data_views.query` before depending on
this flow. `limits.accessGrants` advertises TTL, active-count, and pagination
bounds; `limits.sourceContent.maxRangeBytes` advertises the maximum range.
`limits.sourceSearch` advertises the scan, query, match, context, timeout, and
match-mode bounds.
`limits.sourceDataView` separately advertises query ceilings of 32 fields, 256
rows, 8,192 cells, 256 KiB and two seconds, plus the 256-identity grant-scope
ceiling. A row grant window never clips beyond the current manifest; it rejects
instead, so the owner knows exactly which rows were admitted.

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
  `retryAfterSeconds`. A stale source refresh also carries validated safe actual
  identity fields; a source quota conflict carries only its validated
  `resourceClass` and no retry delay. Unknown legacy bodies are not copied into
  the message.

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
