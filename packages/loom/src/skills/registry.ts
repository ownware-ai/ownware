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
   * Overwrites any existing skill with the same name.
   *
   * @param skill - The skill to register
   * @returns this for chaining
   */
  register(skill: SkillDefinition): this {
    this.skills.set(skill.name, skill)
    return this
  }

  /**
   * Register multiple skills at once.
   *
   * @param skills - Array of skills to register
   * @returns this for chaining
   */
  registerAll(skills: readonly SkillDefinition[]): this {
    for (const skill of skills) {
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
