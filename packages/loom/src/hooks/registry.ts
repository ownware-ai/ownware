/**
 * Hook Registry
 *
 * Stores hook bindings indexed by event. Hooks for the same event run
 * in registration order; first hook to return `continue: false` blocks
 * the chain.
 */

import type { HookEvent, HookSpec } from './types.js'

export class HookRegistry {
  private readonly byEvent = new Map<HookEvent, HookSpec[]>()

  /** Register a hook for a lifecycle event. Multiple hooks per event are allowed. */
  register(event: HookEvent, hook: HookSpec): this {
    const list = this.byEvent.get(event)
    if (list) {
      list.push(hook)
    } else {
      this.byEvent.set(event, [hook])
    }
    return this
  }

  /** Look up every hook bound to an event, in registration order. */
  for(event: HookEvent): readonly HookSpec[] {
    return this.byEvent.get(event) ?? []
  }

  /** Whether at least one hook is bound to the given event. */
  has(event: HookEvent): boolean {
    return (this.byEvent.get(event)?.length ?? 0) > 0
  }

  /** Total number of hooks across all events. */
  get size(): number {
    let count = 0
    for (const list of this.byEvent.values()) count += list.length
    return count
  }

  /** Drop every binding. */
  clear(): void {
    this.byEvent.clear()
  }
}
