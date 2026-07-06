# Cortex — Credential Records

This directory is the **record-level** credential implementation. Each row
here represents one named credential a user has registered (an Anthropic API
key, a Slack webhook URL, a Postgres connection string). It implements the
contract that `packages/loom/src/credentials/` defines.

For *bundles* of env vars per connector (MCP, Composio), see
`packages/cortex/src/connector/credentials/`. That's a different storage
shape, on-disk encrypted JSON files, not SQLite rows.

## Where credentials live across the repo

| Layer | Path | What it stores | Backed by |
|---|---|---|---|
| **Contract** | `packages/loom/src/credentials/` | Types + protocol. No values. | — |
| **Records** (this dir) | `packages/cortex/src/credential/` | One row per named credential, with audit and policy | SQLite + OS keychain |
| **Bundles** | `packages/cortex/src/connector/credentials/` | One file per connector with N env vars | Disk: `~/.ownware/credentials/<connectorId>.json` (AES-256-GCM v2) |

## Files

| File | Role |
|---|---|
| `schema.ts` | Zod schemas for credential records, descriptors, audit entries. The wire format is also re-exported through the gateway. |
| `descriptors.ts` | Catalog of known credential shapes (provider-specific: Anthropic key, OpenAI key, Slack bot token, Postgres URL, …). Each descriptor declares label, hint, placement, validation regex. |
| `bootstrap-providers.ts` | Seeds the descriptor table on first run. |
| `provider-binding.ts` | Maps a descriptor to one or more LLM/connector providers — answers "which credentials does Anthropic need?" |
| `store/` | Persistence layer. `db-backend.ts` is the SQLite implementation; `types.ts` is the storage interface; `index.ts` picks the active backend. |
| `resolver.ts` | Implements Loom's `CredentialResolver` interface — turns a `credentialId` into a value at execute time. Reads through `store/` + keychain. |
| `injector.ts` | Runtime helper called by tools. Given a `placement` + `credentialId`, injects the value into env vars / headers / query params / body fields exactly once. |
| `runtime.ts` | Wires `resolver` + `injector` + `audit` into the per-session credential context Loom receives. |
| `audit.ts` | Append-only log of credential reads/writes/deletes. Required for any compliance story; surfaced in the UI as the "credential activity" panel. |
| `hitl.ts` | Human-in-the-loop gate. When a tool requests a credential the user hasn't supplied yet, this raises a `credential.requested` event and parks the tool until the user provides a value. |
| `trust-gate.ts` | First-use authorization. The first time a profile asks for a credential, the user is prompted to allow/deny — subsequent uses honor the recorded decision. |
| `spend-tracker.ts` | Tallies token / dollar spend per credential. Lives here because it's keyed by credential, not by provider — multiple credentials can hit the same provider with different budgets. |
| `dotenv.ts` | One-time import path for users with an existing `.env` file. Reads, prompts to confirm, writes records. |
| `patterns.ts` | Per-provider extensions to Loom's redaction patterns. |
| `migrations/` | Schema evolution + data migrations (e.g. `import-file-vault.ts` migrates legacy file-based vaults into the SQLite store). |

## Contract relationship with Loom

```
   Loom defines               Cortex implements
   ─────────────              ─────────────────
   CredentialResolver  ◄────  resolver.ts
   CredentialRequest   ◄────  hitl.ts (raises the event)
   CredentialHandle    ◄────  store + resolver
   CredentialPlacement ◄────  injector.ts (honors all variants)
   CredentialValue     ◄────  injector.ts + redactor only
```

Loom never imports from Cortex. Cortex hands Loom a `runtime.ts`-built
context at session start. If the contract changes, both packages move
together — Loom's types first, then Cortex's implementations.

## What lives in the OS keychain vs SQLite

| In SQLite (`~/.ownware/ownware.db`) | In the OS keychain |
|---|---|
| Credential metadata: id, label, hint, placement, descriptor, audit, trust decisions, spend totals | The actual secret value |

The keychain is accessed through Electron's `safeStorage` API in production
and a fallback file in headless tests. The split exists so a database export
or backup never carries secrets.

## See also

- `packages/loom/src/credentials/README.md` — the contract
- `packages/cortex/src/connector/credentials/README.md` — bundle storage
