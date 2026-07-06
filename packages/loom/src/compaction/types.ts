/**
 * Compaction Types
 */

import type { Message } from '../messages/types.js'

export type CompactionStrategy = 'summarize' | 'truncate' | 'sliding_window' | 'hierarchical' | 'snapshot'

export interface CompactionResult {
  readonly strategy: string
  readonly messages: Message[]
  readonly preTokenCount: number
  readonly postTokenCount: number
  readonly summaryUsage?: {
    readonly inputTokens: number
    readonly outputTokens: number
  }
}

export interface CompactionManager {
  compactIfNeeded(
    messages: Message[],
    systemPrompt: string,
    /**
     * Optional precomputed token count. When the caller (typically
     * `loop.ts`) has already computed the effective context size via
     * `getEffectiveContextUsage`, pass it through to avoid a redundant
     * `provider.countTokens` round-trip on Anthropic/Google.
     */
    currentTokens?: number,
  ): Promise<CompactionResult | null>
  forceCompact(messages: Message[], systemPrompt: string): Promise<CompactionResult | null>
}
