/**
 * Google Gemini model catalog.
 *
 * Editorial policy only: stable IDs, labels, aliases, tiers and defaults.
 * Provider Hub supplies the active model facts and pricebook.
 *
 * Update policy: when Google ships a new Gemini family, add it at the TOP
 * and flip the `default: true` flag. Preview models get `tier: 'preview'`.
 * The UI shows a preview badge on those entries.
 */

import type { ModelInfo } from '../../types.js'

export const GOOGLE_MODELS: readonly ModelInfo[] = [
  // ── Gemini 3.x family — current flagship (preview as of Apr 2026) ────────
  {
    id: 'google:gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro',
    provider: 'google',
    tier: 'preview',
    description: 'Google\'s most advanced model — deep reasoning, agentic coding, massive context. Preview release.',
    capabilities: ['vision', 'pdf', 'tools', 'thinking', 'streaming', 'structured'],
    aliases: ['gemini-3-pro', 'gemini-pro-3'],
    releaseDate: '2026-03-18',
  },
  {
    id: 'google:gemini-3-flash-preview',
    name: 'Gemini 3 Flash',
    provider: 'google',
    tier: 'preview',
    description: 'Frontier performance at a fraction of the flagship cost. Preview release.',
    capabilities: ['vision', 'pdf', 'tools', 'streaming', 'structured'],
    aliases: ['gemini-3-flash'],
    releaseDate: '2026-02-20',
  },
  {
    id: 'google:gemini-3.1-flash-lite-preview',
    name: 'Gemini 3.1 Flash-Lite',
    provider: 'google',
    tier: 'preview',
    description: 'Cost-effective frontier performance — cheapest 3.x family option.',
    capabilities: ['vision', 'pdf', 'tools', 'streaming', 'structured'],
    aliases: ['gemini-3-flash-lite'],
    releaseDate: '2026-03-18',
  },

  // ── Gemini 2.5 family — stable production default ───────────────────────
  {
    id: 'google:gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'google',
    tier: 'flagship',
    description: 'Most advanced stable Gemini — deep reasoning, code, and huge 1M context window.',
    capabilities: ['vision', 'pdf', 'tools', 'thinking', 'streaming', 'structured'],
    aliases: ['gemini-pro', 'gemini-2.5-pro'],
    releaseDate: '2025-06-17',
  },
  {
    id: 'google:gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    provider: 'google',
    tier: 'balanced',
    description: 'Best price-performance for low-latency, high-volume work that still needs reasoning.',
    capabilities: ['vision', 'pdf', 'tools', 'streaming', 'structured'],
    aliases: ['gemini-flash', 'gemini-2.5-flash'],
    releaseDate: '2025-06-17',
    default: true,
  },
  {
    id: 'google:gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash-Lite',
    provider: 'google',
    tier: 'fast',
    description: 'Fastest, most budget-friendly multimodal Gemini 2.5 — great for high-throughput classification.',
    capabilities: ['vision', 'pdf', 'tools', 'streaming', 'structured'],
    aliases: ['gemini-flash-lite'],
    releaseDate: '2025-06-17',
  },

  // ── Gemini 2.0 family — legacy ───────────────────────────────────────────
  {
    id: 'google:gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    provider: 'google',
    tier: 'legacy',
    description: 'Previous-generation Flash — still supported, superseded by 2.5 Flash.',
    capabilities: ['vision', 'tools', 'streaming', 'structured'],
    aliases: [],
    releaseDate: '2025-02-05',
  },
] as const
