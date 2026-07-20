# @ownware/shuttle

**Your agent, answering where people already talk.** Messaging channel
adapters for [Ownware](https://github.com/ownware-ai/ownware): Slack,
Telegram, Discord, WhatsApp, SMS (Twilio).

Each channel is a thin *client* of the Ownware gateway wire contract —
receive a message → drive the agent over HTTP+SSE → deliver the reply
back. One agent, many identities, one thread per person.

## Fastest path: the `ownware` CLI

You usually don't install this package directly — the
[`ownware`](https://www.npmjs.com/package/ownware) CLI drives it:

```bash
ownware channel add slack --profile assistant --bot-token xoxb-… --app-token xapp-…
ownware channel start slack
ownware channel list | remove | approve       # manage channels + pair people
ownware channel handoff list                  # WhatsApp human-takeover requests
ownware channel delivery list                 # truthful WhatsApp effect states
```

## Or standalone

```bash
ownware-channel start --config channels.json
```

Or as a library:

```ts
import { TelegramAdapter } from '@ownware/shuttle/telegram'
```

Per-channel entry points: `@ownware/shuttle/slack`, `/telegram`,
`/discord`, `/whatsapp`, `/sms`, and `/channels` (the runner).

## Design rules

- **A channel adapter is a client, not a plugin.** It talks to the
  gateway over the same public wire contract (via `@ownware/client`) as
  any other consumer — no privileged access, no core imports.
- **Pairing before conversation.** Unknown senders are held until
  approved (`ownware channel approve`) — your agent doesn't talk to
  strangers by default.
- **One thread per person per channel** — conversation continuity is
  the adapter's job, not the user's.
- **Provider receipts stay truthful.** WhatsApp WAMIDs, thread bindings and
  outbound chunk attempts survive restart; accepted, delivered, failed and
  unknown are distinct states, and unknown sends are not blindly repeated.
- **Handoff is explicit.** `/human` creates a durable WhatsApp request; a local
  operator accepts/resumes it with `ownware channel handoff …` while answering
  through the connected Business app/provider inbox.

Part of the [Ownware](https://github.com/ownware-ai/ownware) monorepo
(`adapters/shuttle`). Apache-2.0.
