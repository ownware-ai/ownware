/**
 * Ollama Provider Adapter — keyless local models.
 *
 * Ollama serves an OpenAI-compatible endpoint at `<host>/v1` (chat
 * completions, streaming, tool calls), so we reuse OpenAIProvider's
 * translation/streaming logic verbatim and only swap the baseURL + name —
 * the same pattern OpenRouterProvider uses. No API key exists in Ollama;
 * the SDK requires a non-empty string, so a fixed placeholder is passed
 * and ignored by the server.
 *
 * Host resolution (first match wins):
 *   1. explicit `opts.host`
 *   2. `OLLAMA_HOST` env var — Ollama's own convention, which permits
 *      scheme-less `host:port` values; a missing scheme gets `http://`
 *   3. `http://localhost:11434` (Ollama's default bind)
 *
 * Pricing: local inference is free — `getModelPricing` returns explicit
 * zeros so the loop reports $0.0000 instead of warning and estimating
 * cloud-tier costs for a model that costs nothing.
 *
 * First-token latency: a cold model load can take tens of seconds on the
 * first request. The inherited stall guard (30s warn / 90s timeout) covers
 * typical local models; very large models can raise `stallTimeoutMs` per
 * request/profile.
 */

import { OpenAIProvider } from './openai.js'
import type { ModelPricing } from './pricing.js'

const DEFAULT_OLLAMA_HOST = 'http://localhost:11434'

/** Normalize a host value into a scheme-ful origin without a trailing slash. */
export function resolveOllamaHost(raw?: string): string {
  const value = (raw ?? process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST).trim()
  const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`
  return withScheme.replace(/\/+$/, '')
}

/**
 * Platform-tailored install one-liner for guidance messages. Every
 * "run keyless with Ollama" hint routes through this so the user gets
 * a command they can paste, not just a website to go read.
 */
export function ollamaInstallHint(): string {
  switch (process.platform) {
    case 'darwin':
      return "install Ollama: `brew install ollama` (or download from https://ollama.com), then `ollama pull llama3.2`"
    case 'linux':
      return "install Ollama: `curl -fsSL https://ollama.com/install.sh | sh`, then `ollama pull llama3.2`"
    default:
      return "install Ollama from https://ollama.com, then `ollama pull llama3.2`"
  }
}

const OLLAMA_FREE_PRICING: ModelPricing = {
  input: 0,
  output: 0,
  cacheRead: null,
  cacheWrite: null,
}

export class OllamaProvider extends OpenAIProvider {
  readonly name = 'ollama'

  /** Resolved origin (no `/v1` suffix) — exposed for reachability probes. */
  readonly host: string

  constructor(opts?: { host?: string }) {
    const host = resolveOllamaHost(opts?.host)
    super({
      // Ollama ignores auth; the OpenAI SDK just needs a non-empty key.
      apiKey: 'ollama',
      baseURL: `${host}/v1`,
    })
    this.host = host
  }

  /** Local inference is free — report explicit zeros, never estimate. */
  override getModelPricing(_model: string): ModelPricing | null {
    return OLLAMA_FREE_PRICING
  }
}

/**
 * Cheap reachability probe for provider auto-pick and friendly errors:
 * true iff an Ollama server answers on the resolved host within
 * `timeoutMs`. Never throws.
 */
export async function isOllamaReachable(
  host?: string,
  timeoutMs = 300,
): Promise<boolean> {
  try {
    const res = await fetch(`${resolveOllamaHost(host)}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}
