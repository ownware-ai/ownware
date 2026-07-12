# ADR-0002: Scoped runtime principals

- **Status:** Accepted
- **Date:** 2026-07-12
- **Decision owners:** Ownware maintainers

## Context

The Gateway currently has one opaque install-owner bearer token. It is suitable
for an operator or trusted in-process host, but it grants the whole Gateway
surface and must not be embedded in a browser, channel integration or portable
client.

A public client needs authority limited to a real workspace, agent, purpose,
channel and operation set. Resource identifiers in request JSON are desired
targets, not proof of authority. A connection or possession of an unverified
subject string is also not permission.

The existing install identity used by connector integrations is not an
authentication identity and will not be reused for this contract.

## Decision

### Two principal kinds

The existing install-owner token remains an additive compatibility and
administration path. When verified, it produces an in-process `owner`
principal. It is never returned by an HTTP response, copied into examples or
printed in full or in part.

A new short-lived `delegated` principal is represented by a signed token. It is
accepted only after signature, issuer, audience, algorithm, expiry, not-before
and revocation checks succeed.

### Issuance

Only an authenticated owner request or trusted in-process host may issue a
delegated token. The issuance request names the desired delegation; it does not
make those values authoritative by itself. The issuer:

1. resolves the requested workspace and profile from Gateway-owned state;
2. rejects a missing, inactive or conflicting resource;
3. validates bounded operation identifiers, purpose and optional channel;
4. creates an opaque token ID and short expiry; and
5. signs the canonical verified claims.

The caller supplies an opaque `delegateId` as an owner assertion about the
recipient. Ownware does not claim that this is a verified external human
identity. A deployment integrating an identity provider must derive that value
from its verified session before asking the trusted issuer to delegate.

The HTTP issuance operation is owner-only. The install-owner token must remain
server-side; handing it to a browser defeats the delegation boundary.

### Claims

Delegated claims contain only bounded metadata:

- issuer and audience (`ownware.gateway.v1`);
- token ID, issued-at, not-before and expiry;
- opaque delegate ID;
- canonical workspace ID and profile/agent ID;
- purpose and optional channel; and
- a sorted set of stable public operation identifiers.

Claims never contain prompts, source content, conversation text, tool inputs or
results, credentials, host paths or persistence details.

The first contract uses HS256 via the already-installed JOSE implementation.
The signing key is derived from the 256-bit install-owner token with domain
separation. The issuer identifier is a one-way, domain-separated digest. Owner
token rotation therefore invalidates every delegated token without adding a
second long-lived signing secret.

### Lifetime and revocation

Default lifetime is 15 minutes; maximum lifetime is 60 minutes. Tokens are not
refresh tokens. A trusted issuer creates a new delegation when continuity is
still appropriate.

An append-only migration adds a delegated-principal table to the existing
Gateway database. It stores token ID, safe verified claims, issued/expiry time
and optional revoked time/reason. It never stores the signed token. Revocation
is checked on every request; expired rows may be pruned after their audit
retention window. Owner-token rotation invalidates all signatures immediately.

### Request authorization

Authentication produces a principal object attached to the request in memory.
A central public-operation policy—not scattered handler convention—checks the
required operation and binds route/body resources to the principal before a
side effect. At minimum:

- workspace and profile/agent must exactly match the verified claims;
- operation must be present;
- purpose/channel must match when the operation carries that context; and
- read never implies write, draft never implies send, and timeout never implies
  approval.

Wrong scope returns a safe typed denial before thread creation, provider calls,
tool execution or any other mutation. Owner principals retain current behavior.

### Local and hosted behavior

Auth-disabled loopback mode remains the current local-owner compatibility path;
it cannot issue a meaningful delegated token and the HTTP issuer refuses until
authentication is enabled. Non-loopback binds continue to require TLS and
authentication.

Local, managed and bring-your-own-host deployments use the same claims and
policy. A future asymmetric or external verifier may implement the same
principal interface, but no deployment may trust identity or workspace headers
without cryptographic/session verification and resource binding.

## Consequences

- Browser and integration clients no longer require the install-wide owner
  credential.
- Individual delegation revocation survives restart without storing token
  values.
- Existing owner clients remain compatible while public operations adopt the
  central policy incrementally.
- The first implementation tracer covers issuance plus one scoped read and a
  wrong-workspace/profile denial before mutation. Broader route adoption is
  explicit capability work, not implied by accepting the token.
- The database migration, token codec, principal store and operation policy each
  require unit and real-Gateway restart/revocation tests.

## Rejected alternatives

- **Put workspace/profile in request JSON and trust it.** Requested resource is
  not authority.
- **Give browser clients the install-owner token.** One leak grants every route
  and defeats revocation by client or agent.
- **Reuse connector install identity.** It identifies a local connector subject,
  not an authenticated caller.
- **Long-lived self-contained tokens without a store.** They cannot be revoked
  individually and remain dangerous after a client is removed.
- **Store issued token values.** Revocation needs token IDs and claims, not bearer
  secrets.
- **Add a new auth service or persistence system.** The existing cryptographic
  dependency and Gateway database are sufficient for the first public seam.
