# ADR-0005: Immutable profile candidates and compare-and-set activation

- **Status:** Accepted
- **Date:** 2026-07-12
- **Decision owners:** Ownware maintainers

## Context

The existing profile marketplace installs and updates mutable directories in
the active profile tree. Validation, placement, activation and rollback are
therefore coupled to host paths and best-effort filesystem cleanup. A failed
multi-profile placement can leave partial state, a local fork can retain an
upstream identity, and an active run has no immutable version to pin.

A public client must be able to validate portable Agent Kit bytes, stage a
known candidate, activate it only if the expected version is still current,
and roll back to a named known-good candidate. It must not receive host paths,
raw profile contents or an optimistic success when placement or restoration is
partial.

## Decision

### Candidate identity

A candidate is an immutable validated profile tree. Its public identity is
`sha256:<lowercase hex>`, computed over sorted relative paths, entry kinds and
exact bytes. Origin metadata, temporary directories and mutable install
sidecars are excluded. Symlink identity hashes the link text, while validation
separately proves the resolved target remains inside the candidate.

The hash algorithm uses bytewise path ordering, explicit NUL separators and
entry-kind markers. The same tree produces the same identity independently of
creation order or host directory. Any byte, path, entry-kind or link-target
change produces another candidate.

Invalid, unreadable or escaping trees receive no candidate identity. This
prevents an identity from blessing bytes the validator could not completely
inspect.

### Validation boundary

Validation is read-only and never executes candidate code, places files,
registers a profile or mutates the active version. Every declared tool, skill
and helper reference must pass both lexical and realpath containment. Candidate
tree validation enforces file/byte limits, rejects special files and outside
symlinks, and applies the custom-code policy selected by the trusted caller.

Public findings contain stable codes, severity, safe relative subjects and
calm messages. They contain no absolute host path, raw profile content, secret,
credential, clone stderr or exception string. Internal diagnostics may retain
more detail only in runtime-private logs that follow the normal redaction law.

### Stage, activate and rollback

Validation and identity do not imply installation or activation. A later stage
operation copies the exact validated candidate into a candidate-owned private
location, verifies the identity again after placement and records one explicit
state: staged, placement-failed, cleanup-failed or ready. Partial placement is
never ready.

Activation is compare-and-set. The caller supplies the candidate to activate
and the active candidate it believes it is replacing. A mismatch returns a
conflict without mutation. Activation switches one profile identity
atomically; a run pins the active candidate identity before execution and keeps
using it even if a later activation succeeds.

Rollback is activation of a named previously staged candidate under the same
compare-and-set rule. Failure states distinguish activation-failed,
restore-failed and rollback-failed. None is reported as the prior or requested
candidate being active unless that state is re-read and verified.

Candidate metadata and activation state may use the existing Gateway SQLite
database and checked migrations. This introduces no new database, queue,
service or cross-tenant path. Candidate bytes remain in the runtime's private
data plane, never in a separate control plane.

### Deletion and active use

A candidate pinned by a live or uncertain run cannot be removed. Uninstall and
pruning must first prove no active, cancel-requested or indeterminate execution
depends on it. Pausing new runs does not prove existing effects stopped.

## Consequences

- Validation can ship before staging without creating a hidden activation
  side effect.
- Public clients address opaque candidate IDs, not filesystem directories.
- Existing mutable install/update routes remain owner-only compatibility
  surfaces until they are implemented through the candidate state machine.
- Staging, activation, run pinning and rollback each require failure-injection
  tests before their public capability version advances.
- A content hash proves byte identity, not safety, quality or authorization;
  validation findings and principal scope remain separate gates.

## Rejected alternatives

- **Use repository URL, branch, profile name or commit as identity.** These can
  move, collide or omit local bytes.
- **Hash only `agent.json`.** Skills, prompts, helpers and tools materially
  change behavior.
- **Return the candidate directory to clients.** Host paths are private
  implementation detail and ambient authority.
- **Install during validation.** A read-only check must not mutate active state.
- **Activate by overwriting the current directory.** Partial writes and stale
  callers cannot be distinguished from success.
- **Treat cleanup failure as success.** Leftover or mixed bytes are material
  state and require an explicit recovery path.
