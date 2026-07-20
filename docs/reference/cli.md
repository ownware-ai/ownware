---
title: The ownware CLI
description: Complete reference for the `ownware` command line — build a profile, talk to it in the terminal, serve it, and reach it on every channel, all from one tool.
type: reference
---

# The `ownware` CLI

One command does the whole arc: **build an agent → talk to it → put it everywhere.**
No glue scripts, no separate `serve.mjs`/`chat.mjs` — those are library demos, this is
the product surface.

```bash
ownware profile new sales        # build it   (a folder of text)
ownware run sales "hello"         # talk to it (right here, no server)
ownware channel add slack …       # reach it   (Slack, Telegram, …)
ownware serve                     # serve it   (gateway + channels, one process)
```

> **Where it comes from.** `npm i -g ownware` puts the `ownware` command on your `PATH`
> (the `ownware` package is a thin bin that runs the kernel's CLI in `@ownware/cortex`). From
> a source checkout, run the built entry directly (`node packages/cortex/dist/cli.js …`) or
> alias it: `alias ownware="node $PWD/packages/cortex/dist/cli.js"`. Check your install with
> `ownware --version`.

---

## Command map

| Area | Commands |
|---|---|
| **Build agents** | `ownware profile new · list · show · set · open · remove` (and `ownware init`) |
| **Talk** | `ownware run <profile> "<prompt>"` · `ownware <profile> "<prompt>"` |
| **Serve** | `ownware serve` |
| **Keys** | `ownware key add · list · remove` |
| **Channels** | `ownware channel add · list · remove · approve · handoff · delivery · start` |
| **Schedules** | `ownware schedule add · list · remove · runs` |
| **Help & version** | `ownware help` · `ownware --help` · `ownware version` · `ownware --version` |

---

## `ownware profile` — build & manage agents

A profile is a folder of text: `agent.json` (config) + `SOUL.md` (system prompt), plus
optional `AGENTS.md` (memory), `skills/`, and `tools/`. These verbs manage them. They
operate on **your `./profiles`**; the bundled marketplace profiles are read-only and are
never modified.

### `ownware profile new <name>`
Scaffold `./profiles/<name>/` with a starter `agent.json` + `SOUL.md`. Idempotent — it
**never overwrites** existing files (your edits are the point).

| Flag | Meaning |
|---|---|
| `--model <id>` | Set the model in `agent.json` (default `openai:gpt-5.5`). |
| `--description <text>` | Set the one-line description. |
| `--open` | Open the new folder in your file manager after creating it. |

```bash
ownware profile new sales --model openrouter:haiku-4.5 --open
```

`ownware init [name]` is a shorthand: `ownware init` → `profile new assistant`; `ownware init sales`
→ `profile new sales`.

### `ownware profile list`
List every discoverable profile (yours first, bundled marketplace as fallback), with tags
and a `(read-only)` marker for shipped ones. `ownware profiles` is an alias.

### `ownware profile show <name>`
Print a profile's model, path, and which files it has, plus the edit/run hints.

### `ownware profile set <name>`
Edit config fields from the CLI. Validates against the profile schema **before** writing,
and keeps `agent.json` minimal (no defaulted bloat).

| Flag | Meaning |
|---|---|
| `--model <id>` | Change the model. |
| `--description <text>` | Change the description. |

```bash
ownware profile set sales --model anthropic:claude-sonnet-4-6
```

Deeper edits (tools, security, memory, hooks) are best done in the file — `ownware profile
open <name>`.

### `ownware profile open <name>`
Open the profile's folder in your OS file manager.

### `ownware profile remove <name>`
Delete `./profiles/<name>`. Prompts for confirmation unless `--yes` is passed; in a
non-interactive shell (CI/pipe) it refuses rather than delete silently. Only your local
profiles can be removed — never the bundled marketplace.

---

## `ownware run` — talk to a profile in the terminal

Runs the profile **in-process** and streams the reply to your terminal. **No gateway
needed.** This is the local-chat path — you only need `ownware serve` when something *else*
(Slack, a web app) has to reach the agent.

```bash
ownware run <profile> [options] "<prompt>"
ownware <profile> "<prompt>"          # shorthand — the "run" is implied
```

> The shorthand yields to the reserved verbs: a profile literally named `serve`, `run`,
> `key`, `channel`, `schedule`, `init`, `profile`, `list`, `help`, or `version` isn't
> reachable via `ownware <profile>` — use the explicit `ownware run <profile>` for those.

| Option | Meaning |
|---|---|
| `-w, --workspace <path>` | Working directory for the agent (default: cwd). |
| `-v, --verbose` | Show all events (turns, permissions, compaction). |
| `--json` | Emit events as JSON lines (for scripting). |

```bash
ownware run sales "draft a follow-up to Acme about last week's demo"
ownware coder -w ./my-app "fix the failing auth test"
```

The model comes from the profile's `agent.json`. Provide its key with `ownware key add` (or an
env var); keyless local models work via Ollama.

---

## `ownware serve` — make it reachable

Boots the gateway over `./profiles` and stays up until Ctrl-C. On the loopback default it
also boots your stored channels **in-process**, so Slack/Telegram answer without a second
process.

| Flag | Meaning |
|---|---|
| `-p, --port <N>` | Port (default **3011**; `0` = OS-assigned). |
| `--host <H>` | Bind host (default `127.0.0.1`). |
| `--profiles <dir>` | Profiles directory (default `./profiles`). |
| `--data-dir <dir>` | Data directory (default `~/.ownware`). |
| `--tls` / `--no-tls` | Force TLS on/off. |
| `--no-channels` | Don't boot stored channels in-process. |

