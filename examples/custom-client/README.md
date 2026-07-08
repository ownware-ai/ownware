# Ownware custom client — drive the gateway from your own app

The [quickstart](../quickstart/) uses the `ownware` CLI. This example shows the layer
underneath it: **boot the gateway in your own Node process, then talk to it over the raw
HTTP+SSE wire contract** — the same path a Slack bot, a web widget, or your mobile app takes.

```bash
node serve.mjs      # boot OwnwareGateway over ./profiles on :4000 — this IS the deploy
node chat.mjs       # a ~100-line terminal client using only fetch + SSE
```

- **`serve.mjs`** embeds `OwnwareGateway` directly (instead of `ownware serve`) and writes
  `.ownware-connection.json` with the url + bearer token. Hosting it *is* the deploy.
- **`chat.mjs`** is the reference client: `GET /api/v1/models` → `POST /api/v1/run` → tail the
  SSE event stream → answer permission prompts via `POST /resume` → keep one thread. It uses
  nothing beyond the [run API](../../docs/gateway/run-api.md), so any language with HTTP + SSE
  can do the same.

> In your own project, install the library first (`npm i ownware`). In this repo, run
> these after `bun install && bun run build` (the examples resolve the workspace packages).
> No API key? A running [Ollama](https://ollama.com) is picked up automatically.

**New here? Start with the CLI in [`../quickstart/`](../quickstart/) — it's the fast path.**
This example is for when you're integrating Ownware into your own application.
