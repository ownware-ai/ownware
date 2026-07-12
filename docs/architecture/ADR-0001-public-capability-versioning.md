# ADR-0001: Public Gateway capability versioning

- **Status:** Accepted
- **Date:** 2026-07-12
- **Decision owners:** Ownware maintainers

## Context

The Gateway has a deliberately small public HTTP/SSE contract and a larger
implementation surface. Route existence is not a compatibility promise. A
portable client needs to determine which public operations a Gateway supports
without probing private routes or treating a `404` as feature negotiation.

Existing v1 clients must keep working while the contract grows. Clients also
need a stable way to reject an incompatible major before attempting a write.

## Decision

The canonical public wire contract lives in
`packages/client/spec/openapi.yaml` and `packages/client/spec/asyncapi.yaml`.
The `@ownware/client` SDK is a typed consumer of those specifications.

The URL namespace carries the contract major (`/api/v1`). The specification
`info.version` is the semantic contract revision within that major.

Within one major, changes are additive:

- new optional response fields, event fields and capability declarations are
  allowed;
- new operations are public only when the specifications, SDK where
  applicable, documentation and black-box tests ship together;
- clients ignore unknown optional fields and capabilities;
- removing, renaming or changing the meaning of an existing required field,
  operation or terminal state requires a new URL major.

An authenticated `GET /api/v1/capabilities` operation returns only public-safe
contract metadata:

- contract name, major and semantic revision;
- stable capability identifiers and their integer versions; and
- no internal route inventory, host path, persistence detail, credential,
  prompt, source content or raw execution data.

Capability absence means `unavailable`. A different contract major means
`incompatible`. SDK negotiation reports these as typed states before the
caller starts a dependent mutation. Existing v1 clients may continue without
negotiating; later enforcement must therefore be additive and separately
versioned.

Capability declarations describe only operations already in the public
specifications. An implementation route is never promoted merely because it
exists or is useful to an owner interface.

Deprecation within a supported major requires published replacement guidance
and a sunset no earlier than the next minor SDK release. Removal still waits
for a new contract major.

## Consequences

- Public consumers have a deterministic discovery path and do not probe
  private endpoints.
- The specifications, SDK, capability registry and black-box fixtures must be
  checked for drift in CI.
- Capability discovery itself is part of the public contract and follows the
  normal authentication boundary.
- This decision does not define scoped principals, token issuance, durable
  idempotency, run retention or cursor retention. Those require their own
  decisions before implementation.

## Rejected alternatives

- **Publish every registered route.** This would turn implementation detail
  into an accidental compatibility and security boundary.
- **Infer support from `404`.** A missing route cannot distinguish an older
  Gateway, a disabled capability, a wrong path or an authorization denial.
- **Use package version alone.** Deployments may expose different capability
  sets even when their package versions are related.
- **Make negotiation mandatory immediately.** That would break existing v1
  clients without improving the already shipped calls.
