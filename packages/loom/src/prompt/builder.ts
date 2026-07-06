/**
 * Prompt Builder
 *
 * Assembles prompt fragments into a complete system prompt.
 * Fragments are grouped by slot (identity, memory, context, etc.)
 * and within each slot sorted by priority (higher first).
 *
 * Supports fluent API:
 *   const prompt = new PromptBuilder()
 *     .add('identity', soulContent)
 *     .add('context', envInfo)
 *     .add('behavior', rules, { priority: 10 })
 *     .build()
 */

import type { PromptFragment, PromptSlot, AssembledPrompt } from './types.js'
import { SLOT_ORDER } from './types.js'
import { computeCacheBreakpoints, isCacheable } from './cache.js'
import type { SystemPromptBlock } from '../core/system-prompt.js'

// ---------------------------------------------------------------------------
// Fragment options
// ---------------------------------------------------------------------------

export interface AddFragmentOptions {
  /** Sort priority within the slot (higher = earlier). Default 0. */
  priority?: number
  /** Optional label for debugging */
  label?: string
  /** Whether to mark this fragment for cache_control */
  cacheControl?: boolean
}

// ---------------------------------------------------------------------------
// PromptBuilder
// ---------------------------------------------------------------------------

export class PromptBuilder {
  private readonly fragments: Map<PromptSlot, PromptFragment[]> = new Map()

  /**
   * Add a fragment to the given slot.
   * Returns `this` for chaining.
   */
  add(slot: PromptSlot, content: string, opts?: AddFragmentOptions): this {
    if (!content.trim()) return this

    const fragment: PromptFragment = {
      slot,
      content: content.trim(),
      priority: opts?.priority ?? 0,
      label: opts?.label,
      cacheControl: opts?.cacheControl,
    }

    const existing = this.fragments.get(slot)
    if (existing) {
      existing.push(fragment)
    } else {
      this.fragments.set(slot, [fragment])
    }

    return this
  }

  /**
   * Add a pre-built PromptFragment directly.
   * Returns `this` for chaining.
   */
  addFragment(fragment: PromptFragment): this {
    if (!fragment.content.trim()) return this

    const existing = this.fragments.get(fragment.slot)
    if (existing) {
      existing.push(fragment)
    } else {
      this.fragments.set(fragment.slot, [fragment])
    }

    return this
  }

  /**
   * Remove all fragments from a slot.
   * Returns `this` for chaining.
   */
  remove(slot: PromptSlot): this {
    this.fragments.delete(slot)
    return this
  }

  /** Remove all fragments from all slots */
  clear(): this {
    this.fragments.clear()
    return this
  }

  /** Check whether any fragments exist for a slot */
  has(slot: PromptSlot): boolean {
    const frags = this.fragments.get(slot)
    return frags !== undefined && frags.length > 0
  }

  /** Get the number of fragments across all slots */
  get size(): number {
    let count = 0
    for (const frags of this.fragments.values()) {
      count += frags.length
    }
    return count
  }

  /**
   * Return all fragments in assembly order (slot order, then priority).
   * Does not modify internal state.
   */
  getOrderedFragments(): PromptFragment[] {
    const ordered: PromptFragment[] = []

    for (const slot of SLOT_ORDER) {
      const frags = this.fragments.get(slot)
      if (!frags || frags.length === 0) continue

      // Sort by priority descending (higher priority first), stable
      const sorted = [...frags].sort((a, b) => b.priority - a.priority)
      ordered.push(...sorted)
    }

    return ordered
  }

