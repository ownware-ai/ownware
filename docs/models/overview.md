---
title: Models
description: Keyless local models via Ollama, or any cloud provider with one env var — every model is a provider:model string.
type: concept
---

# Models

Ownware is provider-agnostic. A model is always one string — `provider:model` — set in the profile (`"model"` in `agent.json`), overridden per run (the `model` field on `POST /api/v1/run`), or picked automatically by the client from `GET /api/v1/models`.

**For AI agents:** keyless path = install Ollama, `ollama pull llama3.2`, use `"ollama:llama3.2"` — no env var needed (`OLLAMA_HOST` optional). Cloud paths = set exactly one of `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `OPENROUTER_API_KEY` in the environment before the gateway starts. `GET /api/v1/models` returns `[{id, hasCredentials, default?}]` — filter on `hasCredentials` to find what's usable right now.

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

`GET /api/v1/models` reports every known model with `hasCredentials` — true when a key is set or a local Ollama is reachable *right now*. `default: true` is flagged **per provider** (so several models carry it), so don't do `models.find(m => m.default)`. The reference client `chat.mjs` instead takes the first *usable* model (preferring one flagged `default`). Build your clients the same way and "no config" stays true.

Keys can also be saved through the gateway's credential vault instead of the environment; either way they live on **your** machine (`~/.ownware/`) and never leave it.

## Next steps

- [Profile format](../agents/profile-format.md) — where `"model"` lives.
- [The run API](../gateway/run-api.md) — per-run model override and `/models`.
