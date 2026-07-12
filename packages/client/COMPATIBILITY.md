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
- A capability's integer version is the minimum-behavior check. In `0.17.0`,
  `gateway.capabilities` is version 2, `runs.start` is version 4,
  `runs.snapshot`, `runs.events`, `runs.resume` and `runs.abort` are version 2,
  and `candidates.validate`, `candidates.stage`, `candidates.activate` and
  `candidates.rollback` are version 1.
  `profiles.pause` and `profiles.resume` are also version 1 and require a UUID
  `Idempotency-Key` plus the exact expected deployment revision.
  `profiles.list`, `profiles.deployment.read`, `candidates.read`,
  `candidates.list` and `candidates.delete` are version 1.
  `runs.attachments` is version 1 and requires a separately declared delegated
  operation plus the negotiated count/decoded-byte/filename limits.
  `sources.register`, `sources.list` and `sources.read` are version 1, require
  a delegated workspace/profile-scoped principal, and never accept workspace,
  profile, path, URL, bytes or storage authority from the request body.
  `source_uploads.create`, `source_uploads.write`, `source_uploads.complete`
  and `source_versions.read` are version 1. Uploads use exact offsets and
  checksums under negotiated byte/chunk/count/expiry/media limits; public
  responses expose opaque identities and safe manifests, never placement keys.
- The current contract does not promise a cursor-retention duration. A client
  may resume within retained history; typed cursor expiry and the snapshot's
  `earliestRetainedCursor` provide recovery without inventing a duration.

Removing an operation or required field, changing its meaning, or weakening a
security fence requires a new URL major.
