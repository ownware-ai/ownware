---
title: Tools & connectors
description: Give your agent capabilities — built-in tools, any MCP server, 400+ apps via Composio, or your own TypeScript.
type: concept
---

# Tools & connectors

Tools are what your agent can *do*. Ownware ships a built-in kit (filesystem, shell, web, browser, memory, sub-agents, …), and three connector types add more — each one line of config in `agent.json`, no code changes.

**For AI agents:** built-ins are selected by `tools.preset` (`full`/`coding`/`readonly`/`none`) filtered by `allow`/`deny` globs (deny wins). Add MCP servers under `tools.mcp` (`{"<name>": {"transport":"stdio","command":"npx","args":[…]}}` — url transport also supported); Composio via `tools.composio` `{"toolkits":["github","notion"]}` (requires `COMPOSIO_API_KEY` env before boot, otherwise silently disabled); custom tools via `tools.custom` `[{"path":"tools/my-tool.ts"}]` where the file exports `defineTool({ name, description, inputSchema, execute })` from `ownware`. Restart the gateway after editing.

## When to use which

| You want | Use |
|---|---|
| Files, shell, search on the host | Built-in presets — already there |
| An existing tool server (filesystem, GitHub, databases…) | **MCP** — any stdio or url server |
| SaaS apps (GitHub, Notion, Slack, 400+) with managed auth | **Composio** |
| Your own logic in TypeScript | **Custom tools** |

## Built-in tools

Selected by `tools.preset`, filtered by `allow`/`deny` globs — deny always wins:

```json
"tools": { "preset": "full", "deny": ["shell_execute"] }
```

Presets: `full` (**all** built-ins — filesystem, shell, web, browser, memory, sub-agent, …) · `coding` (filesystem **+ shell**) · `readonly` (read-only filesystem) · `none`. See [Profile format](../agents/profile-format.md#tool-presets).

## Any MCP server

Verified: the agent gets the server's tools at startup.

```json
"mcp": {
  "everything": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-everything"]
  }
}
```

Both `stdio` and `url` transports are supported.

## Composio — 400+ SaaS apps

Requires `COMPOSIO_API_KEY` in the environment *before* the gateway starts (get one at composio.dev). Without the key, Composio stays disabled and declared toolkits are ignored.

```json
"composio": { "toolkits": ["github", "notion"] }
```

## Your own tool

A TypeScript file in the profile folder:

```ts title="profiles/my-agent/tools/my-tool.ts"
import { defineTool } from 'ownware'

export const codeReview = defineTool({
  name: 'code_review',
  description: 'Run a code review on a file',
  inputSchema: {
    type: 'object',
    properties: { file: { type: 'string', description: 'File to review' } },
    required: ['file'],
  },
  async execute(input) {
    return { content: 'Review complete', isError: false }
  },
})
```

```json
"custom": [{ "path": "tools/my-tool.ts" }]
```

## How it works

At assembly time the kernel merges all four sources into one tool list, then the engine's security layers apply to every call equally — policy filters, input guards, zone classification, and human-in-the-loop permissions. A connector tool gets no special trust. See [Thinking in Ownware § security](../getting-started/thinking-in-ownware.md#where-security-lives).

## Next steps

- [Profile format](../agents/profile-format.md) — where these blocks live in `agent.json`.
- [The run API](../gateway/run-api.md) — watch `tool.call.start`/`.end` events stream.
