# ADR-0006: Runtime-owned sources, immutable versions and durable jobs

- **Status:** Accepted
- **Date:** 2026-07-12
- **Decision owners:** Ownware maintainers

## Context

Ownware currently has owner-facing workspace paths, filesystem tools and
ephemeral run attachments. None is a safe public contract for reusable business
material. They expose or depend on host paths, lack immutable source lineage,
and cannot truthfully represent inspection, preparation, invalidation or
verified deletion.

Public clients need to register raw or referenced material directly with the
tenant runtime, observe bounded mechanical preparation, and retrieve evidence
through stable resource identities. Raw bytes must remain in the runtime data
plane. Registration must not place a whole source in a model prompt, grant an
agent access, or turn source content into instructions.

## Decision

### First release boundary

The first source release is deliberately narrow:

1. workspace-scoped source registration and immutable versions;
2. short-lived source-bound chunk upload sessions with exact offsets, decoded
   byte quotas, final checksum verification and idempotent completion;
3. safe manifests and one common durable job state machine for mechanical
   inspection and verified deletion;
4. small source-linked text extraction reads and restricted file-backed Data
   Views;
5. permission-filtered keyword search only after version invalidation and
   evidence semantics pass.

Semantic/vector search, arbitrary URL pull, arbitrary filesystem paths, SQL,
shell parsing, embedded execution and ambient network access are absent until
separately justified and advertised.

### Runtime ownership and storage

Source metadata, immutable version metadata, upload state, jobs, derived
resource manifests and deletion tombstones use the existing Gateway SQLite
database with checked migrations and workspace-scoped keys. This introduces no
new database or cross-tenant data path.

Original and derived bytes live under a runtime-private storage adapter rooted
inside the configured data directory for local/test deployments. The adapter
uses opaque source/version/resource identities; public responses never contain
its host path. Managed or BYOC deployments may provide another private object
adapter through typed configuration, but must preserve the same identity,
streaming, verification, retention and deletion contract. Adding a cloud
object service requires its own ADR.

Accepted originals are immutable. A refresh writes and verifies another
version, then compare-and-sets the logical source's current version. Same-byte
versions are typed duplicate candidates, not silently merged, because purpose,
authority, retention and grants can differ.

### Upload transaction

Registration creates metadata only. A later upload session binds workspace,
source, actor, expected byte count/checksum/media policy, maximum chunks,
expiry and a one-use opaque upload identity. Chunks stream to quarantined
runtime staging and are accepted only at the exact durable offset. Matching
retries replay safely; conflicting bytes or offsets reject before advancing.

Completion recomputes the cryptographic checksum, mechanically identifies the
format, atomically places accepted bytes, creates the immutable source version
and only then advances registration state. Filename and declared MIME are
untrusted labels. Partial placement or cleanup is a durable failure state, not
registered success.

### Durable jobs

Inspection, preparation, rebuild and deletion share a SQLite-backed job state
machine:

`queued → running | waiting_for_resource → cancel_requested → succeeded |
partial | failed | cancelled`.

The initial worker is an in-process bounded worker using durable claims and
phase checkpoints; no external queue is added. Startup recovers expired
claims from their last verified checkpoint or marks them explicitly failed or
partial. Cancellation is a request until the worker confirms a terminal state.
Timeout and process loss never imply success.

Workers receive only the exact source version and declared parser operation,
with byte/item/time/output budgets and isolated staging. They receive no model,
shell, secret, macro execution or ambient network capability. Adding a parser
service, external queue or cross-process worker requires another ADR.

### Derived resources, freshness and caches

Every extraction, note, Data View or keyword index is immutable and records
exact source-version lineage, implementation version, included/excluded scope,
purpose, authority, freshness and job identity. Advancing a source version
marks every older dependent representation stale before it can be retrieved as
current. A failed rebuild preserves the old representation as stale; it never
relabels it fresh.

Retrieval caches bind verified principal/grant scope, operation, canonical
parameters and exact source/resource versions. Version change, revocation,
expiry or freshness-policy change invalidates use. Raw filesystem grep is not a
source cache and must not return a cached result after underlying bytes change.

### Data Views and search

The first structured format is strict UTF-8 CSV. Its schema preparation rejects
empty or duplicate normalized headers, malformed quoting, ragged rows, invalid
UTF-8 and inputs outside the advertised byte/row/field/cell/time limits. Values
remain strings in the first release; there is no inferred type coercion, formula
execution or macro handling. Immutable field IDs and row IDs are derived from
their zero-based ordinal within one exact source version, while original labels
remain untrusted display metadata. A later source version always produces new
identities even when labels or values match.

