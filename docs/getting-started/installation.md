---
title: Installation
description: Add Ownware to your own project and serve your first profile.
type: howto
---

# Installation

This page installs Ownware into your own project. If you just want to see it run first, do the [Quickstart](quickstart.md).

> **Prerequisites** — Node ≥ 22.

## 1. Install the package

```bash
bun add ownware          # bun
npm install ownware      # npm
pnpm add ownware         # pnpm
```

The `ownware` umbrella package is the curated surface: `OwnwareGateway`, `defineTool`, profile helpers, and the in-process engine. Power users can import `@ownware/loom` (engine) or `@ownware/cortex` (kernel/gateway) directly.

> **Native dependencies build on install.** Ownware compiles a couple of native modules (`better-sqlite3`, `node-pty`) and fetches a ripgrep binary during `postinstall`. On most machines this is automatic; if it fails you're missing platform build tools — see [Troubleshooting](../troubleshooting.md).

## 2. Create a profile

A profile is a folder of text files. The minimum is one JSON file:

```json title="profiles/my-agent/agent.json"
{
  "name": "my-agent"
}
```

Optionally give it a personality:

```md title="profiles/my-agent/SOUL.md"
You are a concise, helpful assistant for my project.
```

Every other setting (model, tools, security) has a sensible default — see [Profile format](../agents/profile-format.md). The default model is `openai:gpt-5.5`.

> **The agent needs a model to reply.** With no model key set, the run starts but never answers. Either set a provider key first (`export OPENAI_API_KEY=…`, or `ownware key add openai` for the encrypted vault), or point the profile at a local model — add `"model": "ollama:llama3.2"` to `agent.json` and run Ollama (no key needed). Prefer another provider? Set the profile model to it (e.g. `"model": "anthropic:claude-sonnet-4-6"` plus `ownware key add anthropic`). See [Models](../models/overview.md).

## 3. Serve it

```js title="serve.mjs"
import { OwnwareGateway } from 'ownware'

// tls:false is for localhost only — the gateway defaults TLS *on* (see the
// warning below). Without it, this serves HTTPS and the plain http:// curl
// below would fail.
const ownware = new OwnwareGateway({ profilesDir: './profiles', port: 4000, tls: false })
await ownware.start()

console.log(`live at http://localhost:${ownware.port} — token: ${ownware.token}`)
```

```bash
node serve.mjs
```

## Verify it works

```bash
curl -X POST http://localhost:4000/api/v1/run \
  -H "Content-Type: application/json" \
  -d '{"profileId":"my-agent","prompt":"hello"}'
```

You should get back JSON containing a `threadId` — the run has started. Stream the reply per [The run API](../gateway/run-api.md).

> On a localhost bind, gateway auth is off, so no `Authorization` header is needed. The moment you expose the gateway beyond loopback, auth turns on (and can't be disabled) — then every request needs `Authorization: Bearer <token>`. See [Exposing the gateway](../gateway/exposing.md).

## Where data lives

Everything the gateway stores (threads, credential vault, memory) lives in `~/.ownware/` on your machine. Override with `OWNWARE_DATA_DIR`. Delete the folder to reset everything.

> **Warning** — the gateway defaults to TLS on. `tls: false` (as in the quickstart) is for localhost only; before exposing an agent beyond loopback, keep TLS on and read [Exposing the gateway](../gateway/exposing.md).

## Next steps

- [Profile format](../agents/profile-format.md) — every field of `agent.json`.
- [Models](../models/overview.md) — keyless local via Ollama, or bring a provider key.
- [The run API](../gateway/run-api.md) — the full wire contract.
