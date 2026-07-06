---
title: Gateway
description: OwnwareGateway turns a profiles folder into one HTTP+SSE service — auth, TLS, threads, and where data lives.
type: concept
---

# Gateway

The gateway is your agent's front door. One class — `OwnwareGateway` from the `ownware` package — serves every profile in a folder as a single HTTP+SSE service with bearer-token auth, persistent threads, connectors, and schedules.

**For AI agents:** `new OwnwareGateway({ profilesDir: './profiles', port: 4000, tls: false }).start()` boots the service (the CLI `ownware serve` defaults to port **3011**; these library examples use 4000 so both can run side by side); `ownware.port` and `ownware.token` give the connection details. Requests need `Authorization: Bearer <token>` only when auth is on (any non-loopback bind); on the localhost default it's off. Start a run: `POST /api/v1/run` with `{"profileId","prompt","model"?,"threadId"?}` → `{threadId}`. Stream events: `GET /api/v1/threads/{threadId}/agents/root/events?since=<seq>` with `Accept: text/event-stream`. Answer permission prompts: `POST /api/v1/threads/{threadId}/resume` with `{"action":"approve"|"deny"}`. List usable models: `GET /api/v1/models`.

## When to use the gateway

- You want your agent reachable by more than one client (terminal, web, channels) — or by any client at all over HTTP.
- Prefer the in-process API (`Engine` / `Session`) when a single app embeds the agent directly and doesn't need HTTP, persistent threads, or channel adapters.

## Quickstart

```js title="serve.mjs"
import { OwnwareGateway } from 'ownware'

const ownware = new OwnwareGateway({
  profilesDir: './profiles',
  port: 4000,
  tls: false,          // plain HTTP — for localhost only
})
await ownware.start()

console.log(`live at http://localhost:${ownware.port}`)
console.log(`token: ${ownware.token}`)
```

> **Port note:** these library examples use `4000`. The `ownware serve` CLI (and every first-party client — channels, schedules) defaults to **`3011`** — so if you paste a curl that says `:3011`, that's the CLI default, and `:4000` is this embedded example's explicit override.

## How it works

On `start()`, the gateway discovers every profile in `profilesDir`, assembles each into a runnable agent (see [Thinking in Ownware](../getting-started/thinking-in-ownware.md)), and exposes them all through one API. Each run executes in a thread; threads, the credential vault, and memory persist in `~/.ownware/` (`OWNWARE_DATA_DIR` to override) — stop and restart the process and your conversations are still there.

> **Warning** — the gateway defaults to **TLS on** (self-signed certificate). `tls: false` keeps first contact copy-paste simple on localhost, but never expose a plain-HTTP gateway beyond loopback. `OWNWARE_*` environment variables configure host, port, TLS, and auth.

## Go deeper

| I want to… | Read |
|---|---|
| The full wire contract, endpoint by endpoint | [The run API](run-api.md) |
| Put the agent on messaging platforms | [Channels](../channels/overview.md) |
| Understand permissions and security | [Thinking in Ownware § security](../getting-started/thinking-in-ownware.md#where-security-lives) |
