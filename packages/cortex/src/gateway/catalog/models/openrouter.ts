/**
 * OpenRouter model catalog.
 *
 * OpenRouter exposes ~290 models behind a single OpenAI-compatible endpoint;
 * we surface a curated subset here — the cheap-but-capable open-weights tier
 * (Kimi, DeepSeek, GLM) plus a couple of flagship pass-throughs (Opus, GPT)
 * for users who want one key, one balance, every model.
 *
 * Source of truth: https://openrouter.ai/models, prices verified Apr 2026.
 *
 * Update policy: when a new model lands on OpenRouter that's worth surfacing,
 * add it at the top of the family group (newest first). Mark older versions
 * `tier: 'legacy'` once a successor exists. Pricing is per 1K tokens (input /
 * output) in USD, derived from OpenRouter's per-1M pricing divided by 1000.
 *
 * Note: OpenRouter takes the underlying provider's price unchanged for paid
 * usage and adds a 5–5.5% fee on credit purchases. Numbers below are the
 * pre-fee model rate, matching how every other catalog entry reports cost.
 */

import type { ModelInfo } from '../../types.js'

export const OPENROUTER_MODELS: readonly ModelInfo[] = [
  // ── Moonshot Kimi family — open-weights flagship for coding ──────────────
  {
    id: 'openrouter:kimi-k2.7-code',
    orSlug: 'moonshotai/kimi-k2.7-code',
    name: 'Kimi K2.7 Code',
    provider: 'openrouter',
    tier: 'flagship',
    description: 'Moonshot\'s code-specialised K2.7 — tuned for agentic editing and SWE-Bench-style tasks.',
    contextWindow: 256_000,
    maxOutputTokens: 32_000,
    // Not yet in the OpenRouter snapshot — these are hand-typed fallbacks
    // (mirroring K2.6's published rate) until a sync surfaces real facts.
    costPer1kInput: 0.000684,
    costPer1kOutput: 0.00342,
    capabilities: ['tools', 'thinking', 'streaming'],
    aliases: ['kimi-code', 'kimi-k2.7', 'kimi-k2.7-code'],
    releaseDate: '2026-06-13',
  },
  {
    id: 'openrouter:kimi-k2.6',
    orSlug: 'moonshotai/kimi-k2.6',
    name: 'Kimi K2.6',
    provider: 'openrouter',
    tier: 'flagship',
    description: 'Moonshot\'s 256K-context coding flagship — near-Opus on SWE-Bench at ~7× lower cost.',
    contextWindow: 256_000,
    maxOutputTokens: 32_000,
    costPer1kInput: 0.000745,
    costPer1kOutput: 0.004655,
    capabilities: ['tools', 'thinking', 'streaming'],
    aliases: ['kimi', 'kimi-k2.6'],
    releaseDate: '2026-04-08',
    default: true,
  },
  {
    id: 'openrouter:kimi-k2.5',
    orSlug: 'moonshotai/kimi-k2.5',
    name: 'Kimi K2.5',
    provider: 'openrouter',
    tier: 'balanced',
    description: 'Cheaper Kimi tier — strong coding + reasoning at $0.60/$2.50 per million tokens.',
    contextWindow: 256_000,
    maxOutputTokens: 32_000,
    costPer1kInput: 0.0006,
    costPer1kOutput: 0.0025,
    capabilities: ['tools', 'thinking', 'streaming'],
    aliases: ['kimi-k2.5'],
    releaseDate: '2026-02-22',
  },
  {
    id: 'openrouter:kimi-k2',
    orSlug: 'moonshotai/kimi-k2',
    name: 'Kimi K2',
    provider: 'openrouter',
    tier: 'legacy',
    description: 'Original K2 — non-reasoning, fast and very cheap. Superseded by K2.5/K2.6.',
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
    costPer1kInput: 0.00057,
    costPer1kOutput: 0.0023,
    capabilities: ['tools', 'streaming'],
    aliases: ['kimi-k2'],
    releaseDate: '2025-07-11',
  },

  // ── DeepSeek family — cheapest serious reasoning ─────────────────────────
  // V4 specs verified against the OpenRouter API (openrouter.ai/api/v1/models):
  // context_length, top_provider.max_completion_tokens, and per-token pricing
  // (converted from $/token to $/1K). Re-verify when OpenRouter updates.
  {
    id: 'openrouter:deepseek-v4-pro',
    orSlug: 'deepseek/deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    provider: 'openrouter',
    tier: 'flagship',
    description: 'DeepSeek\'s newest reasoning flagship — 1M context, top-tier reasoning at open-weights pricing.',
    contextWindow: 1_048_576,
    maxOutputTokens: 384_000,
    costPer1kInput: 0.000435,
    costPer1kOutput: 0.00087,
    capabilities: ['tools', 'thinking', 'streaming'],
    aliases: ['deepseek-v4', 'deepseek-v4-pro'],
    releaseDate: '2026-06-01',
  },
  {
    id: 'openrouter:deepseek-v4-flash',
    orSlug: 'deepseek/deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    provider: 'openrouter',
    tier: 'fast',
    description: 'Fast, cheap V4 tier — 1M context, high-volume tool calls and lighter reasoning.',
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    costPer1kInput: 0.0000983,
    costPer1kOutput: 0.0001966,
    capabilities: ['tools', 'thinking', 'streaming'],
    aliases: ['deepseek-v4-flash'],
    releaseDate: '2026-06-01',
  },
  {
    id: 'openrouter:deepseek-v3.2',
    orSlug: 'deepseek/deepseek-v3.2',
    name: 'DeepSeek V3.2',
    provider: 'openrouter',
    tier: 'balanced',
    description: 'Deepest discount on serious reasoning — $0.27/$1.10 per million tokens.',
    contextWindow: 164_000,
    maxOutputTokens: 16_000,
    costPer1kInput: 0.00027,
    costPer1kOutput: 0.0011,
    capabilities: ['tools', 'thinking', 'streaming'],
    aliases: ['deepseek', 'deepseek-v3.2'],
    releaseDate: '2026-03-14',
  },
  {
    id: 'openrouter:deepseek-chat',
    orSlug: 'deepseek/deepseek-chat',
    name: 'DeepSeek Chat',
    provider: 'openrouter',
    tier: 'fast',
    description: 'Non-reasoning DeepSeek — fast, cheap, good for high-volume tool calls.',
    contextWindow: 64_000,
    maxOutputTokens: 8_000,
    costPer1kInput: 0.00014,
    costPer1kOutput: 0.00028,
    capabilities: ['tools', 'streaming'],
    aliases: ['deepseek-chat'],
    releaseDate: '2025-12-26',
  },

  // ── Z.AI / Zhipu GLM family — Chinese frontier coding tier ───────────────
  {
    id: 'openrouter:glm-5.1',
    orSlug: 'z-ai/glm-5.1',
    name: 'GLM-5.1',
    provider: 'openrouter',
    tier: 'flagship',
    description: 'Z.AI\'s newest flagship — 58.4 on SWE-Bench Pro, ~1/3 Sonnet 4.6\'s cost. Strong agentic + coding.',
    contextWindow: 203_000,
    maxOutputTokens: 32_000,
    costPer1kInput: 0.00105,
    costPer1kOutput: 0.0035,
    capabilities: ['tools', 'thinking', 'streaming', 'cache'],
    aliases: ['glm', 'glm-5.1'],
    releaseDate: '2026-04-07',
  },
  {
    id: 'openrouter:glm-5',
    orSlug: 'z-ai/glm-5',
    name: 'GLM-5',
    provider: 'openrouter',
    tier: 'balanced',
    description: 'Z.AI\'s 744B MoE base model (40B active). Use 5.1 instead — same family, stronger coding.',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    costPer1kInput: 0.0009,
    costPer1kOutput: 0.003,
    capabilities: ['tools', 'thinking', 'streaming', 'cache'],
    aliases: ['glm-5'],
    releaseDate: '2026-02-15',
  },
  {
    id: 'openrouter:glm-4.6',
    orSlug: 'z-ai/glm-4.6',
    name: 'GLM-4.6',
    provider: 'openrouter',
    tier: 'legacy',
    description: 'Z.AI\'s reasoning-capable mid-tier — superseded by GLM-5 family for new profiles.',
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    costPer1kInput: 0.0006,
    costPer1kOutput: 0.0022,
    capabilities: ['tools', 'thinking', 'streaming', 'cache'],
    aliases: ['glm-4.6'],
    releaseDate: '2026-01-31',
  },

  // ── xAI Grok family — agentic coding via OpenRouter ──────────────────────
  // Context/pricing come from the OpenRouter snapshot (x-ai/grok-build-0.1):
  // 256K context, $1/$2 per million in/out. Hand-typed numbers below are the
  // fallback the enrich merge requires — the snapshot reports
  // `max_output_tokens: null` for x-ai models, so that one is always ours.
  {
    id: 'openrouter:grok-build-0.1',
    orSlug: 'x-ai/grok-build-0.1',
    name: 'Grok Build 0.1',
    provider: 'openrouter',
    tier: 'flagship',
    description: 'xAI\'s agentic build model — 256K context, vision + reasoning, tuned for coding workflows.',
    contextWindow: 256_000,
    maxOutputTokens: 32_000,
    costPer1kInput: 0.001,
    costPer1kOutput: 0.002,
    capabilities: ['vision', 'tools', 'thinking', 'streaming', 'structured', 'cache'],
    aliases: ['grok-build', 'grok-build-0.1'],
    releaseDate: '2026-05-20',
  },

  // ── Pass-throughs — premium models routed via OpenRouter ─────────────────
  // Useful when a user has only one OpenRouter key and wants Opus/GPT access
  // without managing per-provider keys. Pricing matches the underlying
  // provider rate (OpenRouter passes through; the 5% fee lives on credit
  // top-ups, not per-call).
  {
    id: 'openrouter:opus-4.6',
    orSlug: 'anthropic/claude-opus-4.6',
    name: 'Claude Opus 4.6 (via OpenRouter)',
    provider: 'openrouter',
    tier: 'flagship',
    description: 'Anthropic\'s flagship via OpenRouter — for users with a single OpenRouter key.',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075,
    capabilities: ['vision', 'pdf', 'tools', 'thinking', 'streaming'],
    aliases: ['opus-or'],
    releaseDate: '2026-02-04',
  },
  {
    id: 'openrouter:haiku-4.5',
    orSlug: 'anthropic/claude-haiku-4.5',
    name: 'Claude Haiku 4.5 (via OpenRouter)',
    provider: 'openrouter',
    tier: 'fast',
    description: 'Cheapest Claude via OpenRouter. Useful for one-key setups.',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    costPer1kInput: 0.0008,
    costPer1kOutput: 0.004,
    capabilities: ['vision', 'pdf', 'tools', 'thinking', 'streaming'],
    aliases: ['haiku-or'],
    releaseDate: '2025-10-01',
  },
]
