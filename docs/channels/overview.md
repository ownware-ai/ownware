---
title: Channels
description: Shuttle carries your agent onto messaging platforms — Telegram, Slack, and more — as thin clients of the same wire contract.
type: concept
---

# Channels

A channel puts your agent where people already are — Telegram, Slack, SMS — without changing the agent at all. The channel layer is **Shuttle** (`adapters/shuttle`): each adapter is a thin client of the gateway wire contract that carries messages back and forth.

The product path is two commands:

```bash
ownware channel add slack --profile assistant --bot-token xoxb-… --app-token xapp-…
ownware serve    # boots the gateway AND the stored channels in one process
```

Tokens go into an encrypted store (`<dataDir>/channels`, AES-256-GCM), and `ownware serve` starts every stored channel in-process — one deployment, no second terminal (`--no-channels` opts out; on a TLS bind run `ownware channel start` separately). Unknown DMs are held behind fail-closed pairing until `ownware channel approve` lets them in.

**For AI agents:** channels live in `adapters/shuttle`. Each adapter: receive a platform message → `POST /api/v1/run` on the gateway → tail the SSE stream → deliver the reply to the source. Session keys map platform identities to gateway threads (one thread per person, continuous and isolated). Product path: `ownware channel add <kind> …` then `ownware serve` (in-process runner); standalone: `ownware channel start --gateway <url>` (token auto-read from `<dataDir>/gateway-token`). Dev harness: `CHANNEL=telegram TELEGRAM_BOT_TOKEN=… OWNWARE_PROFILE=<profile> node examples/run-channel.mjs` from `adapters/shuttle` (build first: `bun run build`) — the harness drives only the self-driving channels (telegram/slack/discord); WhatsApp/SMS are webhook-mounted and can't be exercised through it. The gateway must run with reachable TLS or `OWNWARE_GATEWAY_TLS=0` for plain local HTTP.

## When to use a channel

- People should reach the agent in a chat app instead of (or besides) your own UI.
- You want one agent with many identities — DM bot, group member — with one conversation thread per person.

## How it works

```
Telegram / Slack / …         Shuttle adapter                 Ownware gateway
────────────────────         ───────────────                 ────────────
 message in            →     session key (who+where)   →     POST /api/v1/run
                             thread map (key → thread)  ⇄     SSE events
 reply out             ←     delivery (chunking, gate)  ←     text.delta …
```

Three pieces make every channel behave well:

- **Session keys** — a stable key from platform identity (chat type, user, chat) maps to exactly one gateway thread, so every conversation is continuous and isolated without touching the engine.
- **Delivery policy** — how replies go out: streamed vs. complete, chunked to the platform's message limits.
- **Group behavior** — policies for when the agent should respond in group chats (e.g. only when @mentioned) rather than answering every message.

Because an adapter uses only the [run API](../gateway/run-api.md), writing a new channel doesn't require engine knowledge — it's a messaging-platform client plus the four HTTP calls.

## Available channels

Five adapters ship today:

| Channel | Transport | Public URL needed? |
|---|---|---|
| **Telegram** | long-polling | no |
| **Slack** | Socket Mode | no |
| **Discord** | gateway websocket | no |
| **WhatsApp** | webhook (Meta Cloud API) | yes |
| **SMS** | webhook (Twilio) | yes |

Add any of them with `ownware channel add <kind> …` (credential flags per channel are in the [CLI reference](../reference/cli.md)). Full setup checklists with exact tokens and scopes: [`adapters/shuttle/examples/README.md`](../../adapters/shuttle/examples/README.md).

**Slack in-docs (the most common one):** create a Slack app with **Socket Mode** on; you need a bot token (`xoxb-…`) and an app-level token (`xapp-…`); grant the bot scopes `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `channels:history`, and subscribe to the `message.im` / `app_mention` events. Then:

```bash
ownware channel add slack --profile assistant --bot-token xoxb-… --app-token xapp-…
ownware serve
```

**WhatsApp / SMS** are webhook-based, so the gateway must be reachable at a public HTTPS URL (a tunnel like cloudflared works) — see [Exposing the gateway](../gateway/exposing.md) and the per-channel checklist.

Fastest live test (~2 minutes) — Telegram:

```bash
# 1. Telegram → @BotFather → /newbot → copy the token
# 2. With a gateway running (see below):
cd adapters/shuttle && bun run build
CHANNEL=telegram TELEGRAM_BOT_TOKEN=123456:ABC… \
OWNWARE_PROFILE=assistant node examples/run-channel.mjs
# 3. DM your bot — it replies. Add it to a group and @mention it.
```

> **Note** — the gateway defaults to HTTPS with a self-signed certificate, which the adapter's `fetch` will reject locally. For local testing run the gateway with plain HTTP (`OWNWARE_GATEWAY_TLS=0`); for a real deploy, trust the certificate or terminate TLS at a proxy.

## Schedules deliver to channels

A schedule can push its result to a connected channel — "it messages you
every morning":

```bash
ownware schedule add --profile assistant --name morning \
  --prompt "summarize my inbox" --daily 08:30 --deliver slack:#general
```

The gateway runs the profile on the cadence; when the run finishes, the
in-process channel runner posts the agent's answer to the target. Delivery
is honest end-to-end: a quiet day sends nothing (`--deliver` respects the
schedule's delivery mode), a failed run tells you it failed, and a result
that *couldn't* be delivered is recorded as `failed-to-deliver` in
`ownware schedule runs <id>` — never a silent drop. Unattended runs default to
the `draft-approval` safety level ([Security overview](../security/overview.md)).

## Next steps

- [The run API](../gateway/run-api.md) — the contract every adapter is built on.
- [`adapters/shuttle/examples/README.md`](../../adapters/shuttle/examples/README.md) — per-channel setup checklists.
