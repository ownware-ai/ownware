# ADR-0007: Versioned positive access grants

- **Status:** Accepted
- **Date:** 2026-07-15
- **Decision owners:** Ownware maintainers

## Context

Ownware has several mechanisms called permissions or grants: delegated route
operations, exact run approvals, profile tool rules, folder roots, zone
expansions, connector readiness and subagent capability lists. They solve
different problems. None is a live resource-access fence over workspace,
profile, subject, purpose, channel, resource, operation, consent, autonomy and
field/row scope.

ADR-0006 requires source content reads, Data Views and search to check a live
versioned grant. A connection, source registration, policy-reference label or
delegated bearer is a necessary prerequisite at most; none grants access.
Permission mode `auto` also currently bypasses host permission callbacks, so it
cannot be allowed to bypass this evaluator's hard safety floor.

## Decision

### Boundary

The first grant release is an internal, provider-neutral Cortex foundation. It
uses the existing checked Gateway SQLite database and adds no public route, SDK
method, capability or wire-contract revision. Retrieval and connector handlers
may consume it only in later slices with their own public contract and
black-box proof.

Existing permission, HITL, connection and subagent mechanisms keep their
current meanings. They are not migrated or silently interpreted as access
grants.

### Positive immutable revisions

A grant is a positive operating fence. It has one opaque UUID identity and an
append-only sequence of immutable revisions. Revision one activates the grant.
Revocation appends a `revoked` revision that copies the exact fence and advances
the mutable head with compare-and-set. Historical revisions never authorize.
There are no explicit deny grants, wildcard strings, mutable in-place scope or
fallback owner grants in v1.

Every active revision binds:

1. workspace and profile;
2. explicit opaque subject identity, never inferred from delegate identity;
3. exact purpose and nullable exact channel;
4. exact resource kind and identity;
5. exact operation;
6. explicit `all` or bounded-list field and row scope;
7. consent state, with an exact opaque evidence identity when consent is
   recorded;
8. an autonomy ceiling: `observe < recommend < draft < act`;
9. effective and expiry timestamps; and
10. an opaque bounded issuer identity.

`ask` is not an authorization decision. A separate approval workflow may
create a grant or approve one exact action, but absence, mismatch, expiry and
revocation deny.

### Fixed evaluation order

The evaluator runs in this order for every autonomy or permission mode:

1. validate the complete trusted evaluation context;
2. enforce the supplied hard-floor result before reading grant state;
3. load only the current active, effective and unexpired revision;
4. match workspace, profile, subject, purpose, channel, resource and operation;
5. match consent evidence;
6. enforce the autonomy ceiling;
7. prove every requested field and row is inside the explicit scope; and
8. return one deterministic allow identity or a safe denial.

Multiple positive grants combine by union: any complete match may allow. The
selected match is deterministic, preferring bounded scopes, then the lower
autonomy ceiling, earlier expiry and opaque grant identity. Hard-floor denial
always wins.

All non-hard-floor mismatch states collapse to `no_matching_grant`; callers
must preserve wrong-identity absence and must not disclose which scope exists.
Safe results contain only decision, stable code, evaluator version, and on
allow the matched grant ID/revision and expiry. They contain no policy rule
identifier, values, raw tool
input, credentials, paths, policy diagnostics or failed-dimension detail.

### Live invalidation

Every protected operation evaluates against the current revision at use time.
Expiry needs no mutation. Revocation becomes effective when the head CAS
commits. Future caches must bind the allowed grant ID/revision and re-evaluate
before use; a stale revision can never authorize a cache hit.

Source deletion freezes the source and appends revocations for every current
grant over that source's prepared resources in the same immediate transaction.
The deletion inventory verifies the current heads remain revoked before success;
it never deletes immutable grant revisions, and cancelling deletion does not
reactivate them. Source-linked grant mutation replay is made indeterminate at
freeze and removed only if verified deletion proceeds.

Owner credentials may administer grants through a separately accepted
management contract, but owner identity does not bypass resource evaluation.

## Consequences

- Retrieval remains unavailable until a later handler evaluates this fence
  before fetching bytes, rows or passages.
- Strict exact scopes may require a new grant when resource identity or consent
  evidence changes; this is safer than implicit inheritance in the first
  release.
- Existing `auto` behavior remains unchanged outside this new evaluator. Any
  general permission-mode compatibility change requires a separate decision.
- Subject identity, consent evidence and issuer identity remain opaque runtime
  identifiers; integrating an external identity or consent system requires its
  own contract and, where applicable, ADR.

## Rejected alternatives

- **Treat delegated operations as grants.** They do not bind subject, resource,
  consent, autonomy or field/row scope.
- **Treat a ready connection as permission.** Authentication availability does
  not authorize an agent action.
- **Extend profile tool-rule JSON.** It is path-based, mutable, profile-only and
  cannot provide transactional live revocation.
- **Let `auto` or owner identity bypass the evaluator.** Autonomy is bounded by
  a fence; it is not authority.
- **Add explicit deny and ask grants now.** They add conflict and escalation
  semantics before positive least-privilege grants are proven.
