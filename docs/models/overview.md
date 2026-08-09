---
title: Models
description: Keyless local models via Ollama, or any cloud provider with one env var — every model is a provider:model string.
type: concept
---

# Models

Ownware is provider-agnostic. A model is always one string — `provider:model` — set in the profile (`"model"` in `agent.json`), overridden per run (the `model` field on `POST /api/v1/run`), or picked automatically by the client from the canonical Provider Hub.

**For AI agents:** keyless path = install Ollama, `ollama pull llama3.2`, use `"ollama:llama3.2"` — no env var needed (`OLLAMA_HOST` optional). Cloud paths = set exactly one of `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `OPENROUTER_API_KEY` in the environment before the gateway starts. `GET /api/v1/provider-hub/models?scope=connected` returns one page of models backed by a current connection.

## Providers at a glance

| Provider | Env var | Keyless? | Example model string |
|---|---|---|---|
| Ollama (local) | — (`OLLAMA_HOST` optional) | ✅ free, private | `ollama:llama3.2` |
| Anthropic | `ANTHROPIC_API_KEY` | — | `anthropic:claude-sonnet-4-6` |
| OpenAI | `OPENAI_API_KEY` | — | `openai:gpt-5.5` |
| Google | `GOOGLE_API_KEY` | — | `google:gemini-2.5-flash` |
| OpenRouter (300+ models) | `OPENROUTER_API_KEY` | — | `openrouter:kimi-k2.7-code` |

## The keyless path (recommended first run)

```bash
brew install ollama && ollama pull llama3.2       # macOS
curl -fsSL https://ollama.com/install.sh | sh && ollama pull llama3.2   # Linux
```

Then use `"model": "ollama:llama3.2"` — fully local, free, private. The quickstart chat detects a running Ollama automatically.

## How clients discover models

`GET /api/v1/provider-hub/models?scope=connected` is the one supported discovery flow. Read `items[].model`; prefer a row whose `availability.recommended` is true, then use the first connected row. Change the scope to `all`, `connectable`, `verified`, or `recommended` without switching catalogs. Prices and availability come from that same generation.

Provider/model metadata and token rates start with Ownware's bundled Models.dev snapshot and its validated last-known-good refresh. Ownware overlays only stable IDs, aliases and recommendations. A few historical Anthropic and local Ollama rows that Models.dev does not cover retain explicit context/output compatibility limits inside the Hub; their price stays unknown rather than being invented. Live connection state then joins from the local credential vault, environment keys, compatible endpoints, Ollama reachability and already-observed Codex subscription state. Merely listing models never starts Codex; its subscription catalog appears after an explicit Codex status/model request has observed it.

`GET /api/v1/models` is retained only for older clients. It is deprecated and projected from Provider Hub, so it cannot drift into a second source of model facts.

Keys can also be saved through the gateway's credential vault instead of the environment; either way they live on **your** machine (`~/.ownware/`) and never leave it.

## Next steps

- [Profile format](../agents/profile-format.md) — where `"model"` lives.
- [The run API](../gateway/run-api.md) — per-run model override and Provider Hub discovery.
