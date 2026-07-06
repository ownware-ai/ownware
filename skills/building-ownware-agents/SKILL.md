---
name: building-ownware-agents
description: Build, run, serve, and embed AI agents with Ownware — the open-source, self-hostable agent platform (npm package `ownware` + the `ownware` CLI). An agent is a text profile (agent.json + SOUL.md); serve it with OwnwareGateway as one HTTP+SSE service and reach it from a web/React app, mobile, Slack, Telegram, or the terminal. Use when the user wants to build their own AI agent, scaffold or edit an Ownware profile, run or serve an agent, wire the gateway run/events/resume/models API into an app, add a messaging channel or schedule, or asks about Ownware, OwnwareGateway, agent.json, or SOUL.md.
---

# Building Ownware agents

Ownware turns a folder of text into a running AI agent you host yourself, on any model, reachable everywhere over one HTTP+SSE contract. Build the agent once (a profile) → run it (one process) → reach it anywhere (one wire contract). The user keeps their keys, their model, their machine.

Two ways to work with it: the **`ownware` CLI** (fastest — build and serve from the terminal) and the **`ownware` library** (embed the gateway in your own app). Prefer the CLI unless the user is integrating Ownware into an existing codebase.

For anything not covered here, read the canonical docs — start at the agent doc index **`docs/llms.txt`** (https://github.com/ownware-ai/ownware/blob/main/docs/llms.txt). Field-level detail (full `agent.json`, the event vocabulary, channels, security) is in [reference.md](reference.md) — read it when you need specifics.

## When a user asks you to build one

Drive the whole flow for them — a one-line request ("build me an agent that…") should end with a working, running agent, not just files on disk.

**First, understand — don't guess.**
- **Get grounded in the docs.** Read [reference.md](reference.md) end to end (it ships with this skill — a local read), and for anything it doesn't cover, open the matching page via `docs/llms.txt`. Base what you build on Ownware's real behavior, never on assumptions.
- **Ask a few sharp questions first** — but only where the answer changes what you build: what the agent should *do*, its tone/personality, which model (a cloud key, or keyless `ollama:llama3.2`), and where it should live (terminal, a channel like Telegram, or an app). Assume sensible defaults for everything else, state them in one line, and confirm the plan before scaffolding. Don't interrogate — a handful of pointed questions, then go.

**Then drive the flow:**

1. **Scaffold** the profile (`ownware init` or `ownware profile new <name>`), then edit `agent.json` + `SOUL.md` to match what they asked for — personality, tools, model.
2. **Give it a model so it can reply** — ask the user for a provider key and run `ownware key add`, or set a keyless `ollama:llama3.2`. Never leave it model-less (it would hang with no answer).
3. **Channel** (if they want it on Telegram/Slack/etc.) — ask for the credential when you reach that step (e.g. a Telegram bot token from @BotFather), then `ownware channel add`.
4. **Serve and actually test end to end** — `ownware serve`, then run it / send a real message and show the user the output. Never claim it works without driving it.
5. **Ask for what you need as you go** (keys, tokens); never invent or hardcode a secret. Keep the gateway on localhost unless the user asks to expose it.

## Install

```bash
npm install -g ownware      # the `ownware` CLI  (or: bun add -g ownware)
# — or, to embed in your own project —
bun add ownware             # the library: OwnwareGateway, defineTool, profile helpers
```

Requires Node ≥ 22. Native modules build on install (`better-sqlite3`, `node-pty`); a failure means missing platform build tools.

## Fastest path — the CLI

```bash
ownware init                                   # scaffold ./profiles/assistant (agent.json + SOUL.md)
ownware profile set assistant --model ollama:llama3.2   # keyless local model (or use a cloud key, below)
ownware run assistant "hello"                  # talk to it in the terminal — in-process, no server
ownware serve                                  # serve it: the whole backend, one process
```

- `ownware run` streams the reply locally — **no gateway needed**. Use it to test the agent.
- `ownware serve` boots the gateway over `./profiles` on `http://127.0.0.1:3011` (streaming, threads, vault, schedules, and any stored channels in-process). This is the deploy.

## What an agent is — the profile

A profile is a folder of text. The minimum is one file:

```json
// profiles/my-agent/agent.json
{ "name": "my-agent" }
```

Everything else defaults sensibly. The common shape you'll actually write:

```jsonc
// profiles/my-agent/agent.json
{
  "name": "my-agent",
  "description": "What this agent does",
  "model": "anthropic:claude-sonnet-4-6",     // provider:model — or "ollama:llama3.2" (keyless, local)
  "tools": {
    "preset": "full",                          // full | coding | readonly  (the starting tool set)
    "deny": ["shell_execute"],                 // glob denylist; also "allow", "custom", "mcp", "composio"
    "custom": [{ "path": "tools/my-tool.ts" }] // your own defineTool files
  },
  "memory": { "enabled": true, "sources": ["AGENTS.md"] },
  "security": { "level": "standard", "permissionMode": "ask" }  // "ask" pauses on sensitive tools for approval
}
```

Alongside `agent.json` in the folder: `SOUL.md` (system prompt — personality + rules), optional `AGENTS.md` (memory), `tools/` (custom tools), `skills/`. Editing these files **is** customizing the agent. The default model is `anthropic:claude-sonnet-4-6`. The full schema — `tools.mcp`, `composio`, `context`, `execution`, `hooks` — is in [reference.md](reference.md).

Scaffold with `ownware profile new <name>`; manage with `ownware profile list · show · set · open · remove`.

## Give it a model

The agent needs a model to reply. Two options:

```bash
ownware key add anthropic          # store a provider key, encrypted (or: openai · google · openrouter)
# — or keyless, fully local —
ownware profile set my-agent --model ollama:llama3.2   # run Ollama; no key needed
```

Model strings are `provider:model` (e.g. `anthropic:claude-sonnet-4-6`, `openrouter:haiku-4.5`, `ollama:llama3.2`). With no model configured, the run starts but never answers.

## Serve it — the gateway

From the CLI it's just `ownware serve`. To embed the gateway in your own Node app:

```js
import { OwnwareGateway } from 'ownware'

const ownware = new OwnwareGateway({ profilesDir: './profiles', port: 4000, tls: false })
await ownware.start()
console.log(`live at http://localhost:${ownware.port} — token: ${ownware.token}`)
```

Key `OwnwareGateway` options: `profilesDir` (where profiles live), `port` (CLI default `3011`), `tls`, `dataDir` (default `~/.ownware`). After `start()`, `ownware.port` and `ownware.token` are the connection details a client uses.

`tls: false` is **localhost only** — the gateway defaults TLS on. On a loopback bind, auth is off (curl works with no header). The moment you bind non-loopback, TLS and bearer-token auth are **forced** and can't be disabled. Data lives in `~/.ownware/`.

## Build an app around it — the wire contract

Any frontend — React, mobile, a Slack bot, your own backend — talks to the served gateway over four HTTP calls. This is how you build a whole application on top of an Ownware agent:

```
POST /api/v1/run                                  {profileId, prompt, model?, threadId?} → {threadId}
GET  /api/v1/threads/{threadId}/agents/root/events?since=<seq>   Server-Sent Events stream
POST /api/v1/threads/{threadId}/resume            {action: "approve"|"deny"}  (answer a permission prompt)
GET  /api/v1/models                               list models; filter hasCredentials
```

A React/web client `POST`s to `/run`, then tails the SSE stream (text deltas, tool calls, permission requests, cost, end). Keep one `threadId` for a conversation. It needs nothing but `fetch` + SSE, so any language/framework can do it. See the full flow and event vocabulary in [reference.md](reference.md), and the runnable reference client at `examples/custom-client/chat.mjs` in the repo. Full endpoint docs: `docs/gateway/run-api.md`.

## Reach people — channels

Put the agent on messaging platforms (each is a client of the gateway; no public webhook needed):

```bash
ownware channel add slack --profile my-agent --bot-token xoxb-… --app-token xapp-…
ownware serve      # boots the channel in-process — message the bot
```

Kinds: `slack · telegram · discord · whatsapp · sms`. Unknown senders are held until approved (`ownware channel approve <channel> <code>`) — the agent doesn't talk to strangers by default. Proactive runs: `ownware schedule add … --daily 08:30 --deliver slack:#sales`. Credential flags per channel are in [reference.md](reference.md).

## Rules that keep it correct

1. **A model is required to reply** — set a key (`ownware key add`) or a keyless `ollama:` model, or the run hangs with no answer.
2. **Loopback is trusted; exposed is not.** Localhost = plain HTTP, no auth. Any non-loopback bind forces TLS + bearer auth. Never expose with `tls: false`.
3. **Never commit provider keys.** They live encrypted in `~/.ownware/`; the vault never stores plaintext. Don't paste keys into `agent.json` or code.
4. **The profile is the source of truth for the agent; the docs are the source of truth for Ownware.** When unsure about a field or endpoint, read `docs/llms.txt` and the page it points to rather than guessing.
5. **Verify the real flow** — after building a profile, actually `ownware run` it (and `ownware serve` + one `/run` call if the user is building an app), not just check that files were written.

## Where to read more

- **[reference.md](reference.md)** — ships with this skill (a **local** read, no network): the full `agent.json` schema, the SSE event vocabulary, a minimal client, channels, security, and the CLI command map. **Check here first.**
- **Everything else / the latest** — the repo at https://github.com/ownware-ai/ownware. Its `docs/llms.txt` is the agent doc index — use it to find any page (profile format, hooks, exposing, models, tools). Rendered: https://docs.ownware.dev
