---
title: MCP
description: Loom is an MCP client — connect to any MCP server over stdio, SSE, HTTP, or WebSocket (with OAuth2 PKCE) and adopt its tools.
type: howto
---

# MCP (Model Context Protocol)

Loom is an MCP client. Connect to any MCP server over any transport and adopt its tools and resources.

```ts
import { MCPManager, adaptAllMCPTools, Loom, builtinTools } from '@ownware/loom'

const mcp = new MCPManager()

await mcp.addServer({
  name: 'github',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN! },
})

await mcp.addServer({
  name: 'linear',
  transport: 'sse',
  url: 'https://mcp.linear.app/sse',
})

const mcpTools = adaptAllMCPTools(mcp.getTools())  // getTools() is synchronous

await Loom.run('sonnet', 'Create an issue for the bug I just fixed', {
  tools: [...builtinTools, ...mcpTools],
})
```

## Transports

`stdio` (local processes), `sse`, `http`, `websocket`.

## Auth

For servers that need OAuth, Loom exposes the OAuth2 PKCE primitives (`startOAuthFlow` / `refreshTokens`) — works with Linear, Notion, Atlassian, and any RFC-7636 server. Drive that flow yourself, then add the server with the resulting token. (The higher-level per-provider OAuth *presets* live in `@ownware/cortex`, not in the loom `addServer` config — there is no `auth` field on the loom server config.)

## Resources

Resource tools (`createListResourcesTool`, `createReadResourceTool`) expose an MCP server's resources as read-only tools the agent can call.

## Security

MCP tools are wrapped and gated like any other. Match a policy against them with a glob (`mcp__github__*`) in a [guard](security.md#layer-1--input-guards), and MCP writes land in the `external` [zone](security.md#layer-2--zones) by default — so they ask before running.

## Next steps

- [Built-in tools](built-in-tools.md) and [Custom tools](custom-tools.md)
- [Security](security.md) — gating MCP tools
