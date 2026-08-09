---
title: Configuration reference
description: Every OWNWARE_* environment variable and the GatewayOptions that matter in production, in one table.
type: reference
---

# Configuration reference

Two ways to configure Ownware, in precedence order: **explicit `GatewayOptions`**
(what you pass to `new OwnwareGateway({...})` or via `ownware serve` flags) win over
**`OWNWARE_*` environment variables**, which win over defaults. Everything is
optional — the zero-config default is a safe, keyless, loopback gateway.

**For AI agents:** the authoritative option parsing lives in
`packages/cortex/src/gateway/server.ts` (GatewayOptions + env fallbacks) and
`packages/cortex/src/cli/serve.ts` (flags). Data-dir resolution:
`OWNWARE_DATA_DIR` → `~/.ownware`.

## Core

| Env var | Default | What it does |
|---|---|---|
| `OWNWARE_DATA_DIR` | `~/.ownware` | Local state root: default SQLite DB, source bytes, credential key material, gateway token, TLS certs, and channels. PostgreSQL deployments still require and must back up this directory. |
| `OWNWARE_HOST` | `127.0.0.1` | Bind address. Anything non-loopback triggers the [bind-safety invariant](../gateway/exposing.md) (auth + TLS forced). |
| `OWNWARE_PORT` / `GATEWAY_PORT` | `3011` | Gateway port. |

## Storage

SQLite is the zero-configuration default. PostgreSQL is an explicit
`OwnwareGateway` library selection; setting a PostgreSQL URL by itself does not
change the backend or make `ownware serve` use it. See [Gateway storage](../gateway/storage.md)
for provisioning, TLS, backup/restore, offline transfer, and the single-gateway
support boundary.

| Env var | Default | What it does |
|---|---|---|
| `OWNWARE_POSTGRES_URL` | — | Runtime connection secret resolved only when `storage.kind` is `postgresql` and `runtimeConnection.source` is `environment`. |
| `OWNWARE_POSTGRES_MIGRATION_URL` | — | Conventional separate migration-role secret; select it with `migrationConnection: { source: 'environment', variable: 'OWNWARE_POSTGRES_MIGRATION_URL' }`. |

## Security & exposure

Full story: [Exposing the gateway](../gateway/exposing.md) and
[Security overview](../security/overview.md).

| Env var | Default | What it does |
|---|---|---|
| `OWNWARE_GATEWAY_TLS` | on (`ownware serve` on loopback: off) | `0` = plain HTTP. Refused on a non-loopback bind — exposed traffic must be encrypted. |
| `OWNWARE_REQUIRE_AUTH` | auto | `1` forces bearer-token auth even on loopback. |
| `OWNWARE_DISABLE_AUTH` | auto | `1` disables auth (loopback only — the local-first default); `0` re-enables it. Disabling auth on a non-loopback bind is refused at boot. |
| `OWNWARE_GATEWAY_TOKEN` | — | Bearer token override for *clients* (channel runner, `ownware schedule`). Default: read `<dataDir>/gateway-token` (written by the gateway, mode 0600). |
| `OWNWARE_MASTER_KEY` | derived per install | Hex-encoded 32-byte master key for the credential vault — set it when running in a container/CI where the keychain path isn't available. With no keychain and no value set, a key file is written under `<dataDir>` (mode 0600); see [Security overview](../security/overview.md). |
| `OWNWARE_RATE_LIMIT_RUN` / `OWNWARE_RATE_LIMIT_GENERAL` | `10` / `600` per minute | Requests-per-minute caps on `/api/v1/run` and everything else. |
| `OWNWARE_DISABLE_RATE_LIMIT` | off | `1` turns the gateway rate limiter off entirely (single-tenant/self-host escape hatch). |
| `OWNWARE_ALLOW_COMMAND_HOOKS` | off | `1` lets a profile's `command` hooks run shell commands. **Off by default so a downloaded profile can't execute code** — opt in only for profiles you trust. See [Security overview](../security/overview.md) and [Hooks](../agents/hooks.md). |
| `OWNWARE_DISABLE_HOOKS` | off | `1` is a global kill switch: no profile hooks fire at all (audit/incident use). |