**Safety by default:** a loopback host serves plain HTTP with **auth off** (curl-able with
no flags). Any **non-loopback** host flips both — **TLS is forced and auth is required**
(`--no-tls` is refused); the bearer token persists at `<dataDir>/gateway-token`.

```bash
ownware serve                       # http://127.0.0.1:3011, auth off, channels on
ownware serve --host 0.0.0.0        # TLS + auth required (exposed bind)
```

---

## `ownware key` — the encrypted vault

Provider API keys, stored encrypted in `~/.ownware` (plaintext is never logged). A key saved
here is what `ownware serve` and `ownware run` boot with.

```bash
ownware key add <provider> [value]   # omit [value] → hidden prompt (recommended)
ownware key list
ownware key remove <provider>
```

Providers: `anthropic` · `openai` · `google` · `openrouter`. Omitting the value prompts
with input hidden (inline values leak into shell history). Adding a provider that already
exists rotates it in place.

---

## `ownware channel` — reach people where they talk

Connect the agent to messaging platforms. Each channel is a **client of the gateway** over
the public wire contract; self-driving channels (Slack/Telegram/Discord) use Socket-Mode
style outbound connections — **no public webhook needed**.

```bash
ownware channel add <kind> --profile <id> [credentials…] [--line business|personal]
ownware channel list
ownware channel remove <id>
ownware channel approve <channel> <code>     # pair an unknown sender
ownware channel handoff list [channel-id]    # active WhatsApp takeovers
ownware channel handoff accept <request-id>
ownware channel handoff resume <request-id>
ownware channel delivery list [channel-id]   # accepted/delivered/failed/unknown
ownware channel start [--gateway <url>] [--token <bearer>]
```

`--line business|personal` is a shortcut for the underlying access policy. For finer
control set it directly: `--dm open|pairing|allowlist` (how unknown DMs are handled) and
`--group mention|all|off` (whether the agent answers in group chats). `--id <custom-id>`
names the channel instance. WhatsApp `/human` takeover is enabled only with
`--handoff on-request`, and only when the operator has a real connected Business
app/provider inbox in which to answer.

**Credential flags per channel:**

| Channel | Flags |
|---|---|
| `slack` | `--bot-token xoxb-…` `--app-token xapp-…` |
| `telegram` | `--token <bot-token>` |
| `discord` | `--token <bot-token>` |
| `whatsapp` | `--access-token` `--phone-number-id` `--app-secret` `--verify-token` |
| `sms` | `--account-sid` `--auth-token` `--from` |

```bash
ownware channel add slack --profile sales --bot-token xoxb-… --app-token xapp-…
ownware serve      # boots the channel in-process — message the bot
```

For WhatsApp, the exact customer command `/human` creates a durable takeover
request. `accept` keeps the agent paused while the operator answers in the
connected WhatsApp Business app/provider inbox. `resume` returns only future
messages to automation; it never replays messages received during the handoff.
`delivery list` shows stable message IDs and effect states but never customer
text, credentials, headers, or full provider responses. There is deliberately
no generic retry command: an `unknown` send may already be customer-visible.

> **Pairing.** Unknown senders are held until approved — your agent doesn't talk to
> strangers by default. Approve with `ownware channel approve <channel> <code>`.

---

## `ownware schedule` — proactive runs

"It messages you every morning." Schedules live in a **running gateway's** DB, so these
verbs talk to it over HTTP — start one first with `ownware serve`.

```bash
ownware schedule add --profile <id> --name <name> --prompt "<text>" \
  (--daily HH:MM | --every <N>m|<N>h | --once <ISO>) \
  [--deliver <channel>:<target>] [--tz <IANA>]
ownware schedule list
ownware schedule remove <id>
ownware schedule runs <id>
```

| Flag | Meaning |
|---|---|
| `--daily HH:MM` | Every day at a 24h time. |
| `--every <N>m` / `<N>h` | Fixed interval (the `min` / `hr` suffixes also work, e.g. `--every 90min`). |
| `--once <ISO>` | A single future run. |
| `--deliver <channel>:<target>` | Push the result to a channel (`slack:#general`, `telegram:<chatId>`). |
| `--tz <IANA>` | Timezone (default: this machine's). |
| `--gateway <url>` / `--token <bearer>` | Target a non-default gateway. |

```bash
ownware schedule add --profile sales --name morning \
  --prompt "summarize new leads" --daily 08:30 --deliver slack:#sales
```

---

## The 60-second path

```bash
alias ownware="node $PWD/packages/cortex/dist/cli.js"   # source checkout only
ownware key add openrouter          # paste your key once (encrypted)
ownware profile new assistant       # build the agent
ownware run assistant "hello"       # talk to it — no server
ownware channel add slack --profile assistant --bot-token xoxb-… --app-token xapp-…
ownware serve                       # gateway + Slack, one process
```

## Environment variables

| Var | Effect |
|---|---|
| `OWNWARE_DATA_DIR` | Override the data dir (default `~/.ownware`). |
| `OWNWARE_HOST` | Default bind host for `ownware serve`. |
| `OWNWARE_GATEWAY_TOKEN` | Bearer token for `channel`/`schedule` when talking to a gateway. |
| `OWNWARE_CHANNELS_DIR` / `OWNWARE_CHANNEL_SECRET` | Channel store location / encryption secret. |

See the [configuration reference](./configuration.md) for the full list.

---

## `ownware version` — print the version

```bash
ownware version        # → ownware 0.1.0
ownware --version      # alias (also -V)
```

Use it to confirm which build is on your `PATH` (handy in bug reports).

## Exit codes

Every command returns a standard shell exit code, so you can wire `ownware` into scripts
and CI:

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Error — bad arguments, a profile that doesn't exist, a failed run, a boot/connection failure. The message is printed to stderr. |
| `130` | Interrupted — you pressed `Ctrl-C` (SIGINT) during `ownware run`. |
