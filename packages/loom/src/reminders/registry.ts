/**
 * Reminder Registry
 *
 * Holds the set of registered templates indexed by event type. Multiple
 * templates per event type are allowed (e.g. one verbose template for
 * debugging plus one terse default — profiles can suppress whichever
 * they don't want).
 *
 * Template ids are unique across the registry. Re-registering an id
 * throws; profile-side overrides should remove the existing template
 * first or pick a distinct id.
 */

import type { ReminderEventType, ReminderTemplate } from './types.js'

export class ReminderRegistry {
  private readonly byEventType = new Map<ReminderEventType, ReminderTemplate[]>()
  private readonly byId = new Map<string, ReminderTemplate>()

  /**
   * Register a template. Throws if the id is already taken — silent
   * overwrite would mask configuration bugs.
   */
  register(template: ReminderTemplate): this {
    if (this.byId.has(template.id)) {
      throw new Error(`Reminder template id collision: "${template.id}" is already registered.`)
    }
    const list = this.byEventType.get(template.eventType)
    if (list) {
      list.push(template)
    } else {
      this.byEventType.set(template.eventType, [template])
    }
    this.byId.set(template.id, template)
    return this
  }

  /**
   * Remove a template by id. No-op if not present. Returns the removed
   * template, or null when nothing was registered with that id.
   */
  unregister(id: string): ReminderTemplate | null {
    const existing = this.byId.get(id)
    if (!existing) return null
    this.byId.delete(id)
    const list = this.byEventType.get(existing.eventType)
    if (list) {
      const filtered = list.filter(t => t.id !== id)
      if (filtered.length === 0) {
        this.byEventType.delete(existing.eventType)
      } else {
        this.byEventType.set(existing.eventType, filtered)
      }
    }
    return existing
  }

  /**
   * Look up every template registered for an event type, in registration
   * order. Returns an empty array when no template handles the type —
   * the injector treats that as "drop the event silently."
   */
  templatesFor(eventType: ReminderEventType): readonly ReminderTemplate[] {
    return this.byEventType.get(eventType) ?? []
  }

  /** Whether a template with the given id is registered. */
  has(id: string): boolean {
    return this.byId.has(id)
  }

  /** Total registered templates across all event types. */
  get size(): number {
    return this.byId.size
  }

  /** Snapshot of all templates, in id-registration order. Test/debug helper. */
  all(): readonly ReminderTemplate[] {
    return [...this.byId.values()]
  }
}