## Channels & schedules

| Env var | Default | What it does |
|---|---|---|
| `OWNWARE_CHANNELS_DIR` | `<dataDir>/channels` | Where channel configs (encrypted) + pairing state live. |
| `OWNWARE_CHANNEL_SECRET` | derived | Secret for the AES-256-GCM channel-credential store. Set it for reproducible container deploys. |

## Providers & tools

| Env var | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `OPENROUTER_API_KEY` | — | Provider keys from the environment (the vault, via `ownware key add`, is the persistent path). |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Base URL for a non-default Ollama server (remote host or custom port) — the keyless local-model path. |
| `COMPOSIO_API_KEY` | — | Enables Composio-backed SaaS toolkits. |
| `OWNWARE_COMPOSIO_USER_ID` | derived | Pins the Composio entity id. |
| `OWNWARE_SKIP_MCP_REGISTRY` | — | `1` skips MCP registry sync at boot (faster boots, e.g. tests/CI). |

### Provider-route verification CLI

These variables are read only by the explicit `ownware provider verify`
operator command; they do not configure gateway startup. See
[Models](../models/overview.md#verify-one-provider-route) for the evidence
scope and safety contract.

| Env var | Default | What it does |
|---|---|---|
| `OWNWARE_PROVIDER_VERIFY_LIVE` | off | Must equal `1` before any paid/network verification probe can run. |
| `OWNWARE_PROVIDER_VERIFY_ADAPTER` / `OWNWARE_PROVIDER_VERIFY_ADAPTER_ID` | — | Selects the supported adapter kind and its exact runtime identity. Both are required. |
| `OWNWARE_PROVIDER_VERIFY_MODEL` / `OWNWARE_PROVIDER_VERIFY_PROVIDER_ROUTE_ID` / `OWNWARE_PROVIDER_VERIFY_MODEL_ROUTE_ID` | — | Required wire model, Provider Hub route, and Provider Hub model identities for the evidence record. |
| `OWNWARE_PROVIDER_VERIFY_CATALOG_GENERATION_ID` | — | Required `generation.id` from `GET /api/v1/provider-hub`; a different active catalog generation ignores the evidence. |
| `OWNWARE_PROVIDER_VERIFY_OUTPUT` | — | Required path for the validated, mode-0600 evidence bundle. Use `<dataDir>/provider-hub/verification-evidence.json` for gateway consumption. |
| `OWNWARE_PROVIDER_VERIFY_API_KEY` | — | Explicit transient verification credential. Never accepted as an argument, printed, or persisted in evidence. Required except for a supported no-auth compatible route. |
| `OWNWARE_PROVIDER_VERIFY_BASE_URL` / `OWNWARE_PROVIDER_VERIFY_AUTH_KIND` | — / `bearer` | Exact endpoint override and `bearer`/`none` placement. A base URL is required for OpenAI-compatible verification; `none` is limited to that adapter kind. |
| `OWNWARE_PROVIDER_VERIFY_PROBES` | text streaming, terminal events, usage reporting | Comma-separated contract probes. Unknown or empty entries fail before network access. |
| `OWNWARE_PROVIDER_VERIFY_ABORT_AFTER_MS` / `OWNWARE_PROVIDER_VERIFY_CONTEXT_CHARS` | harness defaults / off | Positive-integer cancellation timing and explicit oversized-context fixture length. |
| `OWNWARE_PROVIDER_VERIFY_EXPECT_RATE_LIMIT` / `OWNWARE_PROVIDER_VERIFY_STREAM_USAGE` | off | Exact `1` opt-ins for an expected rate-limit probe and compatible-stream usage reporting. |
| `OWNWARE_PROVIDER_VERIFY_TOOL_USE` / `OWNWARE_PROVIDER_VERIFY_PARALLEL_TOOL_USE` / `OWNWARE_PROVIDER_VERIFY_VISION` / `OWNWARE_PROVIDER_VERIFY_PDF` / `OWNWARE_PROVIDER_VERIFY_CACHE_CONTROL` | off | Exact `1` declarations of compatible-adapter features eligible for their matching probes; omission produces an honest skip rather than a support claim. |
| `OWNWARE_PROVIDER_VERIFY_IMAGE_PATH` / `OWNWARE_PROVIDER_VERIFY_IMAGE_MEDIA_TYPE` / `OWNWARE_PROVIDER_VERIFY_PDF_PATH` | — / `image/png` / — | Explicit local media fixtures. Their bytes and paths are not persisted in evidence. |

## Operations & debugging

| Env var | Default | What it does |
|---|---|---|
| `OWNWARE_TRACE` | off | `1` prints seam-by-seam gateway boot/request traces. |
| `OWNWARE_VERBOSE` | off | `1` widens migration/boot logging. |
| `OWNWARE_EVENT_RETENTION_ENABLED` | off | `1` prunes old raw `agent_events` rows for terminal threads (the consolidated `messages` history is never pruned). |
| `OWNWARE_EVENT_RETENTION_DAYS` | `30` | Age threshold for that pruning. |
| `OWNWARE_SSE_MAX_PENDING_WRITES` | `1000` | Per-connection cap on in-flight SSE writes (slow-consumer protection). |
| `OWNWARE_SSE_MAX_REPLAY_BUFFER` | `5000` | Cap on SSE replay buffering. |

## GatewayOptions (the library surface)

The options you actually reach for in code — the full type is
`GatewayOptions` in `@ownware/cortex` (re-exported by `ownware`):

```ts
import { homedir } from 'node:os'
import { join } from 'node:path'

new OwnwareGateway({
  profilesDir: './profiles',          // REQUIRED — the folder of agents to serve
  dataDir: join(homedir(), '.ownware'), // state root (tests: ALWAYS pass a temp dir).
                                      // Note: '~' is NOT expanded — pass an absolute path.
  host: '127.0.0.1',                  // non-loopback ⇒ auth+TLS forced
  port: 3011,                         // 0 = random free port
  tls: true,                          // false is loopback-only
  disableAuth: false,                 // refused at boot on a non-loopback bind
})
```

Storage selection is a strict discriminated union. This production PostgreSQL
example keeps connection material in the environment and verifies TLS:

```ts
new OwnwareGateway({
  profilesDir: './profiles',
  dataDir: '/srv/ownware/data',
  storage: {
    kind: 'postgresql',
    runtimeConnection: { source: 'environment' },
    migrationConnection: {
      source: 'environment',
      variable: 'OWNWARE_POSTGRES_MIGRATION_URL',
    },
    tls: { mode: 'verify-full', ca: { source: 'system' } },
    pool: {
      maxConnections: 10,
      connectionTimeoutMs: 5_000,
      statementTimeoutMs: 30_000,
      lockTimeoutMs: 5_000,
      migrationTimeoutMs: 120_000,
      shutdownTimeoutMs: 5_000,
    },
  },
})
```

The optional `pg@^8.22.0` peer is needed only for this selection. SQLite needs
no PostgreSQL package or service. Unknown fields, conflicting `dbPath` +
`storage`, unsafe remote plaintext, missing secrets, and unknown adapter kinds
fail before the listener starts.

`ownware serve` flags map 1:1: `--profiles`, `--data-dir`, `--host`, `--port`,
`--tls` / `--no-tls`, plus `--no-channels` (skip booting stored channels
in-process). It currently uses SQLite; use `OwnwareGateway` for explicit
PostgreSQL selection.