Data Views accept a typed allowlisted query AST over stable field IDs. They do
not accept SQL, table names, database paths, arbitrary expressions or writes.
Field and row authority is enforced before fetching values. Results are
bounded by row/cell/byte/time limits and carry exact view/source versions,
freshness and evidence identity.

Keyword search filters the permitted source/index set before ranking and
returns bounded passages with exact source/version/location/authority and
freshness evidence. Empty, partial, stale, denied, timed-out and failed remain
distinct. Relevance is not truth confidence.

Content reads, Data View queries and search require both a separately advertised
operation and a live versioned grant evaluated against the verified workspace,
profile, subject, purpose, channel, source/resource identity, field/row scope and
operation. Source registration, policy-reference metadata and delegated bearer
scope are necessary fences but are not a substitute for that grant. Therefore
these retrieval surfaces remain absent until the common grant evaluator exists.

The first keyword-search implementation performs bounded scans of current
immutable text resources after grant filtering and may use only a bounded
in-memory cache keyed by the verified grant identity, operation, canonical
parameters and exact source/resource versions. It adds no durable text index or
SQLite content table. Every cache hit rechecks live grant and freshness state;
refresh, revoke, expiry, policy change and deletion make the entry unusable.

### Quotas

Growth is reserved and enforced transactionally before mutation. Effective
workspace and profile limits cover source registrations, retained original
bytes plus active upload reservations, open upload sessions, non-terminal jobs,
derived resources and bounded retrieval-cache entries/bytes. Concurrent writers
cannot each spend the same remaining capacity. Failed, cancelled or expired work
releases only reservations whose absence is verified; existing over-limit data
remains readable and deletable while new growth is denied. Public capability
negotiation reports the effective values and typed quota failures identify the
resource class without exposing another scope's usage.

### Deletion

Deletion is planned, fenced and asynchronous. It first blocks refresh,
preparation and retrieval; revokes future use; drains or cancels dependent
jobs; removes originals, derived bytes, indexes, scoped caches and temporary
state; verifies absence; and retains only a minimal tombstone. It returns
`deleted` only after declared stores are verified absent. Otherwise it remains
`partially_deleted` with safe affected counts and a retry path.

The deletion inventory includes every immutable original, upload staging object,
derived resource, future Data View/index artifact, idempotency replay that could
return source metadata, applicable access-grant revocation proof, linked grant
mutation replay, and in-memory retrieval cache entry. A source revision compare-
and-set freezes the source before inventory processing. The same transaction
revokes current grants over the source's prepared resources and makes linked
grant mutation replay indeterminate; cancellation never reactivates either.
Every upload, refresh, preparation and retrieval mutation checks the active
fence. Deletion uses the common durable job machine, verifies current grant heads
are revoked without deleting immutable grant history, and retains only an opaque
minimal tombstone after verified absence. Adding a new source artifact or replay
is incomplete until it is registered in this inventory and covered by the
deletion fixture.

## Consequences

- Source data remains runtime-owned and never needs a control-plane proxy.
- SQLite plus a local private byte adapter is sufficient for the first
  portable release; no queue, vector database or cloud store is introduced.
- One-turn attachments remain a separate bounded ephemeral input and never
  become registered sources implicitly.
- Filesystem/media parsers may be reused only behind opaque resource IDs,
  containment, quotas, untrusted-data marking and evidence.
- Public OpenAPI, SDK, capability limits and black-box fixtures must advance
  together for each independently shipped operation.

## Rejected alternatives

- **Publish workspace paths or filesystem tools as source APIs.** Paths are
  ambient host authority and lack lineage, grants, freshness and deletion.
- **Send uploads through another control plane.** This creates a new raw-data
  controller and violates tenant-runtime ownership.
- **Store originals as SQLite blobs.** Large streaming, quarantine, retention
  and verified deletion belong in the byte adapter; SQLite stores control
  metadata and checksums.
- **Start with vector search.** It adds dependency, cost and permission/cache
  complexity before bounded keyword retrieval is proven insufficient.
- **Use arbitrary SQL for Data Views.** It leaks storage shape and cannot
  reliably enforce field/row scope before access.
- **Treat registration, preparation or connection as permission.** Each is a
  different state and retrieval still requires a live scoped grant.
- **Report cleanup or external delete request as deletion success.** Actual
  absence must be verified within the runtime's declared ownership boundary.
