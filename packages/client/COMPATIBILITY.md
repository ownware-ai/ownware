# Gateway v1 compatibility

The URL major is `/api/v1`. Revisions within v1 are additive: clients ignore
unknown optional fields, and a newer SDK treats a missing optional field as an
older capability rather than inventing a value.

| Contract revision | Added public behavior |
|---|---|
| `0.1.0` | Authenticated capability negotiation for the bounded HTTP/SSE surface. |
| `0.2.0` | Owner-issued, scoped and revocable delegated principals. |
| `0.3.0` | Durable `runs.start` idempotency and typed replay/conflict/indeterminate states. |
| `0.4.0` | Instance-enforced limits in negotiation and the selected run `timeoutMs`. |
| `0.5.0` | Immutable `runId` plus independently addressable durable run snapshots. |
| `0.6.0` | Run-bounded SSE, retained-cursor floor and typed invalid/mismatched/expired cursors. |
| `0.7.0` | Exact run/request/operation-hash permission decisions; no delegated bulk resume. |
| `0.8.0` | Durable exact run cancellation with truthful requested/confirmed/indeterminate states; no delegated thread abort. |
| `0.9.0` | Side-effect-free validation of bounded portable candidate bytes, with opaque identity, safe findings and negotiated upload limits. |
| `0.10.0` | Idempotent private staging of exact candidate bytes with verified ready/placement-failed/cleanup-failed states and no activation side effect. |
| `0.11.0` | Compare-and-set candidate activation plus immutable candidate identity on run start and snapshots; cached threads rebuild on candidate change. |
| `0.12.0` | Explicit rollback to a named ready candidate with CAS conflict and truthful rollback-failed/actual-active states. |
| `0.13.0` | Monotonic deployment revision, observed health, idempotent pause/resume and a shared paused-profile run-acceptance fence. |
| `0.14.0` | Scoped candidate/deployment reads, minimal public profile catalog, candidate-only execution and verified retention-guarded deletion. |
| `0.15.0` | Bounded ephemeral run attachments with strict base64/type verification, untrusted-data framing, safe failures and advertised limits. |
| `0.16.0` | Delegated source registration plus bounded scoped list/detail manifests with strict safe metadata, durable idempotency, lifecycle health and no path/content/storage exposure. |
| `0.17.0` | Exact-offset streamed source upload, restart-safe chunk replay, whole-object checksum/format verification, immutable source versions and scoped version manifests. |
| `0.18.0` | Scoped source-job create/read/cancel for bounded format inspection, with durable creation replay and truthful requested-versus-terminal cancellation. |
| `0.19.0` | Source refresh completion captures a private base identity, compare-and-sets it once, invalidates current inspection/preparation state and reports typed safe actual conflict truth. |
| `0.20.0` | Separately authorized text preparation, v2 source-job reads with implementation/resource identity, and scoped content-free derived-resource manifests with explicit stale truth. |
| `0.21.0` | Effective workspace/profile source quotas, reservation-safe growth accounting and typed detail-minimised quota conflicts while preserving reads and recovery. |
| `0.22.0` | Separately authorized exact-revision source deletion jobs with durable replay, pre-destruction cancellation, partial retry, closed progress counts and verified minimal tombstones. |
| `0.23.0` | Owner-managed, revision-fenced source-content grants plus delegated bounded UTF-8 reads with live grant and source-state re-evaluation. |
| `0.24.0` | Separate protected-source search grants plus bounded exact/ASCII-folded keyword scans that return stable byte-addressed evidence without a model or durable index. |

Compatibility rules:

- A Gateway without capability discovery is `unavailable`, not assumed
  compatible.
- A different URL major is `incompatible` before a dependent mutation.
- Existing v1 owner clients may omit `Idempotency-Key`; delegated run starts
  require a UUID key and reject before mutation when it is absent.
- `limits` and `timeoutMs` are optional in the SDK so current clients can still
  talk to older v1 owner deployments.
- `runId` is optional on `RunResult` for older v1 Gateways; callers requiring
  snapshots negotiate `runs.snapshot` before starting the run.
