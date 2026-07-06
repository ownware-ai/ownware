/**
 * Prompt Builder Types
 *
 * Defines the structure for composable prompt fragments that get
 * assembled into a complete system prompt. Each fragment belongs
 * to a slot that determines its position in the final prompt.
 */

// ---------------------------------------------------------------------------
// Prompt slots (ordered by assembly position)
// ---------------------------------------------------------------------------

/**
 * Slots define the semantic section of the prompt a fragment belongs to.
 *
 * Assembly order is optimized for Anthropic prompt caching:
 *   STATIC (shared by all agents, cacheable):
 *     tools → behavior
 *   DYNAMIC (per-agent/per-session):
 *     identity → memory → context → skills → custom
 *
 * This ordering puts engine-level rules first so they form a shared
 * cache prefix across all Cortex profiles.
 */
export type PromptSlot =
  | 'tools'
  | 'behavior'
  | 'identity'
  | 'memory'
  | 'context'
  | 'skills'
  | 'custom'

/** Canonical ordering of slots for assembly */
export const SLOT_ORDER: readonly PromptSlot[] = [
  'tools',
  'behavior',
  'identity',
  'memory',
  'context',
  'skills',
  'custom',
] as const

// ---------------------------------------------------------------------------
// Fragment
// ---------------------------------------------------------------------------

/**
 * A single piece of prompt content assigned to a slot.
 * Multiple fragments can share a slot — they're sorted by priority
 * (higher first) and joined with double newlines.
 */
export interface PromptFragment {
  /** Which section of the prompt this fragment belongs to */
  readonly slot: PromptSlot
  /** The text content to include */
  readonly content: string
  /** Sort priority within the slot (higher = earlier). Default 0. */
  readonly priority: number
  /** Optional label for debugging / tracing */
  readonly label?: string
  /**
   * Whether this fragment should receive an Anthropic cache_control marker.
   * Stable fragments (identity, behavior) benefit from caching;
   * volatile fragments (context, memory) typically should not.
   */
  readonly cacheControl?: boolean
}

// ---------------------------------------------------------------------------
// Assembled prompt
// ---------------------------------------------------------------------------

/**
 * The fully assembled system prompt, ready to send to the model.
 * Includes character positions where cache breakpoints should be placed
 * so the provider serializer can insert cache_control markers.
 */
export interface AssembledPrompt {
  /** The complete system prompt text */
  readonly text: string
  /**
   * Character positions (offsets into `text`) where cache breakpoints
   * should be inserted. These correspond to boundaries between
   * cacheable and non-cacheable sections.
   */
  readonly cacheBreakpoints: readonly number[]
  /** Number of fragments that were assembled */
  readonly fragmentCount: number
}
