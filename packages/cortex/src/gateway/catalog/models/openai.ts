/**
 * OpenAI model catalog.
 *
 * Source of truth: live data fetched from GET https://api.openai.com/v1/models
 * on 2026-04-11. OpenAI's /v1/models endpoint returns every model the key has
 * access to (chat, embeddings, TTS, realtime, image gen, etc) — this catalog
 * hand-picks only the text-generation chat models users actually pick in a
 * profile.
 *
 * Excluded by design: -realtime, -audio, -tts, -transcribe, -search-preview,
 * dall-e, text-embedding, tts-, davinci, babbage variants.
 *
 * Pricing sources: OpenAI's public pricing page. Numbers for GPT-5.4 and
 * GPT-5 families are from OpenAI's public announcements and product pages
 * as of 2026-04. When pricing cannot be verified against an official source,
 * the field is `null` and the UI shows "—".
 *
 * Update policy: when OpenAI ships a new flagship, add it at the TOP and
 * flip the `default: true` flag. Keep the old one as `tier: 'legacy'`.
 */

import type { ModelInfo } from '../../types.js'

export const OPENAI_MODELS: readonly ModelInfo[] = [
  // ── GPT-5.5 family — current flagship (released Apr 23 2026, codename "Spud") ──
  //
  // Strongest agentic performance in OpenAI's lineup as of release —
  // OpenAI specifically tuned it for multi-tool orchestration ("moving
  // across tools until a task is finished"). No `mini`/`nano` variant
  // shipped at launch; use `gpt-5.4-mini` for cheap-fast workloads
  // (smallFastModel) until OpenAI ships a 5.5-mini.
  {
    id: 'openai:gpt-5.5',
    name: 'GPT-5.5',
    provider: 'openai',
    tier: 'flagship',
    description: 'OpenAI\'s newest flagship — best agentic performance, tuned for multi-tool orchestration.',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    costPer1kInput: null,
    costPer1kOutput: null,
    capabilities: ['vision', 'tools', 'streaming', 'structured', 'thinking'],
    aliases: ['gpt5.5', 'gpt-5.5', 'spud'],
    releaseDate: '2026-04-23',
    default: true,
  },
  {
    id: 'openai:gpt-5.5-pro',
    name: 'GPT-5.5 Pro',
    provider: 'openai',
    tier: 'flagship',
    description: 'GPT-5.5 with extra reasoning budget — for the hardest research and agentic tasks.',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    costPer1kInput: null,
    costPer1kOutput: null,
    capabilities: ['vision', 'tools', 'streaming', 'structured', 'thinking'],
    aliases: ['gpt5.5-pro', 'gpt-5.5-pro'],
    releaseDate: '2026-04-23',
  },

  // ── GPT-5.4 family — previous flagship (released Mar 2026) ───────────────
  {
    id: 'openai:gpt-5.4',
    name: 'GPT-5.4',
    provider: 'openai',
    tier: 'balanced',
    description: 'Previous flagship. Strong reasoning; superseded by 5.5 for agentic work.',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    costPer1kInput: null,
    costPer1kOutput: null,
    capabilities: ['vision', 'tools', 'streaming', 'structured'],
    aliases: ['gpt5.4', 'gpt-5.4'],
    releaseDate: '2026-03-05',
  },
  {
    id: 'openai:gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    provider: 'openai',
    tier: 'balanced',
    description: 'Smaller GPT-5.4 — balanced intelligence and cost for everyday use. Currently the cheapest 5.x option (no 5.5-mini exists yet).',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    costPer1kInput: null,
    costPer1kOutput: null,
    capabilities: ['vision', 'tools', 'streaming', 'structured'],
    aliases: ['gpt5.4-mini', 'gpt-5.4-mini'],
    releaseDate: '2026-03-17',
  },
  {
    id: 'openai:gpt-5.4-nano',
    name: 'GPT-5.4 Nano',
    provider: 'openai',
    tier: 'fast',
    description: 'Smallest and fastest GPT-5.4 — cheap, quick classification and extraction.',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    costPer1kInput: null,
    costPer1kOutput: null,
    capabilities: ['tools', 'streaming', 'structured'],
    aliases: ['gpt5.4-nano', 'gpt-5.4-nano'],
    releaseDate: '2026-03-17',
  },

  // ── GPT-5 family — still current (released Aug 2025) ─────────────────────
  {
    id: 'openai:gpt-5',
    name: 'GPT-5',
    provider: 'openai',
    tier: 'legacy',
    description: 'Previous flagship. Strong reasoning; still fully supported.',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    costPer1kInput: null,
    costPer1kOutput: null,
    capabilities: ['vision', 'tools', 'streaming', 'structured'],
    aliases: ['gpt5'],
    releaseDate: '2025-08-07',
  },
  {
    id: 'openai:gpt-5-mini',
    name: 'GPT-5 Mini',
    provider: 'openai',
    tier: 'legacy',
    description: 'Smaller GPT-5 — still cost-effective, superseded by 5.4 Mini.',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    costPer1kInput: null,
    costPer1kOutput: null,
    capabilities: ['vision', 'tools', 'streaming', 'structured'],
    aliases: ['gpt5-mini'],
    releaseDate: '2025-08-07',
  },

  // ── GPT-4.1 family — legacy but widely deployed ──────────────────────────
  {
    id: 'openai:gpt-4.1',
    name: 'GPT-4.1',
    provider: 'openai',
    tier: 'legacy',
    description: 'Previous-generation flagship. Solid all-rounder; superseded by GPT-5.',
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    costPer1kInput: 0.002,
    costPer1kOutput: 0.008,
    capabilities: ['vision', 'tools', 'streaming', 'structured'],
    aliases: ['gpt4.1', 'gpt-4.1'],
    releaseDate: '2025-04-14',
  },
  {
    id: 'openai:gpt-4.1-mini',
    name: 'GPT-4.1 Mini',
    provider: 'openai',
    tier: 'legacy',
    description: 'Cheap, fast 4.1 — good for lightweight agents when cost matters.',
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    costPer1kInput: 0.0004,
    costPer1kOutput: 0.0016,
    capabilities: ['vision', 'tools', 'streaming', 'structured'],
    aliases: ['gpt4.1-mini'],
    releaseDate: '2025-04-14',
  },
  {
    id: 'openai:gpt-4.1-nano',
    name: 'GPT-4.1 Nano',
    provider: 'openai',
    tier: 'legacy',
    description: 'Cheapest 4.1 — tight budgets, high-volume classification.',
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    costPer1kInput: 0.0001,
    costPer1kOutput: 0.0004,
    capabilities: ['tools', 'streaming', 'structured'],
    aliases: [],
    releaseDate: '2025-04-14',
  },

  // ── o-series reasoning models ────────────────────────────────────────────
  {
    id: 'openai:o3',
    name: 'o3',
    provider: 'openai',
    tier: 'legacy',
    description: 'Reasoning model tuned for math, science, and programming.',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    costPer1kInput: 0.002,
    costPer1kOutput: 0.008,
    capabilities: ['tools', 'streaming', 'structured', 'thinking'],
    aliases: ['o3'],
    releaseDate: '2025-04-16',
  },
  {
    id: 'openai:o4-mini',
    name: 'o4 Mini',
    provider: 'openai',
    tier: 'legacy',
    description: 'Smaller, faster reasoning model — great for agentic tasks that need chain-of-thought.',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    costPer1kInput: 0.0011,
    costPer1kOutput: 0.0044,
    capabilities: ['tools', 'streaming', 'structured', 'thinking'],
    aliases: ['o4-mini'],
    releaseDate: '2025-04-16',
  },

  // ── GPT-4o family — legacy but stable ────────────────────────────────────
  {
    id: 'openai:gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    tier: 'legacy',
    description: 'Multimodal GPT-4 with vision. Still supported; superseded for text by GPT-4.1.',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPer1kInput: 0.0025,
    costPer1kOutput: 0.01,
    capabilities: ['vision', 'tools', 'streaming', 'structured'],
    aliases: ['gpt4o', 'gpt-4o'],
    releaseDate: '2024-05-13',
  },
  {
    id: 'openai:gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openai',
    tier: 'legacy',
    description: 'Cheap, fast 4o. Superseded by 4.1 Mini.',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPer1kInput: 0.00015,
    costPer1kOutput: 0.0006,
    capabilities: ['vision', 'tools', 'streaming', 'structured'],
    aliases: ['gpt4o-mini'],
    releaseDate: '2024-07-18',
  },
] as const
