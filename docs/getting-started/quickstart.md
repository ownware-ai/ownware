---
title: Quickstart
description: Build your own agent, talk to it, and serve it — in four commands with the ownware CLI. No API key required.
type: howto
---

# Quickstart

By the end of this page you've built your own agent, talked to it in the terminal, and
(optionally) served it as a live HTTP+SSE service — all with the `ownware` command.

> **Prerequisites** — Node ≥ 22. Install the CLI with `npm i -g ownware` (or `bun add -g
> ownware`). No API key needed if you have [Ollama](https://ollama.com) (see step 2).
>
> **From a source checkout** (for contributors): run `bun install && bun run build`
> once, then use `bun run ownware …` wherever this page says `ownware …`.

## The four commands

```bash
ownware init                                              # 1. build it
ownware profile set assistant --model ollama:llama3.2     # 2. give it a keyless local model
ownware run assistant "hello"                             # 3. talk to it — no server
ownware serve                                             # 4. serve it — the whole backend
```

Build → talk → serve is the whole arc. The one line in the middle points the agent at a
model: `ownware init` defaults `agent.json` to `openai:gpt-5.5` (needs a key), so for the
**keyless** path you switch it to a local Ollama model first. Prefer a cloud model? Skip
that line and run `ownware key add openai` instead (or point the profile at another
provider — `ownware profile set assistant --model anthropic:claude-sonnet-4-6` plus
`ownware key add anthropic`). Everything below is those steps, explained.

## 1. Build your agent

```bash
ownware init
```

This scaffolds `./profiles/assistant/`:

```
profiles/assistant/
├── agent.json   # WHAT it can do — model, tools, security
└── SOUL.md      # WHO it is — personality and rules (markdown)
```

Editing those two files **is** building the agent — no SDK, no wizard. Want a
differently-named one? `ownware profile new <name>` (see
[the CLI reference](../reference/cli.md#ownware-profile--build--manage-agents)).

## 2. Give it a model (pick one)

**Keyless & local** — free and private:

```bash
brew install ollama && ollama pull llama3.2                              # macOS
curl -fsSL https://ollama.com/install.sh | sh && ollama pull llama3.2    # Linux
```

The Ollama server must be running before you pull or use a model — launch the Ollama app,
or run `ollama serve` in another terminal (otherwise you'll see "could not connect to ollama
server"). Then set the model: `ownware profile set assistant --model ollama:llama3.2`.

**Or a cloud key** — saved once, encrypted in `~/.ownware`, never exported again:

```bash
ownware key add openai           # or anthropic · google · openrouter
```

## 3. Talk to it — right here, no server

```bash
ownware run assistant "hello — introduce yourself"
```

You should see the profile header, then the reply stream in:

```
Ownware · assistant · ollama:llama3.2
Hi! I'm your assistant — I can read and write files, search the web, and remember what
you tell me. What are we working on?
Time: 1.9s
```

`ownware run` assembles the profile and streams the reply straight to your terminal. When
the agent wants to use a tool that needs approval, it asks you `y/n` — that's the
permission system working. Point it at a working directory with `-w ./my-app`.

## 4. Serve it (when something else needs to reach it)

```bash
ownware serve
```

Now the agent is a live service on `http://localhost:3011` — runs, streaming, persistent
threads, the vault, permission approvals, schedules, **and your channels in-process**.
`serve` prints a copy-paste `curl` that answers immediately. You only need this step when a
web app, a channel, or a schedule has to talk to the agent — local chat never needs it.

## What you just ran

- **`ownware init`** wrote `profiles/assistant/` — the agent, as text.
- **`ownware run`** ran the profile in-process and streamed the answer. No gateway.
- **`ownware serve`** turned the same folder into the full HTTP+SSE backend.

> Prefer to build on the library/wire contract directly? [`examples/custom-client/`](../../examples/custom-client/) ships
> `serve.mjs` (`OwnwareGateway` in ~15 lines) and `chat.mjs` (a ~100-line client over the
> raw contract) — the integration path for [building your own app](../gateway/run-api.md).

## Next steps

- [The `ownware` CLI reference](../reference/cli.md) — every command and flag.
- [Thinking in Ownware](thinking-in-ownware.md) — the mental model behind what you just saw.
- [Agents & profiles](../agents/overview.md) — make the agent yours: personality, model, tools, security.
- [Channels](../channels/overview.md) — put it on Slack / Telegram / Discord / WhatsApp / SMS.
- [The run API](../gateway/run-api.md) — drive the agent from any language.
