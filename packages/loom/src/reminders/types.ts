/**
 * Reminder Types
 *
 * The Reminder subsystem lets the harness whisper context to the model
 * by injecting `<system-reminder>` tags onto the next outgoing user/tool
 * message. Reminders are NOT LoomEvents: events flow OUT to consumers
 * (TUI, UI clients, gateway); reminders flow IN to the model.
 *
 * Events fire from runtime sources (mode transitions, hooks, compaction,
 * budget thresholds, MCP edge cases). The injector renders them through
 * registered templates and returns text fragments to attach to the next
 * outgoing message.
 *
 * Generic by design: events carry typed payloads, never agent-domain
 * knowledge. A profile that exposes no filesystem tools never sees
 * `fs.modified`; a profile without MCP never sees `mcp.empty`. Profiles
 * suppress reminders by template id, never by event type — the same
 * event may have multiple templates with different suppression policies.
 */

// ---------------------------------------------------------------------------
// Event payload types
// ---------------------------------------------------------------------------

/**
 * Discriminated union of every reminder-emitting runtime signal. The
 * injector dispatches to templates by `type`; new event types are
 * added here, then a default template (if appropriate) is registered
 * in `defaults.ts`.
 */
export type ReminderEvent =
  | { readonly type: 'mode.entered'; readonly modeName: string }
  | { readonly type: 'mode.exited'; readonly modeName: string; readonly outcome: ModeExitOutcome }
  | { readonly type: 'hook.success'; readonly hookName: string; readonly output: string }
  | { readonly type: 'hook.blocked'; readonly hookName: string; readonly reason: string }
  | { readonly type: 'hook.context'; readonly hookName: string; readonly context: string }
  | { readonly type: 'compaction.done'; readonly preTokens: number; readonly postTokens: number }
  | { readonly type: 'budget.warn'; readonly used: number; readonly total: number; readonly currency: BudgetCurrency }
  | { readonly type: 'mcp.empty'; readonly server: string; readonly uri: string }
  | { readonly type: 'tool.denied'; readonly toolName: string; readonly reason: string }
  | { readonly type: 'fs.modified'; readonly path: string; readonly source: FsModifiedSource }
  | { readonly type: 'task.nudge' }
  | { readonly type: 'session.continued'; readonly newCwd: string }
  | { readonly type: 'skills.previously-invoked'; readonly skills: readonly string[] }

export type ReminderEventType = ReminderEvent['type']

export type ModeExitOutcome = 'approved' | 'rejected' | 'aborted'
export type BudgetCurrency = 'tokens' | 'usd'
export type FsModifiedSource = 'user' | 'linter' | 'external'

// ---------------------------------------------------------------------------
// Render context
// ---------------------------------------------------------------------------

/**
 * Render-time context passed to every template. Stays small on purpose
 * — adding fields here is a public-API change. Use the event payload
 * for anything event-specific.
 */
export interface ReminderRenderContext {
  readonly turnIndex: number
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

/**
 * A registered template. The render function receives the wide
 * `ReminderEvent`; the registry guarantees by construction that the
 * event passed in matches `eventType`. Authors should use
 * `defineTemplate` for type-safe narrowing.
 */
export interface ReminderTemplate {
  readonly id: string
  readonly eventType: ReminderEventType
  /** When true, profiles may silence this template by id. */
  readonly suppressible: boolean
  render(event: ReminderEvent, ctx: ReminderRenderContext): string
}

/**
 * A queued event waiting to be rendered into the next outgoing message.
 * `enqueuedAt` is a wall-clock timestamp, included for observability.
 */
export interface QueuedReminder {
  readonly event: ReminderEvent
  readonly enqueuedAt: number
}

// ---------------------------------------------------------------------------
// Type-safe template factory
// ---------------------------------------------------------------------------

/**
 * Type-safe builder for reminder templates.
 *
 * The author's `render` function receives the narrowed event variant
 * matching `eventType` — full discriminated-union narrowing, no manual
 * type guards. The runtime wraps it with an event-type check that
 * fails loudly if the registry ever feeds a mismatched event (which
 * would be a registry bug, but the assertion catches it cheaply).
 *
 * @example
 * ```ts
 * const tpl = defineTemplate({
 *   id: 'reminders.mode.entered',
 *   eventType: 'mode.entered',
 *   suppressible: false,
 *   render: (event) => `Mode active: ${event.modeName}.`,  // event narrowed
 * })
 * ```
 */
export function defineTemplate<T extends ReminderEventType>(
  spec: {
    readonly id: string
    readonly eventType: T
    readonly suppressible: boolean
    render(event: Extract<ReminderEvent, { type: T }>, ctx: ReminderRenderContext): string
  },
): ReminderTemplate {
  return {
    id: spec.id,
    eventType: spec.eventType,
    suppressible: spec.suppressible,
    render(event, ctx) {
      if (event.type !== spec.eventType) {
        throw new Error(
          `Reminder template "${spec.id}" cannot render event of type "${event.type}" — expected "${spec.eventType}".`,
        )
      }
      // Cast is sound: the runtime check above narrows `event.type` to T.
      // TypeScript can't narrow on a non-literal `spec.eventType`, hence the
      // explicit assertion.
      return spec.render(event as Extract<ReminderEvent, { type: T }>, ctx)
    },
  }
}
