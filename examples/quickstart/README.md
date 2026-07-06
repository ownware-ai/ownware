# Ownware quickstart — your own agent in three commands

```bash
ownware init                       # 1. build it  — a starter agent in ./profiles/assistant
ownware run assistant "hello"      # 2. talk to it — streamed in your terminal, no server
ownware serve                      # 3. serve it  — the whole backend, one process
```

That's the whole arc: **build → talk → serve.** No `serve.mjs`, no `chat.mjs`, no glue —
one command does each step. Full command list: [the `ownware` CLI reference](../../docs/reference/cli.md).

> **In this repo (before the npm publish):** run these as `bun run ownware …` — e.g.
> `bun run ownware init`. Once `ownware` is installed globally (`npm i -g ownware`), drop
> the prefix. Requires Node ≥ 22 and, from source, `bun install && bun run build` once.

**No API key?** Install [Ollama](https://ollama.com) and it answers fully local, free:

```bash
brew install ollama && ollama pull llama3.2                              # macOS
curl -fsSL https://ollama.com/install.sh | sh && ollama pull llama3.2    # Linux
```

Have a key? Save it once — encrypted, never exported again:

```bash
ownware key add anthropic          # or openai · google · openrouter
```

## What each command does

- **`ownware init`** scaffolds **`profiles/assistant/`** — the agent, as text. `SOUL.md`
  is its personality and rules; `agent.json` is what it can do (model, tools, security).
  Editing these files IS customizing your agent. (`ownware profile new <name>` for more.)
- **`ownware run`** assembles the profile and streams the reply straight to your terminal —
  in-process, no gateway. This is your local chat loop.
- **`ownware serve`** turns the profile folder into a live HTTP+SSE service on
  `http://localhost:3011` — runs, streaming, persistent threads, the credential vault,
  permission approvals, schedules, **and your channels in-process**. It prints a copy-paste
  curl that answers immediately.

## Connect your tools (copy-paste into `agent.json`'s `"tools"` block)

**Any MCP server** (stdio or url — the agent gets the server's tools at startup):

```json
"mcp": {
  "everything": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-everything"]
  }
}
```

**400+ SaaS apps via Composio** — requires `COMPOSIO_API_KEY` in the environment before you
serve (get one at composio.dev). Without the key, Composio stays disabled and declared
toolkits are ignored:

```json
"composio": { "toolkits": ["github", "notion"] }
```

**Your own tool** (a TypeScript file in the profile folder):

```json
"custom": [{ "path": "tools/my-tool.ts" }]
```

Restart `ownware serve` (or re-run `ownware run`) after editing — one line of config per
integration, no code changes.

## Make it yours

- Change the personality → edit `SOUL.md` (or `ownware profile open assistant`).
- Change the model → `ownware profile set assistant --model <m>` (any `provider:model`
  string, including `ollama:llama3.2` for fully local).
- Lock it down → `"tools": { "preset": "readonly" }` or a `"deny"` list in `agent.json`.
- Everything the gateway stores lives in `~/.ownware/` on **your** machine.

## Providers at a glance

| Provider | Key | Keyless? | Example model string |
|---|---|---|---|
| Ollama (local) | — (`OLLAMA_HOST` optional) | ✅ free, private | `ollama:llama3.2` |
| Anthropic | `ownware key add anthropic` | — | `anthropic:claude-sonnet-4-6` |
| OpenAI | `ownware key add openai` | — | `openai:gpt-5.5` |
| Google | `ownware key add google` | — | `google:gemini-2.5-flash` |
| OpenRouter (300+ models) | `ownware key add openrouter` | — | `openrouter:kimi-k2.7-code` |

## Housekeeping

- **Where your data lives:** `~/.ownware/` (threads, credentials vault, memory).
  Override with `OWNWARE_DATA_DIR`. Delete the folder to reset everything.
- **Stop the agent:** Ctrl-C on `ownware serve`. State persists — restart and your threads
  are still there.
- **Port taken?** `ownware serve --port 4000`.

## Go further

- [The `ownware` CLI reference](../../docs/reference/cli.md) — every command and flag.
- [Agents & profiles](../../docs/agents/overview.md) — the full profile format.
- [Channels](../../docs/channels/overview.md) — put the agent on Slack / Telegram / etc.
- [Exposing the gateway](../../docs/gateway/exposing.md) — run it safely beyond localhost.
- [Drive it from your own app](../custom-client/) — boot the gateway in-process and talk to it over the raw HTTP+SSE wire ([run API](../../docs/gateway/run-api.md)); the path a Slack bot, web widget, or mobile app takes.
