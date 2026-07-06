---
title: Agents & profiles
description: An agent is a folder of text files — what a profile is, when to use one, and how to serve it.
type: concept
---

# Agents & profiles

An Ownware agent is defined entirely by a **profile**: a directory of text files that says who the agent is, what it can do, and how safely it should behave. No code is required to create one.

**For AI agents:** create a directory under your `profilesDir` containing `agent.json` (minimum `{"name":"<id>"}`; optional keys: `description`, `model` as `provider:model` string, `tools` `{preset: full|coding|readonly|none, allow[], deny[]}`, `memory` `{enabled, sources}`, `security` `{level: permissive|standard|strict|paranoid, permissionMode: ask|…}`) and optionally `SOUL.md` (system prompt). Serve with `new OwnwareGateway({ profilesDir, port }).start()` from the `ownware` package; the profile is then addressable as `profileId` on `POST /api/v1/run`.

## When to use profiles

- You want an agent you can version, share, and edit without redeploying code.
- You want many agents (support, research, finance…) served by one process.
- Prefer the in-process engine API (`Engine`, `Session` from `ownware`) instead when you're embedding a single agent inside an existing app and don't need HTTP, threads, or channels.

## Quickstart

```json title="profiles/assistant/agent.json"
{
  "name": "assistant",
  "description": "A general-purpose assistant: reads and writes files, searches the web, remembers what you tell it.",
  "model": "anthropic:claude-sonnet-4-6",
  "tools": { "preset": "full", "deny": ["shell_execute"] },
  "memory": { "enabled": true, "sources": ["AGENTS.md"] },
  "security": { "level": "standard", "permissionMode": "ask" }
}
```

```md title="profiles/assistant/SOUL.md"
You are a friendly, concise assistant. Prefer short answers. Never invent file contents.
```

Serve the folder and the agent is live:

```js
import { OwnwareGateway } from 'ownware'
await new OwnwareGateway({ profilesDir: './profiles', port: 4000 }).start()
```

## How it works

`loadProfile()` reads and validates the directory, `assembleAgent()` resolves the provider, assembles tools, and builds the system prompt (SOUL.md + context fragments like git status, OS, date), then hands a ready session to the engine. The gateway does this for every profile in `profilesDir` and exposes each one by name.

## Go deeper

| I want to… | Read |
|---|---|
| Every field of `agent.json`, SOUL.md, skills, memory | [Profile format](profile-format.md) |
| Add MCP servers, Composio apps, custom tools | [Tools & connectors](../tools/overview.md) |
| Pick or change the model | [Models](../models/overview.md) |
| Understand security levels and zones | [Thinking in Ownware § security](../getting-started/thinking-in-ownware.md#where-security-lives) |
