/**
 * Subagent spec resolution.
 *
 * Takes a parent profile's subagent spec (inline or by-reference) + the
 * resolved helper profile (when referenced) + the parent's own assembled
 * tool-name set, and produces the exact `{ model, tools, systemPrompt,
 * maxTurns }` tuple the gateway hands to Loom's AgentSpawner.
 *
 * This is a pure function with no I/O — profile registry lookup happens
 * in the caller. That keeps it cheap to unit-test across every grant /
 * override combination without spinning up a gateway.
 *
 * Grant semantics (non-negotiable):
 *   - `grant.tools[]` names MUST exist in the parent's assembled tool
 *     set. If any do not, this throws at resolve time with a descriptive
 *     error — parameter-passing is explicit, and silent "tool not
 *     available" surprises at call time are unacceptable.
 *   - Grant composes with the child's existing allow list: effective
 *     allow = union(child-allow, grant.tools). If the child had no
 *     allow list and grant is non-empty, grant BECOMES the allow list
 *     (child is then restricted to only the granted tools). If both
 *     are empty, the child receives no restriction (pre-existing
 *     behaviour preserved).
 */

import type { SkillDefinition } from '@ownware/loom'
import type { LoadedProfile } from './loader.js'
import type { SubagentSpec } from './schema.js'
import { normalizeModelId } from '../gateway/catalog/models/index.js'

export interface ResolvedSubagentDef {
  readonly model?: string
  readonly tools?: readonly string[]
  readonly systemPrompt?: string
  readonly maxTurns?: number
  /**
   * Optional persistent reminder. Sourced from the helper profile's
   * `agent.json.criticalReminder`. Forwarded to Loom's spawner so the
   * spawned session injects it on every turn as a `<system-reminder>`.
   */
  readonly persistentReminder?: string
}

export interface ResolveSubagentInputs {
  /** The subagent declaration from the parent profile. */
  readonly spec: SubagentSpec
  /**
   * The helper profile `spec.profile` refers to, already loaded. Must
   * be provided when `spec.profile` is set and registered; `null` when
   * the subagent is inline-only (no `profile` field).
   */
  readonly refProfile: LoadedProfile | null
  /**
   * Names of every tool in the PARENT's assembled tool set. Used to
   * validate `grant.tools` references something the parent actually
   * owns. A ReadonlySet so the caller builds it once.
   */
  readonly parentToolNames: ReadonlySet<string>
  /**
   * The PARENT profile's loaded skills (from `LoadedProfile.skills`).
   * Used to validate and inline `grant.skills` — each granted name
   * must match a `SkillDefinition.name` in this list, and the matched
   * skill's full `content` is appended to the child's systemPrompt.
   * Empty array is fine (no parent skills = no grantable skills).
   */
  readonly parentSkills: readonly SkillDefinition[]
}

/**
 * Resolve a single subagent spec into a runtime def.
 *
 * Throws:
 *   - If `spec.profile` is set but `refProfile` is null (caller
 *     forgot to resolve, or the reference is unknown).
 *   - If `spec.grant.tools` names a tool the parent does not own.
 */
