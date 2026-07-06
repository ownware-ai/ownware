# ownware

**Build your own agent — alive everywhere.** Open-source, self-hosted
agent platform: build an agent as a text profile, run it yourself as
one process, reach it everywhere over one HTTP+SSE contract.

This is the umbrella package — one install for the whole quickstart
surface: the `ownware` CLI, the `OwnwareGateway` class, and the profile +
tool APIs.

## Your agent live in three commands

```bash
ownware init      # drop a starter profile into ./profiles (the agent, as text)
ownware serve     # serve it: HTTP+SSE gateway, safe by default
# open a second terminal and talk to it — curl, @ownware/client, or any HTTP client
```

**No API key needed to try it** — with [Ollama](https://ollama.com)
installed the first answer runs fully local. Have a key? `ownware key add
anthropic` (or `openai` / `google` / `openrouter`) stores it in the
encrypted credential vault.

```bash
ownware channel add slack --profile assistant --bot-token xoxb-… --app-token xapp-…
# the same agent now answers in Slack (also: telegram, discord, whatsapp, sms)
```

## Or as a library — the whole backend in five lines

```ts
import { OwnwareGateway } from 'ownware'

const ownware = new OwnwareGateway({ profilesDir: './profiles', port: 4000 })
await ownware.start()
// → POST /api/v1/run + SSE stream, threads, connectors, schedules
```

Talk to it from anywhere with [`@ownware/client`](https://www.npmjs.com/package/@ownware/client)
(zero-dep, Node + browser).

## What's inside

`ownware` re-exports the curated surface of two packages:

| Package | Layer |
|---|---|
| `@ownware/cortex` | The kernel + gateway — profiles, threads, connectors (MCP/Composio/builtin), credential vault, schedules, the security boundary. |
| `@ownware/loom` | The engine — the agent loop, streaming, tools, permissions, compaction, multi-agent. |

Power users import those directly; the quickstart never needs to.

## The agent is a folder of text

```
profiles/assistant/
├── agent.json   # what it can do — model, tools, security
├── SOUL.md      # who it is — personality and rules
└── skills/      # what it knows how to do
```

Editing these files IS customizing your agent. No SDK required to
change what your agent is.

## Safe by default

- Exposing the gateway beyond localhost **forces auth + TLS** — an
  unsafe bind refuses to boot.
- Credentials live in an encrypted vault; the engine only ever holds
  opaque handles. No plaintext, ever — not in logs, events, or the DB.
- Permission-gated tools ask before acting; zones and combination
  rules limit what can touch what.

## Learn more

- Docs: [`docs/`](https://github.com/ownware-ai/ownware/tree/main/docs) — quickstart, profile format, gateway API, channels
- Repo: [github.com/ownware-ai/ownware](https://github.com/ownware-ai/ownware)

Apache-2.0.
