---
title: Troubleshooting
description: Fixes for the common failures — install/native deps, "the agent doesn't answer", TLS/port confusion, Ollama, and exposing the gateway.
type: howto
---

# Troubleshooting

The failures people actually hit, and the one-line fix for each. If your problem isn't
here, [open an issue](https://github.com/ownware-ai/ownware/issues) — a confusing error is
a bug.

## Install / native dependencies

**`npm i -g ownware` fails while building `better-sqlite3` or `node-pty`, or fetching ripgrep.**
Ownware compiles a couple of native modules at install time. A failure almost always means
your machine is missing platform build tools:

- **macOS:** `xcode-select --install`
- **Debian/Ubuntu:** `sudo apt-get install -y build-essential python3`
- **Windows:** install the "Desktop development with C++" workload (Visual Studio Build Tools).

Then reinstall. If your environment installs with `--ignore-scripts` (some CI/corp setups
do), the native fixups are skipped — run `npm rebuild better-sqlite3 node-pty` afterward.

**`ownware: command not found` after a global install.** Make sure npm's global bin is on
your `PATH` (`npm bin -g` prints it). From a source checkout the command isn't installed
globally — run `node packages/cortex/dist/cli.js …` or alias it. Confirm your install with
`ownware --version`.

## "It looks like it ran, but the agent never answers"

The most common cause: **no model is available.** A fresh profile defaults to
`anthropic:claude-sonnet-4-6`, which needs a key. The run starts (you get a `threadId`)
but produces no reply. Fix one of:

- Set a key: `ownware key add anthropic` (or `export ANTHROPIC_API_KEY=…`).
- Go keyless: point the profile at Ollama — `ownware profile set <profile> --model ollama:llama3.2` — and make sure Ollama is running.

Check what's usable right now: `curl http://localhost:3011/api/v1/models` and look for
`hasCredentials: true`.

## Ollama (keyless local)

- **"could not connect to ollama server"** — the Ollama daemon isn't running. Launch the
  Ollama app, or run `ollama serve` in another terminal, *before* `ollama pull` or a run.
- **Model not found** — pull it first: `ollama pull llama3.2`.
- **Ollama on another host/port** — set `OLLAMA_HOST=http://host:11434`.

## TLS / port confusion

- **`curl` to `http://localhost:…` hangs or returns an empty reply, or a cert error.** The
  gateway defaults to **TLS on**. For localhost, start it plain-HTTP: `ownware serve`
  (loopback default is fine), or in the library, `new OwnwareGateway({ …, tls: false })`.
  Never run plain HTTP beyond loopback.
- **Connection refused on the port from the docs.** `ownware serve` binds **3011** by
  default; the library `serve.mjs` examples use **4000**. Use whatever the gateway printed
  at boot. Override with `ownware serve --port <n>` or `OWNWARE_PORT=<n>`.

## Exposing the gateway

- **"refusing to bind … with auth/TLS disabled".** That's the bind-safety invariant doing
  its job: any non-loopback bind forces auth **and** TLS. Don't disable them — put a reverse
  proxy/tunnel in front, or bind `127.0.0.1` and tunnel. See [Exposing the gateway](gateway/exposing.md).
- **A client gets 401 after you exposed it.** Auth is now on. Send
  `Authorization: Bearer <token>` — the token is printed at boot and stored at
  `<dataDir>/gateway-token`.

## Channels

- **Adapter can't reach the gateway locally.** Its `fetch` rejects the self-signed cert —
  run the gateway with `OWNWARE_GATEWAY_TLS=0` for local testing, or terminate TLS at a proxy.
- **WhatsApp/SMS never receive messages.** They're webhook-based and need a public HTTPS URL
  pointing at the gateway (a tunnel like cloudflared works). Telegram/Slack/Discord don't.
- **Bot ignores an unknown DM.** That's fail-closed pairing — approve the sender with
  `ownware channel approve <channel> <code>`.

## Data, migrations & backups

Everything Ownware stores is one SQLite database plus files under `~/.ownware/`
(`OWNWARE_DATA_DIR` to override): threads, message history, the encrypted credential vault,
and channels. No separate database server to install or configure.

- **Migrations are automatic.** First run creates and sets up the database; each upgrade runs
  only the new schema changes, silently — you never run a migrate command. On a fresh install
  you'll see one line like `database initialized (48 migrations)`; that's normal, not an error.
- **Your data is snapshotted before every upgrade.** Before changing an existing database,
  Ownware writes a consistent backup to `~/.ownware/backups/` (keeping the last few) and
  **auto-restores if a migration fails** — a half-migrated database never runs.
- **"Your data was last used by a newer version of Ownware…"** means you opened your data with
  an *older* Ownware than last wrote it. Your data is safe and untouched — install the latest
  version to open it. (Ownware refuses to downgrade rather than risk corrupting your data.)
- **Database keeps growing?** Old raw event rows for finished threads can be pruned with
  `OWNWARE_EVENT_RETENTION_ENABLED=1` (your conversation history is never pruned). See the
  [configuration reference](reference/configuration.md).
- **Reset everything:** stop the gateway and delete `~/.ownware/`. Your provider keys live
  encrypted there — if you set `OWNWARE_MASTER_KEY`, keep a copy or you can't decrypt an old
  vault.

## See also

- [Installation](getting-started/installation.md) · [Quickstart](getting-started/quickstart.md)
- [Configuration reference](reference/configuration.md) — every env var and knob
- [FAQ](faq.md)
