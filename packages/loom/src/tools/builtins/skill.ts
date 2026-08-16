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

import type { Tool, ToolResult } from '../types.js'
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
  /**
   * Host-owned, content-free identity for the exact frozen skill catalogue.
   * Omit when the host cannot bind catalogue identity authoritatively; the
   * dispatcher still works, but emits no activation evidence.
   */
  readonly activationEvidence?: SkillActivationEvidenceCatalog
}

export interface SkillActivationEvidenceCatalog {
  readonly sourceRef: string
  readonly sourceDigest: string
  readonly skills: readonly {
    readonly name: string
    readonly digest: string
  }[]
}

export interface SkillActivationMark {
  readonly sourceRef: string
  readonly sourceDigest: string
  readonly skillName: string
  readonly skillDigest: string
}

const activationMarks = new WeakMap<ToolResult, SkillActivationMark>()

/** Engine-internal one-use observation of the exact result created below. */
export function consumeSkillActivationMark(
  result: ToolResult,
): SkillActivationMark | null {
  const mark = activationMarks.get(result) ?? null
  if (mark !== null) activationMarks.delete(result)
  return mark
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
  // Freeze the dispatcher view at assembly. Registry mutation or a profile
  // file change during a run cannot silently change which body is activated.
  const skills = new Map(registry.list().map(skill => [skill.name, skill] as const))
  const activationEvidence = prepareActivationEvidence(
    opts.activationEvidence,
    [...skills.values()].filter(skill => skill.active !== false),
  )
  return defineTool({
    name: 'skill',
    egress: {
      contractRevision: 'ownware.tool-egress.v1',
      mediation: 'none',
    },
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

      const skill = skills.get(name)
      if (!skill) {
        const available = [...skills.values()]
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

      const result: ToolResult = {
        content: sections.join('\n'),
        isError: false,
        metadata: {
          skillName: skill.name,
          skillDescription: skill.description,
          ...(skill.allowedTools ? { skillAllowedTools: [...skill.allowedTools] } : {}),
        },
      }
      const digest = activationEvidence?.skills.get(skill.name)
      if (activationEvidence !== null && digest !== undefined) {
        activationMarks.set(result, Object.freeze({
          sourceRef: activationEvidence.sourceRef,
          sourceDigest: activationEvidence.sourceDigest,
          skillName: skill.name,
          skillDigest: digest,
        }))
      }
      return result
    },
  })
}

interface PreparedActivationEvidence {
  readonly sourceRef: string
  readonly sourceDigest: string
  readonly skills: ReadonlyMap<string, string>
}

function prepareActivationEvidence(
  evidence: SkillActivationEvidenceCatalog | undefined,
  activeSkills: readonly { readonly name: string }[],
): PreparedActivationEvidence | null {
  if (evidence === undefined) return null
  validateBoundedIdentity(evidence.sourceRef, 'sourceRef')
  validateBoundedIdentity(evidence.sourceDigest, 'sourceDigest')
  const identities = new Map<string, string>()
  for (const entry of evidence.skills) {
    validateBoundedIdentity(entry.name, 'skill name')
    validateBoundedIdentity(entry.digest, 'skill digest')
    if (identities.has(entry.name)) {
      throw new TypeError(`Duplicate skill evidence name: "${entry.name}".`)
    }
    identities.set(entry.name, entry.digest)
  }
  if (
    identities.size !== activeSkills.length
    || activeSkills.some(skill => !identities.has(skill.name))
  ) {
    throw new TypeError('Skill activation evidence must cover the exact active catalogue.')
  }
  return Object.freeze({
    sourceRef: evidence.sourceRef,
    sourceDigest: evidence.sourceDigest,
    skills: identities,
  })
}

function validateBoundedIdentity(value: string, label: string): void {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 240
    || [...value].some(char => {
      const code = char.codePointAt(0) ?? 0
      return code < 0x20 || code === 0x7f
    })
  ) {
    throw new TypeError(`Skill activation ${label} is malformed.`)
  }
}
