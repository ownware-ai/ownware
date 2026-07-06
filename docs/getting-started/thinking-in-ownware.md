---
title: Thinking in Ownware
description: The mental model — profile, engine, gateway, channel — and where state and security live.
type: concept
---

# Thinking in Ownware

One picture explains the whole system:

```
 profile directory        @ownware/cortex          @ownware/loom          any client
 ─────────────────        ───────────────          ─────────────          ──────────
 agent.json               loadProfile()            Session loop           chat.mjs
 SOUL.md                  assembleAgent()          (model + tools,        web widget
 AGENTS.md (memory)       OwnwareGateway           streaming events)      Telegram bot
 skills/  tools/          (HTTP+SSE door)                                 your app

 The pipeline runs left → right: a text profile → assembled by the kernel →
 executed by the engine → reached by any client over one HTTP+SSE contract.
```

Each column is a stage, not a row-by-row mapping. Four ideas, one per column:

## 1. The agent is text

An Ownware agent is a **profile**: a directory of plain files. `agent.json` says *what it can do* (model, tools, security); `SOUL.md` says *who it is* (identity, rules, persona); `AGENTS.md` is what it has *learned* (memory); `skills/` and `tools/` extend it. There is no build step and no code required to define an agent — editing the files is editing the agent. This is why profiles can be shared, versioned in git, and installed like packages.

## 2. The engine runs, the kernel configures

Two packages with a strict division of labor:

- **The engine** (`@ownware/loom`) — a provider-agnostic agent loop that calls the model, executes tools, streams every event, and enforces zone-based security. It has *no opinions*: no default prompt, no default tools.
- **The kernel** (`@ownware/cortex`) — it reads your profile, resolves the provider, assembles tools and the system prompt, applies the security level, and hands a ready session to the engine.

Rule of thumb: **the kernel decides WHAT agent to run; the engine decides HOW to run it.**

## 3. The gateway is the only door

`OwnwareGateway` wraps the kernel in one HTTP+SSE service. Every client — the quickstart terminal chat, a web app, a channel adapter — uses the exact same wire contract: `POST /api/v1/run` to start a run, an SSE stream to watch it think, `POST …/resume` to answer permission requests. If you can `fetch`, you can build an Ownware client, in any language. Threads persist across restarts; everything is stored under `~/.ownware/` on *your* machine.

## 4. Channels are thin clients

Putting your agent on Telegram or Slack doesn't change the agent. A **Shuttle** adapter just carries messages: platform message in → `POST /api/v1/run` → tail the SSE → reply out, keeping one thread per person. One agent, many identities, same contract.

## Where security lives

Security is layered, and it sits *below* the model — the model cannot talk its way past it:

1. **Tool policy** (`agent.json`) — which tools exist at all (`preset`, `allow`, `deny`).
2. **Input guards** — declarative per-tool rules that reject bad inputs before execution.
3. **Zones** — every tool call is classified at call time into 7 levels (`safe` → `never`); combination rules catch multi-step attacks like *read a secret, then make a network call*.
4. **Permissions** — when a zone says "ask", the run pauses, emits `permission.request`, and waits for a human `approve`/`deny`.

## Next steps

- [Agents & profiles](../agents/overview.md) — write your own profile.
- [Gateway](../gateway/overview.md) — the service and its wire contract.
- [Channels](../channels/overview.md) — the Shuttle adapter model.
