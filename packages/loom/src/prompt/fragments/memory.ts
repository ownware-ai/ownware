/**
 * Memory Fragment
 *
 * Creates the memory section of the system prompt from AGENTS.md content.
 * This provides the agent with persistent context about the project,
 * user preferences, and operational history.
 */

import type { PromptFragment } from '../types.js'

/**
 * Create a memory prompt fragment from AGENTS.md content.
 *
 * @param agentsMd - Raw content of the AGENTS.md file
 * @param label - Optional label for debugging
 * @returns A prompt fragment in the memory slot
 */
export function createMemoryFragment(
  agentsMd: string,
  label = 'agents.md',
): PromptFragment {
  if (!agentsMd.trim()) {
    return {
      slot: 'memory',
      content: '',
      priority: 50,
      label,
      cacheControl: false,
    }
  }

  const content = [
    '# Memory',
    '',
    '<agent-memory>',
    agentsMd.trim(),
    '</agent-memory>',
  ].join('\n')

  return {
    slot: 'memory',
    content,
    priority: 50,
    label,
    cacheControl: false, // memory is volatile — can change between turns
  }
}

/**
 * Create a memory fragment from multiple sources, layered in order.
 *
 * @param sources - Array of { label, content } pairs, later entries take precedence
 * @returns A prompt fragment in the memory slot
 */
export function createLayeredMemoryFragment(
  sources: Array<{ label: string; content: string }>,
): PromptFragment {
  const nonEmpty = sources.filter(s => s.content.trim())
  if (nonEmpty.length === 0) {
    return {
      slot: 'memory',
      content: '',
      priority: 50,
      label: 'layered-memory',
      cacheControl: false,
    }
  }

  const sections = nonEmpty.map(s =>
    `<memory-source name="${s.label}">\n${s.content.trim()}\n</memory-source>`,
  )

  const content = [
    '# Memory',
    '',
    ...sections,
  ].join('\n')

  return {
    slot: 'memory',
    content,
    priority: 50,
    label: 'layered-memory',
    cacheControl: false,
  }
}
