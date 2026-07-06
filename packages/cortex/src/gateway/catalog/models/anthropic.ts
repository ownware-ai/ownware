/**
 * Anthropic model catalog.
 *
 * Source of truth: live data fetched from GET https://api.anthropic.com/v1/models
 * on 2026-04-11, cross-referenced with https://docs.anthropic.com/en/docs/about-claude/pricing
 * for token pricing.
 *
 * Update policy: when a new Claude model launches, add it at the TOP of the
 * array (newest first) and flip the `default: true` flag. Mark old models as
 * `tier: 'legacy'` when a newer family supersedes them; only set
 * `deprecated: true` when Anthropic officially deprecates the API endpoint.
 *
 * Pricing is per 1K tokens (input / output), in USD. Derived from per-1M
 * pricing divided by 1000.
 */

import type { ModelInfo } from '../../types.js'

export const ANTHROPIC_MODELS: readonly ModelInfo[] = [
  // ── Claude 4.6 family — flagship (released Feb 2026) ─────────────────────
  {
    id: 'anthropic:claude-opus-4-6',
    name: 'Claude Opus 4.6',
    provider: 'anthropic',
    tier: 'flagship',
    description: 'Most intelligent Claude — best for complex analysis, research, and long-horizon agent tasks.',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075,
    capabilities: ['vision', 'pdf', 'tools', 'thinking', 'streaming', 'cache', 'structured', 'code_exec', 'citations'],
    aliases: ['opus', 'claude-opus'],
    releaseDate: '2026-02-04',
  },
  {
    id: 'anthropic:claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    tier: 'balanced',
    description: 'Balanced intelligence and speed with a 1M context window — the everyday default for coding and agents.',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
    capabilities: ['vision', 'pdf', 'tools', 'thinking', 'streaming', 'cache', 'structured', 'code_exec', 'citations'],
    aliases: ['sonnet', 'claude-sonnet'],
    releaseDate: '2026-02-17',
    default: true,
  },
  {
    id: 'anthropic:claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    tier: 'fast',
    description: 'Fastest and cheapest Claude — great for high-volume classification, extraction, and quick agents.',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    costPer1kInput: 0.0008,
    costPer1kOutput: 0.004,
    capabilities: ['vision', 'pdf', 'tools', 'thinking', 'streaming', 'cache', 'structured', 'citations'],
    aliases: ['haiku', 'claude-haiku'],
    releaseDate: '2025-10-15',
  },

  // ── Claude 4.5 family — still current, preceded 4.6 ──────────────────────
  {
    id: 'anthropic:claude-opus-4-5-20251101',
    name: 'Claude Opus 4.5',
    provider: 'anthropic',
    tier: 'legacy',
    description: 'Previous flagship. Still supported — upgrade to Opus 4.6 for improved context management.',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075,
    capabilities: ['vision', 'pdf', 'tools', 'thinking', 'streaming', 'cache', 'structured', 'code_exec', 'citations'],
    aliases: [],
    releaseDate: '2025-11-24',
  },
  {
    id: 'anthropic:claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    tier: 'legacy',
    description: 'Previous balanced model. Upgrade to Sonnet 4.6 for the same price with better capabilities.',
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
    capabilities: ['vision', 'pdf', 'tools', 'thinking', 'streaming', 'cache', 'structured', 'code_exec', 'citations'],
    aliases: [],
    releaseDate: '2025-09-29',
  },

  // ── Claude 4 family — legacy ─────────────────────────────────────────────
  {
    id: 'anthropic:claude-opus-4-1-20250805',
    name: 'Claude Opus 4.1',
    provider: 'anthropic',
    tier: 'legacy',
    description: 'Legacy Opus release. Keep for pinned reproducibility only.',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075,
    capabilities: ['vision', 'pdf', 'tools', 'thinking', 'streaming', 'structured', 'citations'],
    aliases: [],
    releaseDate: '2025-08-05',
  },
  {
    id: 'anthropic:claude-opus-4-20250514',
    name: 'Claude Opus 4',
    provider: 'anthropic',
    tier: 'legacy',
    description: 'Legacy Opus release. Keep for pinned reproducibility only.',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075,
    capabilities: ['vision', 'pdf', 'tools', 'thinking', 'streaming', 'citations'],
    aliases: [],
    releaseDate: '2025-05-22',
  },
  {
    id: 'anthropic:claude-sonnet-4-20250514',
    name: 'Claude Sonnet 4',
    provider: 'anthropic',
    tier: 'legacy',
    description: 'Legacy Sonnet release. Keep for pinned reproducibility only.',
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
    capabilities: ['vision', 'pdf', 'tools', 'thinking', 'streaming', 'citations'],
    aliases: [],
    releaseDate: '2025-05-22',
  },

  // ── Claude 3 family — deeply legacy ──────────────────────────────────────
  {
    id: 'anthropic:claude-3-haiku-20240307',
    name: 'Claude Haiku 3',
    provider: 'anthropic',
    tier: 'legacy',
    description: 'Original Haiku. Superseded by Haiku 4.5 at the same price with a larger context window.',
    contextWindow: 200_000,
    maxOutputTokens: 4_096,
    costPer1kInput: 0.00025,
    costPer1kOutput: 0.00125,
    capabilities: ['vision', 'streaming'],
    aliases: [],
    releaseDate: '2024-03-07',
    deprecated: true,
  },
] as const
