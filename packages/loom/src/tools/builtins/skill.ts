/**
 * Built-in Skill Tool
 *
 * Lazy-loads a named skill from the active session's `SkillRegistry` and
 * returns its instructions as the tool result. The model then acts on
 * the skill's body in its next turn.
 *
 * Why a tool, not a system-prompt section: skills are workflow-scoped
 * instructions. Putting every skill into `SOUL.md` would inflate the
 * system prompt on every turn — paying for tokens you only need
 * occasionally. As a tool, the model invokes a skill by name when the
 * user actually wants that workflow, and only that skill's body enters
 * the conversation. Other skills stay on disk.
 *
 * The registry is captured by closure at session-build time. Cortex's
 * profile assembler discovers skills via `loadSkills()`, registers them,
 * and constructs the tool with the resulting registry. Loom owns the
 * dispatch mechanism; Cortex owns "which skills exist for this profile."
 */

import type { Tool } from '../types.js'
import { defineTool } from '../types.js'
import type { SkillRegistry } from '../../skills/registry.js'
import type { ReminderInjector } from '../../reminders/index.js'

export interface SkillToolOptions {
  /**
   * Optional reminder injector. When set, every successful skill invocation
   * fires a `hook.context` reminder pointing at the skill name (lightweight
   * trace for UIs that want to render "skill X is active"). The skill body
   * is delivered through the tool result, NOT the reminder — keeping the
   * model's primary input on a single channel.
   */
  readonly reminders?: ReminderInjector
}

/**
 * Build the `skill` builtin tool, bound to the supplied registry. The
 * returned tool is per-session: each profile gets its own registry +
 * its own tool instance. Loom's tool registry stores it like any other.
 */
export function createSkillTool(
  registry: SkillRegistry,
  opts: SkillToolOptions = {},
): Tool {
  const { reminders } = opts
  return defineTool({
    name: 'skill',
    description:
      'Invoke a named skill to load its workflow instructions into the conversation. ' +
      'The skill body comes back as the tool result; follow it in your next response. ' +
      'Use when the user requests a workflow that has a registered skill (e.g. "simplify the changes" → invoke the `simplify` skill). ' +
      'Available skill names are listed in your system prompt — only invoke skills that exist.',
    category: 'custom',
    isReadOnly: true,
    requiresPermission: false,
    uiDescriptor: {
      kind: 'external-action',
      summary: { verb: 'Invoked skill', primaryField: 'name' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The skill name to invoke. Must match one of the registered skills.',
        },
        args: {
          type: 'string',
          description:
            'Optional free-text arguments for the skill (file paths, parameters, focus area). ' +
            'Surfaces in the tool result so the skill body can act on them.',
        },
      },
      required: ['name'],
    },
    async execute(input, _context) {
      const { name, args } = input as { name: string; args?: string }

      const skill = registry.get(name)
      if (!skill) {
        const available = registry
          .list()
          .filter(s => s.active !== false)
          .map(s => s.name)
        const list = available.length > 0 ? available.join(', ') : '(none registered)'
        return {
          content: `Unknown skill: "${name}". Available skills: ${list}.`,
          isError: true,
        }
      }

      if (skill.active === false) {
        return {
          content: `Skill "${name}" is registered but currently disabled.`,
          isError: true,
        }
      }

      const body = skill.content.trim()
      const sections: string[] = [
        `# Skill activated: ${skill.name}`,
        '',
        body,
      ]
      const trimmedArgs = args?.trim() ?? ''
      if (trimmedArgs.length > 0) {
        sections.push('', '## Caller args', trimmedArgs)
      }

      reminders?.emit({
        type: 'hook.context',
        hookName: `skill:${skill.name}`,
        context: `Skill "${skill.name}" is active for this turn — ${skill.description}`,
      })

      return {
        content: sections.join('\n'),
        isError: false,
        metadata: {
          skillName: skill.name,
          skillDescription: skill.description,
          ...(skill.allowedTools ? { skillAllowedTools: [...skill.allowedTools] } : {}),
        },
      }
    },
  })
}
