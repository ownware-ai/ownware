/**
 * Skill Registry
 *
 * Central registry for skill definitions. Skills are registered at
 * startup and can be looked up by name or listed.
 */

import type { SkillDefinition } from './types.js'

// ---------------------------------------------------------------------------
// SkillRegistry
// ---------------------------------------------------------------------------

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>()

  /**
   * Register a skill definition.
   * Duplicate names fail closed instead of silently replacing the body that
   * an assembled agent was shown.
   *
   * @param skill - The skill to register
   * @returns this for chaining
   */
  register(skill: SkillDefinition): this {
    if (this.skills.has(skill.name)) {
      throw new TypeError(`Duplicate skill name: "${skill.name}".`)
    }
    this.skills.set(skill.name, freezeSkill(skill))
    return this
  }

  /**
   * Register multiple skills at once.
   *
   * @param skills - Array of skills to register
   * @returns this for chaining
   */
  registerAll(skills: readonly SkillDefinition[]): this {
    const prepared = skills.map(freezeSkill)
    const names = new Set(this.skills.keys())
    for (const skill of prepared) {
      if (names.has(skill.name)) {
        throw new TypeError(`Duplicate skill name: "${skill.name}".`)
      }
      names.add(skill.name)
    }
    for (const skill of prepared) {
      this.skills.set(skill.name, skill)
    }
    return this
  }

  /**
   * Get a skill by name.
   *
   * @param name - Skill name
   * @returns The skill definition, or undefined if not found
   */
  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name)
  }

  /**
   * Check if a skill exists by name.
   */
  has(name: string): boolean {
    return this.skills.has(name)
  }

  /**
   * List all registered skills.
   *
   * @returns Array of all skill definitions
   */
  list(): SkillDefinition[] {
    return Array.from(this.skills.values())
  }

  /**
   * Get the number of registered skills.
   */
  get size(): number {
    return this.skills.size
  }

  /**
   * Remove a skill by name.
   *
   * @returns true if the skill was found and removed
   */
  remove(name: string): boolean {
    return this.skills.delete(name)
  }

  /** Remove all registered skills */
  clear(): void {
    this.skills.clear()
  }
}

function freezeSkill(skill: SkillDefinition): SkillDefinition {
  if (typeof skill.name !== 'string' || skill.name.length === 0) {
    throw new TypeError('Skill name must be a non-empty string.')
  }
  if (typeof skill.content !== 'string') {
    throw new TypeError(`Skill "${skill.name}" must have string content.`)
  }
  const trigger = skill.trigger instanceof RegExp
    ? new RegExp(skill.trigger.source, skill.trigger.flags)
    : skill.trigger
  return Object.freeze({
    ...skill,
    trigger,
    ...(skill.allowedTools === undefined
      ? {}
      : { allowedTools: Object.freeze([...skill.allowedTools]) }),
  })
}
