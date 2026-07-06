# Cortex — Connector Credential Bundles

This directory stores **encrypted env-var bundles** on disk, one file per
connector. It is a different storage shape from the record-level credential
store in `packages/cortex/src/credential/` — bundles hold many env vars
together (e.g. an MCP server that needs `GITHUB_TOKEN + DB_URL + REGION`),
keyed by `connectorId`.

## Where credentials live across the repo

| Layer | Path | What it stores | Backed by |
|---|---|---|---|
| **Contract** | `packages/loom/src/credentials/` | Types + protocol. No values. | — |
| **Records** | `packages/cortex/src/credential/` | One row per named credential, with audit and policy | SQLite + OS keychain |
| **Bundles** (this dir) | `packages/cortex/src/connector/credentials/` | One file per connector with N env vars | Disk: `~/.ownware/credentials/<connectorId>.json` |

## Files

| File | Role |
|---|---|
| `vault.ts` | Canonical implementation. `CredentialVault` class: `save / load / delete / list / checkEnvVars / resolveEnv`. AES-256-GCM v2 with a random 32-byte master key persisted to `~/.ownware/.master-key` (mode `0600`). Atomic writes via temp-file + `rename`. |

The MCP-specific facade lives one directory over at
`packages/cortex/src/connector/mcp/credentials.ts`. It is a thin back-compat
wrapper that delegates every method to `CredentialVault`. It exists only so
the assembler, gateway handlers, and existing tests keep resolving the old
import path. **Do not add logic to the facade — add it to `vault.ts`.**

## On-disk format

```
~/.ownware/credentials/<connectorId>.json
```

File contents (one of):

| Format | Layout | Status |
|---|---|---|
| **v2** (current) | `v2:<ivHex>:<authTagHex>:<cipherHex>` | All new writes. AES-256-GCM with the random master key. |
| **v1** (legacy) | `<ivHex>:<authTagHex>:<cipherHex>` | Auto-migrated to v2 on next read. AES-256-GCM with a key derived from `hostname + username`. |
| **plaintext JSON** (oldest) | `{ serverId, env, updatedAt }` | Auto-migrated to v2 on next read. |

The on-disk JSON keeps the field name `serverId` (not `connectorId`) for
byte-for-byte compatibility with files written before the vault was
generalized. The vault API exposes it as `connectorId`; the rename is an
internal storage detail.

## Why bundles instead of records?

Connectors typically need *several* env vars at once and the user thinks of
them as one connection. A custom MCP server that talks to Postgres needs
`PGHOST + PGUSER + PGPASSWORD + PGDATABASE` — that's one logical credential
to the user, four env-var slots to the runtime. Storing them as four
separate records would force the UI to reassemble them on every read and
forces atomicity questions on partial writes.

Bundles also map cleanly onto the way MCP / Composio connectors actually
consume credentials: spawn a subprocess (or HTTP request) with `env: {...}`
already populated.

## What does NOT belong here

- **Individual credentials with their own audit / HITL / spend tracking** —
  those are records; use `packages/cortex/src/credential/`.
- **Credential descriptors** (the catalog of known credential shapes) —
  also `packages/cortex/src/credential/descriptors.ts`.
- **OS keychain access** — bundles live on disk under their own master key,
  not in the OS keychain. Records are the ones that hand secret values off
  to the keychain.

## Security notes

- Master key is random, persisted to `~/.ownware/.master-key` with mode
  `0600`, parent dir `0700`. If the file is missing on read, a new key is
  generated; old files become unreadable, which is the desired behavior
  when a user resets their machine state.
- v1 keys (derived from `hostname + username`) are only kept for read
  back-compat. Any successful v1 read triggers an immediate re-save as v2.
- Atomicity: writes go to `<file>.<pid>.<rand>.tmp` and rename in. POSIX
  `rename(2)` is atomic — a crash leaves either the old file or the new
  file, never a partial one.

## See also

- `packages/loom/src/credentials/README.md` — the contract
- `packages/cortex/src/credential/README.md` — record storage and policy
- `packages/cortex/src/connector/mcp/credentials.ts` — back-compat facade
