---
title: Built-in tools
description: Loom's built-in tool kit — filesystem, shell, browser, memory, web, sub-agents, tasks, and media — imported whole, by category, or one at a time.
type: reference
---

# Built-in tools

Loom ships a batteries-included tool kit. Import the whole thing, a category, or pick individual tools.

```ts
import {
  builtinTools,          // EVERYTHING below — the whole kit
  filesystemTools,       // readFile, writeFile, editFile, listFiles, glob, grep
  shellTools,            // shell_execute
  browserTools,          // 17 browser tools (Chrome DevTools Protocol)
  memoryTools,           // memory_store, memory_search, memory_forget
  speechTools,           // speech_synthesize, speech_transcribe
  imageGenerateTools,    // image_generate
  credentialTools,       // secure credential-request tools
} from '@ownware/loom'
```

`builtinTools` is the full kit: everything above **plus** web (`web_search`, `web_fetch`), sub-agent spawning (`agent_spawn`), human-in-the-loop (`ask_user`), and task lists (`todo_write`). The sections below cover each group.

## Filesystem

`readFile`, `writeFile`, `editFile`, `listFiles`, `glob`, and a **ripgrep-powered** `grep` with regex, multiline matching, `.gitignore` respect, and output caps. The `grep` binary auto-installs per platform via `@vscode/ripgrep`.

## Shell

`shell_execute` runs commands through a **5-level security classifier**. Level 1 (irreversible: `mkfs`, `reboot`, fork bombs) is never allowed; Level 4 (exfiltration patterns) and Level 5 (PII detection in output) are always on. See [Security](security.md) for how to constrain shell input with guards.

## Browser

17 tools driving Chrome over the DevTools Protocol: navigate, click, type, screenshot, snapshot, scroll, evaluate JS, and tab management.

## Memory

`memory_store`, `memory_search`, `memory_forget` — persistent memory the agent can write to and recall across turns.

## Web

`web_search` (pluggable strategies — DuckDuckGo needs no key, or Brave/Tavily) and `web_fetch` (HTTP GET with an html→text conversion hook).

## Sub-agents & human-in-the-loop

`agent_spawn` launches an isolated sub-agent with its own scoped tools and prompt (see [Multi-agent](multi-agent.md)); `ask_user` poses a structured question and waits for a human answer.

## Tasks

`todo_write` maintains a working task list the agent can plan against and tick off across a long run.

## Media

`image_generate` (bring-your-own provider — DALL·E, SD, …), `speech_synthesize` (TTS) and `speech_transcribe` (STT) — all pluggable. These are stubs you wire a provider into, not turnkey.

## Credentials

`credentialTools` let a tool request a secret through the human-in-the-loop credential flow instead of receiving it inline — the value never enters the model's context.

## Using them

Pass a tool array to any call pattern:

```ts
import { Loom, filesystemTools, shellTools } from '@ownware/loom'

await Loom.run('sonnet', 'List the TypeScript files and count the lines', {
  tools: [...filesystemTools, ...shellTools],
})
```

Every tool — built-in, custom, or MCP — passes through the same security layers. A tool existing in the array doesn't mean it can be called with any input; see [Security](security.md).

## Next steps

- [Custom tools](custom-tools.md) — write your own with `defineTool`.
- [Hooks](hooks.md) — run logic before/after every tool call.
- [MCP](mcp.md) — adopt tools from any MCP server.
