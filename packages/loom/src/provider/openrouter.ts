/**
 * OpenRouter Provider Adapter
 *
 * OpenRouter exposes ~290 models (Anthropic, OpenAI, Google, Moonshot/Kimi,
 * DeepSeek, Z.AI/GLM, Meta, Mistral, xAI, …) behind a single OpenAI-compatible
 * endpoint. We reuse OpenAIProvider's translation/streaming logic verbatim and
 * only swap the baseURL + name + a short→full model ID translation step so
 * Cortex catalog IDs stay clean (`openrouter:kimi-k2.6`) while OpenRouter
 * still gets the vendor-prefixed form it expects (`moonshotai/kimi-k2.6`).
 *
 * Why translate: every other provider catalog uses a flat
 * `provider:model-name` shape (`anthropic:claude-sonnet-4-6`,
 * `openai:gpt-4o`). Mirroring that for OpenRouter avoids exposing the
 * `vendor/` prefix in profile configs, status bars, and analytics. The
 * translation table below maps Cortex's clean IDs to OpenRouter's wire
 * format. Unknown IDs pass through unchanged so escape-hatch users can
 * still pass any OpenRouter model string verbatim.
 *
 * Pricing: models.dev does not currently catalog OpenRouter, so
 * `getModelPricing` returns null and the loop falls back to Sonnet-tier
 * estimates with a one-time warn. Acceptable for dev/demo use; a future
 * sync script can fetch live pricing from OpenRouter's `/api/v1/models`.
 */

import { OpenAIProvider } from './openai.js'
import type { ModelPricing } from './pricing.js'
import { isKimiModel, wrapKimiToolCallStream } from './quirks/kimi.js'
import type { ProviderChunk, ProviderRequest } from './types.js'

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

/**
 * Cortex catalog ID → OpenRouter wire ID. Keep entries in sync with
 * `packages/cortex/src/gateway/catalog/models/openrouter.ts`. Add new
 * entries here when adding a model to the catalog.
 */
const MODEL_ID_MAP: Readonly<Record<string, string>> = {
  // Moonshot Kimi
  'kimi-k2.6': 'moonshotai/kimi-k2.6',
  'kimi-k2.5': 'moonshotai/kimi-k2.5',
  'kimi-k2': 'moonshotai/kimi-k2',
  // DeepSeek
  'deepseek-v3.2': 'deepseek/deepseek-v3.2',
  'deepseek-chat': 'deepseek/deepseek-chat',
  // Z.AI / Zhipu
  'glm-4.6': 'z-ai/glm-4.6',
  'glm-5': 'z-ai/glm-5',
  'glm-5.1': 'z-ai/glm-5.1',
  // Anthropic pass-throughs
  'opus-4.6': 'anthropic/claude-opus-4.6',
  'haiku-4.5': 'anthropic/claude-haiku-4.5',
}

function toOpenRouterModelId(cortexId: string): string {
  return MODEL_ID_MAP[cortexId] ?? cortexId
}

export class OpenRouterProvider extends OpenAIProvider {
  readonly name = 'openrouter'

  constructor(opts?: {
    apiKey?: string
    apiKeyProvider?: () => Promise<string>
  }) {
    super({
      // Underlying OpenAI SDK defaults to OPENAI_API_KEY when none is passed,
      // which is wrong for OpenRouter's endpoint. Fall back to the correct
      // env var explicitly so standalone (non-gateway) usage works.
      apiKey: opts?.apiKey ?? process.env.OPENROUTER_API_KEY,
      apiKeyProvider: opts?.apiKeyProvider,
      baseURL: OPENROUTER_BASE_URL,
    })
  }

  /**
   * Translate the model ID before delegating to the OpenAI streaming path.
   * Everything else (request shape, deltas, tool calls, reasoning capture,
   * usage accounting) is identical — OpenRouter speaks the same wire format.
   *
   * Moonshot Kimi K2.x is the exception: it emits tool calls as plain text
   * inside a tagged section rather than as structured `delta.tool_calls`.
   * We wrap the chunk stream with `wrapKimiToolCallStream`, which rewrites
   * the terminal `message_complete` content blocks so the agent loop sees a
   * normal `tool_use` block and `stopReason: "tool_use"`.
   */
  override async *stream(request: ProviderRequest): AsyncGenerator<ProviderChunk> {
    const remapped: ProviderRequest = {
      ...request,
      model: toOpenRouterModelId(request.model),
    }
    const baseStream = super.stream(remapped)
    if (isKimiModel(remapped.model)) {
      yield* wrapKimiToolCallStream(baseStream)
      return
    }
    yield* baseStream
  }

  /**
   * Opt into OpenRouter's `usage.cost` field. When set, the final usage
   * chunk includes the actual billed USD cost from the upstream provider
   * (DeepInfra, Together, Fireworks, etc.) — strictly more accurate than
   * any local pricing table since it reflects the exact route + any
   * upstream discounts. Loom's loop prefers this value when present.
   *
   * Docs: https://openrouter.ai/docs/use-cases/usage-accounting
   */
  protected override getProviderSpecificStreamParams(): Record<string, unknown> {
    return { usage: { include: true } }
  }

  /**
   * OpenRouter's catalog isn't in models.dev. Returning null forces the
   * loop's fallback path — but in practice the upstream `usage.cost` field
   * (enabled above) supplies an authoritative figure that bypasses local
   * pricing math entirely. Fallback only kicks in if OpenRouter omits cost
   * (e.g. on older API versions or pricing-disabled accounts).
   */
  override getModelPricing(_model: string): ModelPricing | null {
    return null
  }
}
