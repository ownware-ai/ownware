/**
 * Identity Fragment
 *
 * Creates the identity section of the system prompt from SOUL.md content.
 * This defines who the agent is — its name, role, and core personality.
 *
 * SOUL.md is the profile-specific "personality" of the agent. It should
 * contain domain rules, communication style, and working principles —
 * NOT tool usage rules (those go in the tools fragment) or safety rules
 * (those go in the behavior fragment).
 */

import type { PromptFragment } from '../types.js'

/**
 * Create an identity prompt fragment from SOUL.md content.
 * Returns a fragment with empty content if soulMd is empty/null,
 * which the builder will skip during assembly.
 *
 * @param soulMd - Raw content of the SOUL.md file (null = no SOUL.md found)
 * @param label - Optional label for debugging
 * @returns A prompt fragment in the identity slot
 */
export function createIdentityFragment(
  soulMd: string | null,
  label = 'soul.md',
): PromptFragment {
  if (!soulMd?.trim()) {
    return {
      slot: 'identity',
      content: '',
      priority: 100,
      label,
      cacheControl: true,
    }
  }

  const content = [
    '# Identity',
    '',
    'The following defines your role, personality, and domain-specific rules:',
    '',
    soulMd.trim(),
  ].join('\n')

  return {
    slot: 'identity',
    content,
    priority: 100,
    label,
    cacheControl: true, // SOUL.md is stable per profile
  }
}
