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
| `OWNWARE_DATA_DIR` | `~/.ownware` | Where everything lives: SQLite DB, credential vault, gateway token, TLS certs, channels. Delete it to reset. |
| `OWNWARE_HOST` | `127.0.0.1` | Bind address. Anything non-loopback triggers the [bind-safety invariant](../gateway/exposing.md) (auth + TLS forced). |
| `OWNWARE_PORT` / `GATEWAY_PORT` | `3011` | Gateway port. |

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

`ownware serve` flags map 1:1: `--profiles`, `--data-dir`, `--host`, `--port`,
`--tls` / `--no-tls`, plus `--no-channels` (skip booting stored channels
in-process).
