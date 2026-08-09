# Ownware Vision

> **Ownware is the open agent runtime for products you own.**

Define an agent as ordinary files. Run its execution loop and operational
backend as one self-hosted service. Build every interface against one typed
HTTP+SSE contract.

Project overview and setup: [`README.md`](README.md)

Contribution guide: [`CONTRIBUTING.md`](CONTRIBUTING.md)

Security policy: [`SECURITY.md`](SECURITY.md)

---

## Why Ownware exists

Calling a model is the smallest part of operating an agent product. The real
boundary also has to execute tools, preserve thread state, survive reconnects,
pause for permission, protect credentials, recover from failures, and give
every client the same account of what happened.

Teams should not have to rebuild that boundary for every agent application.
They should be able to adopt a complete runtime, inspect it, run it on their own
infrastructure, and keep their product-specific experience outside it.

Ownware exists to make that runtime a reusable open-source dependency.

## The product boundary

Ownware accepts a **portable profile**—`agent.json`, `SOUL.md`, skills, tools,
and related text—and turns it into a running agent service.

The runtime owns:

- the model/tool loop, typed streaming, retries, compaction, and sub-agents;
- durable threads, checkpoints, resumable events, and permission continuation;
- provider and tool configuration, credential isolation, and security policy;
- explicit storage adapters, schedules, auth, and safe network exposure; and
- the public HTTP+SSE contract, SDKs, and compatibility metadata clients rely on.

The adopter owns the product around it: the user experience, business rules,
deployment topology, and which supported providers and tools receive data.
Messaging, CLI, web, mobile, and future clients are consumers of the runtime,
not privileged paths inside it.

## The promises

These are load-bearing:

1. **Self-hosting is the default product.** Runtime state and credentials live
   on infrastructure chosen by the operator. Ownware is not a mandatory cloud
   hop and does not hold customer keys.
2. **The agent is portable.** Its essential definition is made of inspectable,
   versionable files rather than a hidden hosted object.
3. **One public contract.** First-party and third-party clients use the same
   documented run, event, permission, and capability surfaces.
4. **Provider routes are explicit.** Model access and execution-runtime choices
   never collapse into a misleading “available” flag or silent fallback.
   Supported and experimental routes are labelled as such.
5. **Security primitives remain core and free.** Credential isolation, bind
   safety, zones, combination rules, permissions, and audit are not paid gates.
6. **Unknowns fail honestly.** A new provider, tool, status, or schema variant
   does not become success through a default branch.

## What makes a change belong here

A capability belongs in Ownware when an agent needs it while running and it can
be expressed through a stable, product-neutral contract. The test is semantic,
not cosmetic: multiple products sharing a route name is not proof that the
runtime owns the concept.

Good additions improve one of these general seams:

- execution and streaming;
- tools, providers, context, or compaction;
- durable runtime state and recovery;
- credentials, permissions, security, or audit;
- runtime-owned sources and evidence;
- the gateway/client contract; or
- optional adapters that remain ordinary clients of that contract.

Product-specific workspaces, dashboards, onboarding, billing, business
taxonomies, and control-plane state do not belong in the runtime. They should be
built on the public contract instead of pulling the dependency boundary upward.

## How Ownware should be described

Lead with what the repository can prove:

> **A self-hosted agent harness and operational backend in one runtime: profile
> in, durable agent service out.**

Provider names, channel logos, tool counts, and framework comparisons are
supporting details. They change over time and must not carry the category.
Ownware does not need to claim that alternatives are incomplete or locked in;
it needs to make its own boundary clear, small enough to understand, and strong
enough to build on.

## Contribution rules

- One PR = one topic. Split unrelated or very large changes.
- Add capability at the lightest layer that can express it. A profile, tool,
  provider, client, or adapter is often better than engine core.
- Change public contracts additively unless every consumer and migration path
  is deliberately reviewed.
- State the semantic claim before implementing a detector, evaluator, safety
  rule, or generalized capability. Test an adversarial counterexample.
- Keep secrets and real user data out of tests, logs, events, fixtures, and
  documentation.

## What we will not merge

- A mandatory hosted path that requires Ownware to hold end-user provider keys
  or become the data controller.
- A security primitive moved behind a paywall or a convenience wrapper that
  hides a material security decision.
- Product-specific control-plane or UI concepts embedded in the runtime.
- A provider, tool, or adapter catalogue presented as universal support.
- Heuristics presented as proof of permission, safety, completion, or effect.
- Heavy orchestration added by default without evidence that the shared runtime
  contract requires it.

## Security

Ownware treats its runtime boundary as real. The engine uses opaque credential
handles, exposed deployments refuse unsafe binds, and permission decisions are
part of the public continuation contract. Reports that cross those boundaries
are first-class vulnerabilities. The full trust model and reporting process
live in [`SECURITY.md`](SECURITY.md).
