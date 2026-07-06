/**
 * Skills Fragment
 *
 * Creates a skills section for the system prompt that lists available
 * skills with their trigger conditions. This allows the model to
 * know which skills it can activate and when.
 */

import type { PromptFragment } from '../types.js'
import type { SkillDefinition } from '../../skills/types.js'

/**
 * Create a skills prompt fragment from available skill definitions.
 *
 * @param skills - Array of available skill definitions
 * @param label - Optional label for debugging
 * @returns A prompt fragment in the skills slot
 */
export function createSkillsFragment(
  skills: SkillDefinition[],
  label = 'available-skills',
): PromptFragment {
  if (skills.length === 0) {
    return {
      slot: 'skills',
      content: '',
      priority: 50,
      label,
      cacheControl: true,
    }
  }

  const skillDocs = skills.map(skill => formatSkillDoc(skill))

  const content = [
    '# Available Skills',
    '',
    'The following skills can be activated when user input matches their trigger:',
    '',
    ...skillDocs,
  ].join('\n')

  return {
    slot: 'skills',
    content,
    priority: 50,
    label,
    cacheControl: true, // skills are stable within a session
  }
}

/**
 * Format a single skill as human-readable documentation.
 */
function formatSkillDoc(skill: SkillDefinition): string {
  const trigger = skill.trigger instanceof RegExp
    ? `/${skill.trigger.source}/${skill.trigger.flags}`
    : skill.trigger

  const lines: string[] = [
    `- **${skill.name}**: ${skill.description}`,
    `  Trigger: \`${trigger}\``,
  ]

  if (skill.allowedTools && skill.allowedTools.length > 0) {
    lines.push(`  Tools: ${skill.allowedTools.join(', ')}`)
  }

  return lines.join('\n')
}
