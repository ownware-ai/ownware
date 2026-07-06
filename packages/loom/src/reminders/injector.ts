/**
 * Reminder Injector
 *
 * Owns the per-session queue of pending reminder events. The runtime
 * pushes events via `emit()` as they happen (mode transitions, hooks,
 * compaction completions, etc.). Just before the next outgoing message
 * goes to the provider, the consumer calls `drain()` to render every
 * queued event into `<system-reminder>...</system-reminder>` text
 * fragments and attach them to the message.
 *
 * The injector itself does NOT know how to attach reminders to a
 * Message — that wiring lives in the loop integration layer (a
 * separate, reviewed step). Keeping the injector message-shape-agnostic
 * means the same module works regardless of how messages are
 * structured (string content, content-block array, multimodal).
 */

import type { ReminderEvent, ReminderRenderContext, QueuedReminder } from './types.js'
import type { ReminderRegistry } from './registry.js'

const REMINDER_TAG_OPEN = '<system-reminder>'
const REMINDER_TAG_CLOSE = '</system-reminder>'

export interface ReminderInjectorOptions {
  /**
   * Template ids to silence. Only `suppressible: true` templates are
   * eligible — non-suppressible templates ignore this list (they carry
   * load-bearing model instructions like "tool was denied, don't retry"
   * that the model must always see).
   *
   * Suppression is by template id, not by event type, so a profile can
   * silence a noisy default while still receiving other templates fired
   * by the same event.
   */
  readonly suppress?: readonly string[]
}

export class ReminderInjector {
  private readonly queue: QueuedReminder[] = []
  private readonly suppressed: ReadonlySet<string>

  constructor(
    private readonly registry: ReminderRegistry,
    options: ReminderInjectorOptions = {},
  ) {
    this.suppressed = new Set(options.suppress ?? [])
  }

  /**
   * Push an event onto the queue. Cheap and non-blocking — runtime
   * code emits freely; the templates only run on `drain()`.
   *
   * Order is preserved: events render in emission order, and within a
   * single event the templates render in registration order.
   */
  emit(event: ReminderEvent): void {
    this.queue.push({ event, enqueuedAt: Date.now() })
  }

  /**
   * Drain the queue and return the rendered reminder bodies, each
   * already wrapped in `<system-reminder>...</system-reminder>` tags
   * separated by a single newline. The caller appends them to the
   * next outgoing message.
   *
   * Suppression: templates flagged `suppressible: true` are skipped
   * when their id is in the injector's suppress set. Non-suppressible
   * templates always render.
   *
   * Empty bodies (whitespace-only after trim) are dropped — they would
   * become noise, and a deliberately empty render is a way for a
   * conditional template to opt out for a given event payload.
   */
  drain(ctx: ReminderRenderContext): readonly string[] {
    if (this.queue.length === 0) return []
    const out: string[] = []
    for (const item of this.queue) {
      for (const tpl of this.registry.templatesFor(item.event.type)) {
        if (tpl.suppressible && this.suppressed.has(tpl.id)) continue
        const body = tpl.render(item.event, ctx).trim()
        if (body.length === 0) continue
        out.push(`${REMINDER_TAG_OPEN}\n${body}\n${REMINDER_TAG_CLOSE}`)
      }
    }
    this.queue.length = 0
    return out
  }

  /** Inspect the queue without draining. Test/observability helper. */
  pending(): readonly QueuedReminder[] {
    return [...this.queue]
  }

  /**
   * Drop every queued event without rendering. Use when a turn is
   * aborted and the buffered context is no longer relevant.
   */
  clear(): void {
    this.queue.length = 0
  }

  /** Number of queued events. */
  get size(): number {
    return this.queue.length
  }

  /** Whether a given template id is in the suppress set. */
  isSuppressed(templateId: string): boolean {
    return this.suppressed.has(templateId)
  }
}