- A capability's integer version is the minimum-behavior check. In `0.24.0`,
  `gateway.capabilities` is version 5, `runs.start` is version 4,
  `runs.snapshot`, `runs.events`, `runs.resume` and `runs.abort` are version 2,
  and `candidates.validate`, `candidates.stage`, `candidates.activate` and
  `candidates.rollback` are version 1.
  `profiles.pause` and `profiles.resume` are also version 1 and require a UUID
  `Idempotency-Key` plus the exact expected deployment revision.
  `profiles.list`, `profiles.deployment.read`, `candidates.read`,
  `candidates.list` and `candidates.delete` are version 1.
  `runs.attachments` is version 1 and requires a separately declared delegated
  operation plus the negotiated count/decoded-byte/filename limits.
  `sources.register` is version 2; `sources.list` and `sources.read` remain
  version 1. They require a delegated workspace/profile-scoped principal and
  never accept workspace, profile, path, URL, bytes or storage authority from
  the request body.
  `source_uploads.create` is version 2; `source_uploads.write` and
  `source_versions.read` remain version 1, and `source_uploads.complete` remains
  version 2. Uploads use exact
  offsets and checksums under negotiated byte/chunk/count/expiry/media limits;
  public responses expose opaque identities and safe manifests, never placement keys.
  Completion compare-and-sets the server-captured source revision/current
  version and returns safe actual identity on a typed stale-refresh conflict.
  Rejected placement is removed before conflict confirmation; cleanup failure
  remains a typed terminal non-success.
  `source_jobs.create` is version 2; `source_jobs.cancel` remains version 1,
  while `source_jobs.read` remains version 2 and includes `implementationVersion` plus a
  nullable `resourceId`. Inspection creation supports only `inspect_format` for
  one exact immutable version and requires a UUID idempotency key.
  `source_preparations.create` is version 2; `source_resources.read` remains
  version 1. They require separate delegated operations. Preparation accepts only `extract_text`
  for an inspected current text version, under the negotiated 16 MiB, 5-second,
  three-attempt and one-resource limits. Its resource read returns only a closed
  lineage/policy/coverage/freshness manifest and never embeds content. Public job
  and resource state excludes worker claims, leases, retry schedules, paths,
  object keys, source or derived bytes, parser output and raw errors.
- `access_grants.create` is version 2; `access_grants.list`, `access_grants.read`,
  `access_grants.revoke`, `source_content.read` and `source_content.search` are version 1. Grant
  administration requires authenticated mode and the install-owner bearer even
  when a delegated token advertises an administration operation. Creation is
  bound to one current prepared text resource; revocation compare-and-sets its
  exact revision. Both mutations require UUID idempotency keys and replay only a
  four-field immutable receipt. List/detail are owner-only inspection surfaces.
- `source_content.read` requires a delegated principal carrying that exact
  operation plus a currently effective matching grant for workspace, profile,
  subject, purpose, channel, resource, consent and observe-only autonomy. It
  returns at most the negotiated 64 KiB UTF-8 range and safe immutable lineage.
  Source availability, current version, preparation, freshness, conflict and
  deletion truth are rechecked around the private read. Revocation or source
  invalidation denies the next read; denial and cross-scope mismatch look absent.
- `source_content.search` requires its own delegated route authority and matching
  live grant; a read grant never implies search and a search grant never implies
  read. It scans one exact current strict-UTF-8 resource under the negotiated
  16 MiB, 128-query-byte, 20-match, 1024-context-byte and five-second limits.
  Results are byte ordered and carry exact match/context offsets plus stable
  evidence IDs. `no_matches` is explicit; truncation is explicit; timeout returns
  no partial result. The first implementation uses no model, network, shell, SQL,
  or durable search index.
- `limits.sourceQuota` publishes required `workspace` and `profile` effective
  ceilings for registrations, retained plus reserved bytes, active upload
  sessions, nonterminal jobs and derived resources. These negotiated positive
  values are instance limits, not schema constants. Accepted uploads reserve
  `expectedBytes` before chunks arrive; preparation reserves its job and derived-
  resource capacity. Retained resources and outstanding reservations are counted
  together and transitions do not double-count them.
- `sources.register`, `source_uploads.create`, `source_jobs.create` and
  `source_preparations.create` return typed HTTP 409 `source_quota_exceeded` when
  growth would exceed either effective scope. Only the blocked `resourceClass`
  is disclosed beyond standard safe error metadata: no usage, failed scope,
  resource IDs or paths. There is no `Retry-After` header or body hint. Reads and
  non-growing recovery remain allowed while an installation is over limit.
- A connection or source registration is not permission. Registration grants no
  inspection, preparation, retrieval, deletion, Data View, search, or connected-
  system operation. `source_deletions.create`, `source_deletions.read`,
  `source_deletions.cancel` and `source_deletions.retry` are separate version 1
  authorities; none implies another or any source-use authority. Creation
  requires a UUID idempotency key and exact positive source revision. Reads are
  scoped so cross-workspace/profile identities look absent. Cancellation is
  available only before destruction, and retry accepts only the same
  `partially_deleted` job's remaining inventory.
- Public deletion state contains only opaque source/job identities, lifecycle
  state and timestamps, source revision, and closed affected/remaining counts.
  `deleted` is reported only after every declared store is verified absent and
  metadata is reduced to a minimal tombstone. Artifact IDs, paths, object keys,
  worker claims and raw failures are never published.
- `limits.accessGrants` publishes the 60-second minimum, 30-day maximum,
  1,024-active-per-workspace/profile ceiling and 100-item page ceiling.
  `limits.sourceContent.maxRangeBytes` publishes the 64 KiB read bound.
- The current contract does not promise a cursor-retention duration. A client
  may resume within retained history; typed cursor expiry and the snapshot's
  `earliestRetainedCursor` provide recovery without inventing a duration.

Removing an operation or required field, changing its meaning, or weakening a
security fence requires a new URL major.
