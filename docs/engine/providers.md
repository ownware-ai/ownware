---
title: Providers
description: Loom ships Anthropic, OpenAI, Google, OpenRouter, and Ollama adapters — plus custom base URLs, your own provider, fallback chains, and pricing math.
type: reference
---

# Providers

Five providers are built in and auto-registered — **Anthropic, OpenAI, Google, OpenRouter, and Ollama** (local, keyless). A model is a `provider:model` string, or a short alias.

```ts
await Loom.run('anthropic:claude-sonnet-4-6', '...')
await Loom.run('openai:gpt-4o', '...')
await Loom.run('google:gemini-2.5-pro', '...')
await Loom.run('openrouter:...', '...')
await Loom.run('ollama:llama3.2', '...')   // local, no API key

// Short aliases
await Loom.run('sonnet', '...')
await Loom.run('opus', '...')
await Loom.run('haiku', '...')
```

Set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `OPENROUTER_API_KEY` in the environment for the cloud providers; Ollama needs no key (point `OLLAMA_HOST` at a non-default server if needed).

## Custom base URL / proxy

```ts
import { OpenAIProvider, registerProvider } from '@ownware/loom'

registerProvider(new OpenAIProvider({ baseURL: 'https://my-proxy.com/v1' }))
```

## Your own provider

Implement the `ProviderAdapter` interface — its core is `async *stream(request): AsyncGenerator<ProviderChunk>`, plus `name`, `countTokens`, `supportsFeature`, `formatTools`, and `getModelPricing` — and register it. It then works with **every** feature in the library (tools, security, compaction, streaming):

```ts
import { registerProvider } from '@ownware/loom'
registerProvider(new MyProvider())
```

## Fallback chain

Primary fails, secondary takes over mid-stream:

```ts
import { createFallbackProvider, AnthropicProvider, OpenAIProvider } from '@ownware/loom'

const provider = createFallbackProvider([
  new AnthropicProvider(),
  new OpenAIProvider(),
])
```

## Pricing & caching

Loom does the pricing math and prompt caching for you:

```ts
import { calculateCost, getModelPricing } from '@ownware/loom'

// getModelPricing(provider, model) → ModelPricing | null
// calculateCost(pricing, inputTokens, outputTokens, cacheReadTokens?, cacheCreationTokens?) → USD
const pricing = getModelPricing('anthropic', 'claude-sonnet-4-6')
const cost = pricing
  ? calculateCost(pricing, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens)
  : 0
```

Retry with jitter and provider fallback are built in — a transient provider error surfaces as a `recovery` event, not a crash.

## Next steps

- [Getting started](getting-started.md) — set a key and run.
- [Streaming events](streaming.md) — `cache.status` and `recovery` events.
