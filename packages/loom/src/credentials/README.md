# Loom — Credentials Contract

This directory defines **the contract** between a tool and the runtime when a
secret is involved. It is a pure type/protocol layer — there is no storage,
no encryption, no database, and no provider list here. Loom never sees a
secret value at rest.

## Where things live across the repo

There are three "credentials" directories. They are not duplicates; they are
layers of the same concern:

| Layer | Path | Role |
|---|---|---|
| **Contract** (this dir) | `packages/loom/src/credentials/` | Types + tool/runtime protocol — what a request/handle looks like, where a credential gets injected, how the redactor finds secrets in shell output. |
| **Implementation — records** | `packages/cortex/src/credential/` | Storage, audit, HITL gate, trust gate, spend tracker, descriptor catalog, resolver, injector. SQLite + OS keychain backed. Implements the contract Loom defines. |
| **Implementation — bundles** | `packages/cortex/src/connector/credentials/` | On-disk encrypted env-var bundles for connectors (one file per MCP server / Composio app). AES-256-GCM v2. Different shape from individual records — keyed by `connectorId`, holds many env vars at once. |

> Rule of thumb: if it's a *type* or a *protocol*, it lives here in Loom. If
> it's a *storage backend* or *policy gate*, it lives in Cortex.

## Files

| File | What it owns |
|---|---|
| `types.ts` | `CredentialPlacement`, `CredentialRequest`, `CredentialHandle`, `CredentialValue`, `EnvCredentialEntry`. The wire-format vocabulary used by `tools/types.ts` (the `ToolContext` callbacks) and `core/events.ts` (the HITL events the loop emits). |
| `descriptor.ts` | Tool-side declaration. A tool author declares "I need a bearer token labelled X with hint Y placed at Z." Pure metadata; no value. |
| `handle.ts` | The opaque pointer a tool receives back after a credential is supplied. Carries `credentialId`, `label`, `placement`, `storedAt` — never a value. The tool calls `ToolContext.resolveCredential(credentialId)` at execute time to get the actual string, and only inside executor code. |
| `patterns.ts` | Regex patterns the shell-output redactor uses to scrub secrets out of stdout/stderr **before** the LLM sees them. The one place a value is allowed near string code, and it never escapes the redactor. |
| `resolver.ts` | The interface Cortex implements. Loom takes a function, not a class — Cortex injects `(credentialId) => Promise<string>` at session-build time. Loom never imports anything from Cortex; the dependency flows the right way. |

## The cardinal rule

**The LLM never sees a raw secret.** Every type in `types.ts` is shaped so a
value string cannot flow into an event, a `ToolResult`, or a message. The
single exception (`CredentialValue`) exists only to feed the shell-output
redactor and is documented as never leaving tool internals.

## Why the split looks confusing but isn't

Both Loom and Cortex have a `descriptor.ts`, a `resolver.ts`, and a
`patterns.ts`. That's intentional:

- Loom's `descriptor.ts` is the **type definition**.
- Cortex's `descriptors.ts` is a **catalog of known descriptors** (Anthropic
  API key, Slack webhook, etc.) that ships with the app.
- Loom's `resolver.ts` is the **interface signature**.
- Cortex's `resolver.ts` is the **implementation** that reads from SQLite +
  keychain.
- Loom's `patterns.ts` is the **redaction regex set**.
- Cortex's `patterns.ts` is a **smaller per-provider extension set** layered
  on top.

If you ever want to embed Loom in something other than Cortex (a CLI, a
test harness, another product), you implement `resolver.ts`'s interface and
you're done. That's the entire reason the contract layer exists.

## See also

- `packages/cortex/src/credential/README.md` — record storage, policy
- `packages/cortex/src/connector/credentials/README.md` — bundle storage
