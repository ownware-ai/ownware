# Live-testing the shuttles — setup checklist

Everything is unit + real-socket-integration tested (110 unit + 2 integration, all green). The last mile is a **live smoke** with real credentials. This is the checklist of what you need and the exact commands.

## 0. Prerequisites (once)

1. **A running ownware gateway with a profile + a model.** From the repo root:
   ```bash
   bun run build
   cd packages/cortex && OWNWARE_GATEWAY_TLS=0 bun run gateway     # plain HTTP on :3011
   ```
   - `OWNWARE_GATEWAY_TLS=0` matters: the gateway defaults to **HTTPS with a self-signed cert**, which the shuttle's `fetch` will reject. Plain HTTP is the clean local path. (For a remote/TLS deploy, trust the cert or terminate TLS at a proxy.)
   - The profile needs a model that can answer. Keyless local (Ollama) works if installed; otherwise add a key via the gateway's `/credentials` or an env key so `POST /run` returns tokens.
2. **Build the shuttle package:** `cd adapters/shuttle && bun run build`.

Then every channel below is: set env → `node examples/run-channel.mjs`.

## 1. Easiest to test — the self-driving channels (NO public URL needed)

These dial out (long-poll / WebSocket), so you can run them from your laptop behind NAT — no ngrok, no webhook.

### Telegram ⭐ (fastest — ~2 min)
**What you get me:** a bot token.
1. Open Telegram → message **@BotFather** → `/newbot` → follow prompts → copy the token (`123456:ABC…`).
2. Run:
   ```bash
   CHANNEL=telegram TELEGRAM_BOT_TOKEN=123456:ABC… \
   OWNWARE_PROFILE=ownware-research node examples/run-channel.mjs
   ```
3. DM your bot in Telegram → it should reply. Add it to a group and `@mention` it.

### Slack (Socket Mode — no app review, no public URL)
**What you get me:** a bot token (`xoxb-…`) + an app-level token (`xapp-…`).
1. api.slack.com/apps → Create App → **enable Socket Mode** (generates the `xapp-` token with `connections:write`).
2. OAuth & Permissions → bot scopes: `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `channels:history`. Install to workspace → copy the `xoxb-` token.
3. Event Subscriptions → subscribe to `app_mention` and `message.im`.
4. Run:
   ```bash
   CHANNEL=slack SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… \
   OWNWARE_PROFILE=ownware-research node examples/run-channel.mjs
   ```
5. `@mention` the bot in a channel, or DM it.

### Discord (gateway WS)
**What you get me:** a bot token + the **MESSAGE_CONTENT** intent enabled.
1. discord.com/developers → New Application → Bot → copy the token.
2. Bot → **enable the "Message Content Intent"** (privileged) — required to read message text.
3. OAuth2 → URL Generator → scopes `bot`, permissions `Send Messages` / `Read Message History` → invite the bot to your server.
4. Run:
   ```bash
   CHANNEL=discord DISCORD_BOT_TOKEN=… \
   OWNWARE_PROFILE=ownware-research node examples/run-channel.mjs
   ```
5. `@mention` the bot in a server channel, or DM it.

## 2. Webhook channels (need a public URL — ngrok/tunnel)

WhatsApp (Cloud API) and SMS (Twilio) receive inbound over an HTTP **webhook**, so they need a public endpoint. Locally: `ngrok http <port>` and point the platform's webhook at the tunnel. You mount `handleInbound` on your endpoint (see each channel's `index.ts` usage snippet). These are fully unit-tested; the live pass is mostly credential + tunnel setup.

- **WhatsApp:** a Meta app + WhatsApp Business number → `WA access token`, `phone_number_id`, `app_secret`, a `verify token`. Webhook GET verify → `wa.verifyChallenge(query, token)`; POST → `wa.handleInbound(body, { rawBody, signature })`.
- **SMS:** a Twilio account → `Account SID`, `Auth Token`, a Twilio number. Point the number's inbound webhook at your endpoint → `sms.handleInbound(formParams, { url, signature })`.

## 3. What to hand me (summary)

| Channel | You provide | Public URL? |
|---|---|---|
| **Telegram** ⭐ | bot token (@BotFather) | no |
| **Slack** | `xoxb-` + `xapp-` tokens | no (Socket Mode) |
| **Discord** | bot token + MESSAGE_CONTENT intent | no |
| WhatsApp | WA token + phone_number_id + app_secret + verify token | yes (ngrok) |
| SMS | Twilio SID + Auth Token + number | yes (ngrok) |

**Recommended first smoke: Telegram** (2 minutes, no URL). Then Slack. Both prove the whole spine (channel → gateway → agent → reply) end-to-end.
