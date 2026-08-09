---
title: Models
description: Keyless local models via Ollama, or any cloud provider with one env var — every model is a provider:model string.
type: concept
---

# Models

Ownware is provider-agnostic. A model is always one string — `provider:model`.
For each run, configuration resolves as request override → saved thread model →
install default → profile default. Clients discover runnable choices through the
canonical Provider Hub.

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

If a profile default is unavailable but another runnable model exists, the
gateway may use that model and returns a `modelSubstitution` dispatch receipt.
It never silently replaces an explicit request, saved thread choice, or install
default; those fail honestly when unavailable. See [The run API](../gateway/run-api.md#start-a-run--post-apiv1run).

## How clients discover models

`GET /api/v1/provider-hub/models?scope=connected` is the one supported discovery flow. Read `items[].model`; prefer a row whose `availability.recommended` is true, then use the first connected row. Change the scope to `all`, `connectable`, `verified`, or `recommended` without switching catalogs. Prices and availability come from that same generation.

Provider/model metadata and token rates start with Ownware's bundled Models.dev snapshot and its validated last-known-good refresh. Ownware overlays only stable IDs, aliases and recommendations. A few historical Anthropic and local Ollama rows that Models.dev does not cover retain explicit context/output compatibility limits inside the Hub; their price stays unknown rather than being invented. Live connection state then joins from the local credential vault, environment keys, compatible endpoints, Ollama reachability and already-observed Codex subscription state. Merely listing models never starts Codex; its subscription catalog appears after an explicit Codex status/model request has observed it.

`GET /api/v1/models` is retained only for older clients. It is deprecated and projected from Provider Hub, so it cannot drift into a second source of model facts.

Keys can also be saved through the gateway's credential vault instead of the environment; either way they live on **your** machine (`~/.ownware/`) and never leave it.

## Verify one provider route

Operators can run live contract probes against one exact provider/model route
with the installed CLI:

```bash
ownware provider verify --help
```

Verification is deliberately off by default. The command accepts no arguments
and runs only when `OWNWARE_PROVIDER_VERIFY_LIVE=1` plus the required
`OWNWARE_PROVIDER_VERIFY_*` environment is present. In particular, provide:

- the adapter kind and exact runtime adapter ID;
- the wire model ID, Provider Hub route ID, and Provider Hub model ID;
- the catalog's `generation.id` from `GET /api/v1/provider-hub` (not the
  top-level composite `generationId` used for pagination);
- an explicit evidence output path; for the default data directory, use
  `$HOME/.ownware/provider-hub/verification-evidence.json`;
- `OWNWARE_PROVIDER_VERIFY_API_KEY` when the route needs a credential. A key is
  never accepted on the command line.

Run `ownware provider verify --help` for the complete environment and probe
list. This command currently supports bearer-authenticated and no-auth
OpenAI-compatible routes; header-specific compatible authentication is not in
its support envelope. Compatible routes also require their exact base URL and
may opt into usage reporting or only the features the endpoint is expected to support.
The command prints only content-addressed IDs, probe statuses, and skip reasons.
Its evidence file contains normalized request/stream facts—never the prompt,
response, endpoint, credential, or raw provider error.

Each record proves only the named probes for that exact route, model, runtime
adapter, protocol, catalog generation, harness version, and observation time.
Skipped or absent probes remain unverified. Provider Hub ignores evidence whose
runtime adapter or protocol does not match the catalog route. An invalid active
file or an incompatible evidence mode/harness is never overwritten. If a
running gateway had already loaded an older valid evidence bundle, restart it
after replacement before expecting the new bundle to appear in Hub reads.

## Next steps

- [Profile format](../agents/profile-format.md) — where `"model"` lives.
- [The run API](../gateway/run-api.md) — per-run model override and Provider Hub discovery.
