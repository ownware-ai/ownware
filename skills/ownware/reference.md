# Ownware reference

Field-level detail for [SKILL.md](SKILL.md). Read the section you need. The canonical, always-current source is the repo's `docs/` — this file is a working subset. Doc index: https://github.com/ownware-ai/ownware/blob/main/docs/llms.txt

## Contents

- [agent.json fields](#agentjson-fields)
- [Models & keys](#models--keys)
- [The wire contract (run API)](#the-wire-contract-run-api)
- [A minimal client](#a-minimal-client)
- [Channels](#channels)
- [Schedules](#schedules)
- [Security & safety](#security--safety)
- [CLI command map](#cli-command-map)
- [Gotchas](#gotchas)

## agent.json fields

Only `name` is required; everything else defaults sensibly.

```jsonc
{
  "name": "my-agent",                    // required
  "description": "What this agent does",
  "model": "openai:gpt-5.5",             // provider:model; default shown
  "tools": {
    "preset": "full",                    // full | coding | readonly | none (starting tool set)
    "allow": ["readFile", "shell.*"],    // glob allowlist
    "deny": ["shell_execute"],           // glob denylist (wins over allow)
    "custom": [{ "path": "tools/my-tool.ts" }],  // your defineTool files
    "mcp": {                             // any MCP server (stdio or url) — agent gets its tools
      "everything": { "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] }
    },
    "composio": { "toolkits": ["github", "notion"] }  // 400+ SaaS apps (needs COMPOSIO_API_KEY)
  },
  "memory": { "enabled": true, "sources": ["AGENTS.md"] },
  "security": { "level": "standard", "permissionMode": "ask" },
  "context": { "git": true, "os": true, "cwd": true, "datetime": true, "project": true },
  "execution": { "mode": "foreground", "timeout": "30m" },
  "hooks": { /* lifecycle hooks: audit, notify, pause-for-approval — see docs/agents/hooks.md */ }
}
```

Full schema and every option: `docs/agents/profile-format.md`. Profile directory: `agent.json` (config) + `SOUL.md` (system prompt) + optional `AGENTS.md` (memory), `skills/`, `tools/`.

## Models & keys

- Model string is `provider:model`. Providers: `anthropic`, `openai`, `google`, `openrouter`, `ollama`.
- Examples: `openai:gpt-5.5` (the default), `anthropic:claude-sonnet-4-6`, `google:gemini-2.5-flash`, `openrouter:haiku-4.5`, `ollama:llama3.2` (keyless, local, free).
- Keys: `ownware key add <provider>` stores them encrypted in `~/.ownware/` (omit the value to be prompted with input hidden — inline values leak into shell history). `ownware key list` / `ownware key remove <provider>`. Env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`) also work.
- Discover what's usable right now: `GET /api/v1/models` reports `hasCredentials` (a key is set, or a local Ollama is reachable). `default: true` is flagged per provider, so pick the first *usable* model rather than `models.find(m => m.default)`.

## The wire contract (run API)

Everything a client does uses four HTTP calls. On a loopback bind, auth is off; when exposed, every request needs `Authorization: Bearer <token>` (the token is `ownware.token`, or the persisted `<dataDir>/gateway-token`).

| Call | Purpose |
|---|---|
| `POST /api/v1/run` | Start a run. Body `{profileId, prompt, model?, threadId?}` → `{threadId}`. Reuse `threadId` to continue a conversation. |
| `GET /api/v1/threads/{threadId}/agents/root/events?since=<seq>` | SSE stream of the run. `since` is a resume cursor — pass the last event's `seq` to skip replay. |
| `POST /api/v1/threads/{threadId}/resume` | Answer a permission prompt. Body `{action: "approve"｜"deny"}`. |
| `GET /api/v1/models` | List models with `hasCredentials`. |

**SSE event vocabulary** (each event has a `type` and a `seq`):

- `text.delta` — `{text}`, a chunk of the reply. Concatenate for the full answer.
- `tool.call.start` / `tool.call.end` — `{toolName}`; the agent is using a tool.
- `permission.request` — `{toolName}`; the agent needs approval. Reply via `POST /resume`.
- `turn.end` — `{usage: {costUsd}}` when available.
- `error` — `{code, message}`.
- `session.end` — the run is done; stop reading.

Alongside the engine events, the gateway wraps the stream in **envelope frames** (SSE `event:` names — treat any unknown one as a no-op):

- `stream.replay.complete` — back-buffered events are done; you're now live.
- `stream.shutdown` — the stream is closing; carries `reason` and `retryAfterMs`. `gateway_shutdown` = the gateway is restarting: reconnect after the delay, passing your highest `seq` as `?since=`. `slow_consumer` = this client fell behind: re-hydrate (below) and reopen SSE only if the thread is still running.

**Restoring history:** to open an existing thread (page reload, thread switch, after `slow_consumer`), call `GET /api/v1/threads/{threadId}/hydrate` — one round-trip returning the full conversation. Render from its `messages`; reopen SSE only if `runningAgentId != null` (pass `?since=lastClosedTurnEndSeq`). Never open SSE on a terminal thread (`runningAgentId: null`).

Full endpoint + event docs: `docs/gateway/run-api.md`. Machine-readable specs ship in the repo: `packages/client/spec/openapi.yaml` (REST) and `asyncapi.yaml` (SSE).

## A minimal client

Any frontend (React, mobile, backend) follows this shape — plain `fetch` + SSE, no SDK:

```js
// 0. auth headers. On the loopback default, auth is off — {} works. When auth is on
//    (any non-loopback bind), the token is `gateway.token` (in-process) or the
//    persisted `<dataDir>/gateway-token` file (default ~/.ownware/gateway-token).
const headers = { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }

// 1. pick a usable model
const models = await (await fetch(`${url}/api/v1/models`, { headers })).json()
const model = (models.filter(m => m.hasCredentials).find(m => m.default) ?? models.find(m => m.hasCredentials))?.id

// 2. start a run (keep threadId across turns for one conversation)
const { threadId } = await (await fetch(`${url}/api/v1/run`, {
  method: 'POST', headers, body: JSON.stringify({ profileId: 'assistant', prompt, model, ...(tid && { threadId: tid }) }),
})).json()

// 3. tail the SSE stream: read res.body, split on "\n\n", JSON.parse each `data:` line,
//    switch on event.type (text.delta → append; permission.request → POST /resume; session.end → stop)
```

In React, do steps 1–3 in an effect/handler and push `text.delta` chunks into state. The runnable reference is `examples/custom-client/chat.mjs` in the repo (~100 lines).

## Channels

Connect the agent to messaging platforms. Each is a client of the gateway; self-driving channels (Slack/Telegram/Discord) use outbound Socket-Mode connections — no public webhook.

```bash
ownware channel add <kind> --profile <id> [credentials…] [--line business|personal]
ownware channel list · remove <id> · approve <channel> <code> · start
```

| Channel | Credential flags |
|---|---|
| `slack` | `--bot-token xoxb-…` `--app-token xapp-…` |
| `telegram` | `--token <bot-token>` |
| `discord` | `--token <bot-token>` |
| `whatsapp` | `--access-token` `--phone-number-id` `--app-secret` `--verify-token` |
| `sms` | `--account-sid` `--auth-token` `--from` |

Policy flags: `--line business|personal` (shortcut), or fine control with `--dm open|pairing|allowlist` and `--group mention|all|off`. **Pairing:** unknown senders are held until `ownware channel approve <channel> <code>`. After `ownware channel add`, run `ownware serve` to boot the channel in-process. Details: `docs/channels/overview.md`.

## Schedules

Proactive runs ("message me every morning"). They live in a running gateway's DB, so `ownware serve` must be up.

```bash
ownware schedule add --profile <id> --name <name> --prompt "<text>" \
  (--daily HH:MM | --every <N>m|<N>h | --once <ISO>) [--deliver <channel>:<target>] [--tz <IANA>]
ownware schedule list · remove <id> · runs <id>
```

## Security & safety

- **Zones + combination rules, credential vault, permission gates** are core (never paywalled). The engine only ever holds opaque credential *handles*, never plaintext; secrets are never logged.
- `security.level`: `standard` (default) and stricter levels gate what the agent may do unattended. `permissionMode: "ask"` pauses on sensitive tools for approval (answered from web, terminal, or a messaging channel via `POST /resume`).
- **Bind safety (invariant):** loopback → plain HTTP, auth off; non-loopback → TLS forced + bearer auth required (`--no-tls` refused). The bearer token persists at `<dataDir>/gateway-token`.
- Data (threads, vault, memory) lives in `~/.ownware/` (override `OWNWARE_DATA_DIR`). See `docs/security/overview.md` and `docs/gateway/exposing.md`.

## CLI command map

| Area | Commands |
|---|---|
| Build agents | `ownware init` · `ownware profile new · list · show · set · open · remove` |
| Talk | `ownware run <profile> "<prompt>"` · `ownware <profile> "<prompt>"` |
| Serve | `ownware serve [-p 3011] [--host 127.0.0.1] [--profiles ./profiles] [--tls/--no-tls] [--no-channels]` |
| Keys | `ownware key add · list · remove` |
| Channels | `ownware channel add · list · remove · approve · start` |
| Schedules | `ownware schedule add · list · remove · runs` |
| Meta | `ownware help` · `ownware --version` |

Exit codes: `0` success, `1` error (stderr message), `130` Ctrl-C during a run. Full reference: `docs/reference/cli.md`.

## Gotchas

- **No answer?** No model configured / no key — see [Models & keys](#models--keys).
- **`curl` fails with TLS errors** on an exposed bind — you must use `https://` + `Authorization: Bearer <token>` once non-loopback.
- **Port 3011 default** for `ownware serve`; the library `serve.mjs` demo uses 4000. Match whatever the gateway printed at boot.
- **Schedules/channels error "no gateway"** — start `ownware serve` first; those verbs are clients of a running gateway.
- **Tests must never touch real `~/.ownware/`** — when writing tests against the gateway, pass a temp `profilesDir` AND `dataDir`.
