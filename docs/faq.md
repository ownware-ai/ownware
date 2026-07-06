---
title: FAQ
description: Quick answers — is it really free, which package to install, keyless start, is my data safe, how to expose it, which model to pick.
type: concept
---

# FAQ

**Is Ownware really free?**
Yes — the whole kit (engine, gateway, channels, security) is [Apache-2.0](../LICENSE), free
for any use including commercial. You self-host it; there's no paid tier for the core.

**Which package do I install?**
`npm i -g ownware` for the CLI (`ownware init/run/serve`). To embed the backend in your own
app as a library, `npm i ownware` and import `OwnwareGateway`. Power users can depend on
`@ownware/loom` (just the engine) or `@ownware/cortex` (kernel + gateway) directly.

**Can I run it without any API key?**
Yes. Install [Ollama](https://ollama.com), `ollama pull llama3.2`, and point your profile
at `ollama:llama3.2`. Everything runs locally, free and private. Add a cloud key later with
`ownware key add anthropic` (or openai / google / openrouter) when you want a bigger model.

**Which model should I pick?**
Start keyless with Ollama to try it. For real work, a frontier cloud model (Anthropic,
OpenAI, Google) via `ownware key add` gives the best results. You can override per run with
`--model`, or per profile in `agent.json`. See [Models](models/overview.md).

**Is my data / are my keys safe?**
Keys live in an encrypted vault under `~/.ownware/` and never leave your machine — the
engine only ever sees opaque handles, and secrets never enter events, logs, or the database.
Nothing is sent to Ownware; there is no Ownware server. See [Security overview](security/overview.md).

**Where does my data live, and what happens on an upgrade?**
Everything is one SQLite database plus files under `~/.ownware/` (override with
`OWNWARE_DATA_DIR`) — threads, message history, the credential vault, channels. There is no
separate database to install or configure. **Migrations are automatic:** on first run the
database is created and set up; on every upgrade only the new schema changes run, silently.
You never run a migrate command. Before it changes an existing database, Ownware takes a
consistent snapshot to `~/.ownware/backups/` (keeping the last few) and **auto-restores if a
migration ever fails** — a half-migrated database never runs. And if you open your data with
an *older* Ownware than last wrote it, it refuses (safely, untouched) and tells you to update
rather than risk corruption. To reset everything, stop the gateway and delete `~/.ownware/`.
See [Troubleshooting → Data & reset](troubleshooting.md#data-migrations--backups).

**How do I put it on a real server / expose it safely?**
Run `ownware serve --host 0.0.0.0`. The moment the bind leaves localhost, auth **and** TLS
are forced on and an unsafe bind refuses to boot — so there's no accidentally-open
deployment. Put a reverse proxy or tunnel in front for a real domain. See
[Exposing the gateway](gateway/exposing.md).

**Can my agent live in Slack / Telegram / WhatsApp?**
Yes — `ownware channel add <kind> …` then `ownware serve` runs the channel in the same
process. Five adapters ship (Telegram, Slack, Discord, WhatsApp, SMS). See
[Channels](channels/overview.md).

**Can it message me on a schedule?**
Yes — `ownware schedule add … --daily 08:30 --deliver slack:#general` runs the agent on a
cadence and posts the result to a channel. Quiet days stay quiet; failures are reported.

**Does it work in the browser / from another language?**
The gateway is one HTTP+SSE contract. Use [`@ownware/client`](../packages/client) (zero-dep,
Node + browser), plain `fetch`, or generate a client from the
[OpenAPI/AsyncAPI spec](../packages/client/spec). See [The run API](gateway/run-api.md).

**Something's broken.**
See [Troubleshooting](troubleshooting.md), then [open an issue](https://github.com/ownware-ai/ownware/issues).
