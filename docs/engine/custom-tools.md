---
title: Custom tools
description: Give the agent your own logic with defineTool — the full Tool interface, streaming progress, and UI descriptors.
type: howto
---

# Custom tools

A tool is your own function the agent can call. Define one with `defineTool` and pass it into any call pattern.

```ts
import { defineTool } from '@ownware/loom'

export const getWeather = defineTool({
  name: 'get_weather',
  description: 'Get the current weather for a city',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
  async execute(input) {
    const res = await fetch(`https://api.example.com/weather?q=${input.city}`)
    const data = await res.json()
    return { content: `${data.temp}°C, ${data.desc}`, isError: false }
  },
})
```

Use it:

```ts
import { Loom } from '@ownware/loom'
await Loom.run('sonnet', 'What is the weather in Tokyo?', { tools: [getWeather] })
```

## The Tool contract

| Field | Purpose |
|---|---|
| `name` | The identifier the model calls (snake_case). |
| `description` | What it does — the model reads this to decide when to call it. |
| `inputSchema` | JSON Schema for the arguments (validated before `execute` runs). |
| `execute(input)` | Async function returning `{ content, isError }`. |

`execute` returns a result object: `content` is what the model sees; `isError: true` tells the loop the call failed (the model reads the reason and can adapt).

## Streaming progress

Long-running tools can emit progress the loop surfaces as `tool.call.progress` events (see [Streaming events](streaming.md)) — useful for a UI that shows what a slow tool is doing.

## Rendering in a UI

Each tool can declare an optional `uiDescriptor` — pure data (no React) describing how the call should render in a chat UI: a `kind` (`file-write`, `file-read`, `file-edit`, `shell`, `search`, `image`, `external-action`, `conversational`), a summary verb, an optional preview body, and an open target. Clients render it with a generic descriptor-driven renderer, so a new tool needs no client code.

```ts
defineTool({
  name: 'write_file',
  // ...
  uiDescriptor: {
    kind: 'file-write',
    summary: { verb: 'Wrote', primaryField: 'file_path' },
    preview: { contentField: 'content', format: 'code', truncateAtLines: 10 },
    openAction: { target: 'file-pane', pathField: 'file_path' },
  },
})
```

## Security applies equally

A custom tool gets no special trust. It flows through the same [input guards, zones, and permissions](security.md) as every built-in. If your tool touches the network or the filesystem outside the workspace, expect it to land in a higher zone and prompt for approval.

## Next steps

- [Hooks](hooks.md) — intercept every tool call.
- [Security](security.md) — constrain what tools accept and when they run.
- [Built-in tools](built-in-tools.md) — the kit you extend.
