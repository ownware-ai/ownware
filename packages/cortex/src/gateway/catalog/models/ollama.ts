/**
 * Ollama model catalog — keyless local models.
 *
 * Unlike the cloud catalogs, this is NOT the set of models the user can
 * run — Ollama runs whatever the user has pulled. These entries are the
 * popular defaults the onboarding path recommends (`ollama pull <model>`),
 * so the picker has something honest to show for the keyless story. Any
 * pulled model works via the `ollama:<name>` string even if it isn't
 * listed here.
 *
 * Facts: no snapshot covers local models; context/output are the
 * published family numbers. Pricing is `null` (not zero) on purpose —
 * the catalog treats null as "no pricing to display", and the Loom
 * provider itself reports actual $0 cost at run time.
 *
 * `hasCredentials` for these entries is reachability, not a stored key —
 * the gateway includes `ollama` in its configured-provider set only when
 * a local server answers (see `server.ts` model-catalog wiring).
 */

import type { ModelInfo } from '../../types.js'

export const OLLAMA_MODELS: readonly ModelInfo[] = [
  {
    id: 'ollama:llama3.2',
    name: 'Llama 3.2 (local)',
    provider: 'ollama',
    tier: 'fast',
    description: 'Small, quick local model — the keyless first-run default. Free, private, runs on your machine.',
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    costPer1kInput: null,
    costPer1kOutput: null,
    capabilities: ['tools', 'streaming'],
    aliases: [],
    releaseDate: '2024-09-25',
    default: true,
  },
  {
    id: 'ollama:llama3.3',
    name: 'Llama 3.3 70B (local)',
    provider: 'ollama',
    tier: 'balanced',
    description: 'Strong general local model for machines with the memory for it. Free and private.',
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    costPer1kInput: null,
    costPer1kOutput: null,
    capabilities: ['tools', 'streaming'],
    aliases: [],
    releaseDate: '2024-12-06',
  },
  {
    id: 'ollama:qwen3',
    name: 'Qwen 3 (local)',
    provider: 'ollama',
    tier: 'balanced',
    description: 'Capable local all-rounder with solid tool calling.',
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    costPer1kInput: null,
    costPer1kOutput: null,
    capabilities: ['tools', 'streaming', 'thinking'],
    aliases: [],
    releaseDate: '2025-04-29',
  },
] as const