  /**
   * Assemble all fragments into a complete system prompt.
   *
   * Slots are emitted in canonical order. Within each slot, fragments
   * are sorted by priority (higher first) and separated by double newlines.
   * Slots are separated by double newlines as well.
   *
   * Cache breakpoints are computed for fragments that have cacheControl: true.
   */
  build(): AssembledPrompt {
    const ordered = this.getOrderedFragments()
    if (ordered.length === 0) {
      return { text: '', cacheBreakpoints: [], fragmentCount: 0 }
    }

    const breakpoints = computeCacheBreakpoints(ordered)

    // Group fragments by slot in order, join within slot, then join slots
    const slotTexts: string[] = []
    let currentSlot: PromptSlot | null = null
    let currentParts: string[] = []

    for (const frag of ordered) {
      if (frag.slot !== currentSlot) {
        if (currentParts.length > 0) {
          slotTexts.push(currentParts.join('\n\n'))
        }
        currentSlot = frag.slot
        currentParts = [frag.content]
      } else {
        currentParts.push(frag.content)
      }
    }

    // Flush last slot
    if (currentParts.length > 0) {
      slotTexts.push(currentParts.join('\n\n'))
    }

    const text = slotTexts.join('\n\n')

    return {
      text,
      cacheBreakpoints: breakpoints,
      fragmentCount: ordered.length,
    }
  }

  /**
   * Build and return just the text (convenience for when you don't need breakpoints).
   */
  buildText(): string {
    return this.build().text
  }

  /**
   * Assemble the prompt into cache-aware blocks.
   *
   * Walks fragments in the same order `build()` would produce, then groups
   * consecutive fragments with the same cacheability into a single block.
   * The result is ready to pass straight to Loom's `LoomConfig.systemPrompt`
   * in the block form — each block carries an explicit `cacheControl` flag
   * that the loop uses to decide whether to emit a cache marker.
   *
   * Why this exists alongside `buildText`:
   *   - `buildText` concatenates everything into one string. The provider
   *     layer then has no choice but to cache the whole string as one unit
   *     or not at all. Any volatile fragment inside invalidates the entire
   *     cache entry on every turn.
   *   - `buildBlocks` preserves the per-fragment `cacheControl` signal all
   *     the way to the wire, so the stable prefix (tools, identity, policy)
   *     caches independently from the volatile tail (date, cwd, memory).
   *
   * Empty builder → empty array (caller should treat as "no system prompt").
   */
  buildBlocks(): SystemPromptBlock[] {
    const ordered = this.getOrderedFragments()
    if (ordered.length === 0) return []

    // Render each fragment to text grouped by slot, exactly the way
    // `build()` does, so `buildBlocks()` output concatenated equals
    // `buildText()` output byte-for-byte. Tests pin this invariant.
    const rendered: Array<{ text: string; cacheable: boolean }> = []

    let currentSlot: PromptSlot | null = null
    let slotParts: string[] = []
    let slotFragments: PromptFragment[] = []
    const flushSlot = () => {
      if (slotParts.length === 0) return
      // All fragments in a slot share cacheability if they all classify the
      // same way. If a slot mixes cacheable and non-cacheable fragments
      // (rare — only via explicit per-fragment `cacheControl`), take the
      // most conservative: uncached. We cannot safely cache a slot where
      // some sub-fragment is marked volatile.
      const cacheable = slotFragments.every(f => isCacheable(f))
      rendered.push({ text: slotParts.join('\n\n'), cacheable })
      slotParts = []
      slotFragments = []
    }

    for (const frag of ordered) {
      if (frag.slot !== currentSlot) {
        flushSlot()
        currentSlot = frag.slot
      }
      slotParts.push(frag.content)
      slotFragments.push(frag)
    }
    flushSlot()

    // Coalesce consecutive blocks with the same cacheability. We want as
    // few blocks as possible so the 4-marker budget isn't wasted on runs
    // of single-fragment slots. Also: the joiner between coalesced groups
    // is `\n\n`, matching `build()`'s between-slot separator, so the final
    // concatenated text remains byte-identical to `buildText()`.
    const blocks: SystemPromptBlock[] = []
    let i = 0
    while (i < rendered.length) {
      const cacheable = rendered[i]!.cacheable
      let j = i
      while (j < rendered.length && rendered[j]!.cacheable === cacheable) j++
      const text = rendered.slice(i, j).map(r => r.text).join('\n\n')
      blocks.push({ text, cacheControl: cacheable })
      i = j
    }

    return blocks
  }
}
