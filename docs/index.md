---
title: Ownware
description: Open-source, self-hostable agent platform — build an agent as a text profile, run it as one process, reach it from anywhere over one HTTP+SSE contract.
type: concept
---

# Ownware

Ownware lets you **build your own agent and make it alive everywhere**. You define the agent as a folder of text files (a *profile*), one class turns that folder into a live HTTP+SSE service, and anything that can speak HTTP — a terminal, a web widget, Telegram, Slack, your own app — can talk to it. You host it; your keys never leave your machine.

```ts
import { OwnwareGateway } from 'ownware'

// tls:false keeps this plain-HTTP for localhost; the gateway defaults TLS *on*
// and forces it the moment you bind beyond loopback (see Exposing the gateway).
const ownware = new OwnwareGateway({ profilesDir: './profiles', port: 4000, tls: false })
await ownware.start()
// → your agent is live: POST /api/v1/run + SSE stream, threads, connectors, schedules
```

**For AI agents:** Ownware is a TypeScript/ESM monorepo (bun, Node ≥ 22). Install deps and build with `bun install && bun run build`. The umbrella package is `ownware` (`packages/ownware`) exporting `OwnwareGateway`, `defineTool`, `loadProfile`, `assembleAgent`, `Engine`, `Session`. An agent = a profile directory (`agent.json` + `SOUL.md`); serve it with `new OwnwareGateway({ profilesDir, port }).start()`; drive it with `POST /api/v1/run` `{"profileId","prompt"}` (Bearer token from `ownware.token`) and tail SSE at `/api/v1/threads/{threadId}/agents/root/events`. Keyless local models work via Ollama (`ollama:llama3.2`); cloud via `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `OPENROUTER_API_KEY`. Runnable example: `examples/quickstart/`.

## Start here

| I want to… | Read |
|---|---|
| See it run in 3 commands | [Quickstart](getting-started/quickstart.md) |
| Build & run an agent from the terminal | [The `ownware` CLI](reference/cli.md) |
| Install it in my own project | [Installation](getting-started/installation.md) |
| Understand how the pieces fit | [Thinking in Ownware](getting-started/thinking-in-ownware.md) |
| Build an agent as text files | [Agents & profiles](agents/overview.md) |
| Embed the engine as a library | [Engine (Loom) overview](engine/overview.md) |
| Talk to my agent over HTTP | [The run API](gateway/run-api.md) |
| Give my agent tools (MCP, Composio, custom) | [Tools & connectors](tools/overview.md) |
| Run keyless/local or pick a model | [Models](models/overview.md) |
| Put my agent on Telegram / Slack / Discord / WhatsApp / SMS | [Channels](channels/overview.md) |
| Understand the safety model | [Security overview](security/overview.md) |
| Expose it beyond localhost | [Exposing the gateway](gateway/exposing.md) |
| Look up an env var or option | [Configuration reference](reference/configuration.md) |
| Get a quick answer | [FAQ](faq.md) |
| Fix a common problem | [Troubleshooting](troubleshooting.md) |

## The packages

| Package | What it is |
|---|---|
| [`ownware`](../packages/ownware) | The umbrella package — one import for the quickstart surface. |
| [`@ownware/loom`](../packages/loom) | The agent runtime engine: provider-agnostic loop, streaming, tools, zone security, compaction, multi-agent. No opinions. |
| [`@ownware/cortex`](../packages/cortex) | The agent kernel & gateway: profiles, threads, SSE, connectors, credential vault, schedules, memory, teams. |
| [`@ownware/shuttle`](../adapters/shuttle) | Channel adapters: your agent on messaging platforms over the same wire contract. |

## License

Apache-2.0.
