/**
 * Memory Injector
 *
 * Takes loaded memory entries and injects them into the PromptBuilder
 * at the memory slot. Memory content is wrapped in XML tags for
 * clear delineation in the system prompt.
 */

import type { PromptBuilder } from '../prompt/builder.js'
import type { MemoryEntry } from './types.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inject memory entries into the prompt builder at the memory slot.
 *
 * Each entry is wrapped in a `<memory-source>` XML tag with the source
 * path as an attribute. Multiple entries are combined into a single
 * memory fragment.
 *
 * @param builder - The prompt builder to inject into
 * @param entries - Loaded memory entries (already layered/deduplicated)
 */
export function injectMemory(
  builder: PromptBuilder,
  entries: MemoryEntry[],
): void {
  const nonEmpty = entries.filter(e => e.content.trim())
  if (nonEmpty.length === 0) return

  if (nonEmpty.length === 1) {
    // Single source — simple wrapper
    const entry = nonEmpty[0]!
    const content = [
      '# Memory',
      '',
      `<agent-memory source="${basename(entry.source.path)}">`,
      entry.content.trim(),
      '</agent-memory>',
    ].join('\n')

    builder.add('memory', content, {
      label: `memory:${basename(entry.source.path)}`,
      priority: 50,
      cacheControl: false,
    })
    return
  }

  // Multiple sources — wrap each in its own tag
  const sections = nonEmpty.map(entry => [
    `<memory-source name="${basename(entry.source.path)}">`,
    entry.content.trim(),
    '</memory-source>',
  ].join('\n'))

  const content = [
    '# Memory',
    '',
    ...sections,
  ].join('\n\n')

  builder.add('memory', content, {
    label: 'memory:layered',
    priority: 50,
    cacheControl: false,
  })
}

/**
 * Inject a raw string as memory content (e.g., correction history).
 *
 * @param builder - The prompt builder to inject into
 * @param content - Raw memory content
 * @param label - Label for debugging
 */
export function injectRawMemory(
  builder: PromptBuilder,
  content: string,
  label = 'raw-memory',
): void {
  if (!content.trim()) return

  builder.add('memory', content.trim(), {
    label,
    priority: 10, // lower priority than main memory
    cacheControl: false,
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function basename(filePath: string): string {
  const parts = filePath.split('/')
  return parts[parts.length - 1] ?? filePath
}