export function resolveSubagentDef(
  inputs: ResolveSubagentInputs,
): ResolvedSubagentDef {
  const { spec, refProfile, parentToolNames, parentSkills } = inputs

  if (spec.profile && !refProfile) {
    throw new Error(
      `Subagent "${spec.name}" references profile "${spec.profile}" ` +
        `which is not registered.`,
    )
  }

  // Identity + execution overrides — parent reference fields win over
  // the helper's disk config (lets the parent tighten model / prompt
  // for a specific usage without editing the helper).
  //
  // Canonicalize the model string. Subagent specs frequently use short
  // aliases (`haiku`, `sonnet`) in profile JSON; pass them to the provider
  // verbatim and the API returns 404. `normalizeModelId` resolves aliases
  // and provider-prefixed aliases to the full catalog id.
  const rawModel = spec.model ?? refProfile?.config.model
  const model = rawModel != null ? normalizeModelId(rawModel) : rawModel
  const baseSystemPrompt =
    spec.systemPrompt ??
    refProfile?.soulMd ??
    refProfile?.config.systemPrompt
  const maxTurns = refProfile?.config.maxTurns

  // Tool allow list — parent's inline override > helper's own allow.
  const parentAllow = spec.tools?.allow
  const helperAllow = refProfile?.config.tools.allow
  const baseAllow =
    parentAllow && parentAllow.length > 0
      ? parentAllow
      : helperAllow && helperAllow.length > 0
        ? helperAllow
        : undefined

  // Grant — validated against the parent's real tool set.
  const grantTools = spec.grant?.tools ?? []
  if (grantTools.length > 0) {
    const missing = grantTools.filter((t) => !parentToolNames.has(t))
    if (missing.length > 0) {
      throw new Error(
        `Subagent "${spec.name}" grants tool${missing.length === 1 ? '' : 's'} ` +
          `[${missing.map((m) => `"${m}"`).join(', ')}] ` +
          `but the parent does not own ${missing.length === 1 ? 'it' : 'them'}. ` +
          `Declare the tool${missing.length === 1 ? '' : 's'} on the parent profile ` +
          `(via tools.custom, tools.mcp, or a matching preset) before granting.`,
      )
    }
  }

  // Compose effective allow list. Order preserved, duplicates removed.
  let tools: readonly string[] | undefined
  if (baseAllow === undefined && grantTools.length === 0) {
    tools = undefined
  } else {
    const seen = new Set<string>()
    const combined: string[] = []
    for (const name of baseAllow ?? []) {
      if (!seen.has(name)) {
        seen.add(name)
        combined.push(name)
      }
    }
    for (const name of grantTools) {
      if (!seen.has(name)) {
        seen.add(name)
        combined.push(name)
      }
    }
    tools = combined
  }

  // Granted skills — validated against parentSkills by .name. Each
  // granted skill's full content is appended to the child's system
  // prompt so the spawned agent sees the playbook from turn 1.
  const grantSkills = spec.grant?.skills ?? []
  let systemPrompt = baseSystemPrompt
  if (grantSkills.length > 0) {
    const byName = new Map(parentSkills.map((s) => [s.name, s]))
    const missing = grantSkills.filter((name) => !byName.has(name))
    if (missing.length > 0) {
      throw new Error(
        `Subagent "${spec.name}" grants skill${missing.length === 1 ? '' : 's'} ` +
          `[${missing.map((m) => `"${m}"`).join(', ')}] ` +
          `but the parent does not own ${missing.length === 1 ? 'it' : 'them'}. ` +
          `Declare the skill${missing.length === 1 ? '' : 's'} on the parent profile ` +
          `(via skills.dirs) before granting.`,
      )
    }
    const sections: string[] = []
    for (const name of grantSkills) {
      const skill = byName.get(name)!
      sections.push(
        `## Granted Skill: /${skill.name}\n` +
          `\n` +
          `${skill.description}\n` +
          `\n` +
          `${skill.content.trim()}`,
      )
    }
    const block =
      `# Granted Skills\n` +
      `\n` +
      `The following playbooks were granted by the parent agent. Follow them when the task matches.\n` +
      `\n` +
      sections.join('\n\n')
    systemPrompt =
      baseSystemPrompt && baseSystemPrompt.length > 0
        ? `${baseSystemPrompt}\n\n${block}`
        : block
  }

  // Persistent reminder — sourced from the helper profile's
  // `criticalReminder`. The parent spec form does NOT currently carry
  // its own override (no need yet); if the helper has it, it's used.
  const persistentReminder = refProfile?.config.criticalReminder

  return { model, tools, systemPrompt, maxTurns, persistentReminder }
}
