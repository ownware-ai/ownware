/**
 * Default Reminder Templates
 *
 * Engine-shipped templates for the typed event union. Wording is
 * domain-neutral — these templates serve a coding agent, a legal
 * drafter, a trading research agent, and a security auditor without
 * change. Profiles that want different wording register their own
 * template (with a distinct id) or suppress the default and add a
 * replacement.
 *
 * Suppression policy:
 *   - Non-suppressible: load-bearing model instructions the agent
 *     must always see (mode entered/exited, hook blocked, tool denied).
 *   - Suppressible: informational nudges that profiles may silence
 *     (hook success, compaction done, budget warnings, …).
 */

import type { ReminderTemplate } from './types.js'
import { defineTemplate } from './types.js'
import { ReminderRegistry } from './registry.js'

// ---------------------------------------------------------------------------
// Mode lifecycle (non-suppressible — model must know which mode is active)
// ---------------------------------------------------------------------------

const modeEntered = defineTemplate({
  id: 'reminders.mode.entered',
  eventType: 'mode.entered',
  suppressible: false,
  render: (event) =>
    `Mode active: ${event.modeName}. Behavior overlays for this mode are now in effect; previous mode rules no longer apply.`,
})

const modeExited = defineTemplate({
  id: 'reminders.mode.exited',
  eventType: 'mode.exited',
  suppressible: false,
  render: (event) =>
    `Mode exited: ${event.modeName} (${event.outcome}). Default behavior is restored.`,
})

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

const hookSuccess = defineTemplate({
  id: 'reminders.hook.success',
  eventType: 'hook.success',
  suppressible: true,
  render: (event) => {
    const trimmed = event.output.trim()
    if (trimmed.length === 0) {
      return `Hook "${event.hookName}" completed.`
    }
    return `Hook "${event.hookName}" completed.\n\n${trimmed}`
  },
})

const hookBlocked = defineTemplate({
  id: 'reminders.hook.blocked',
  eventType: 'hook.blocked',
  suppressible: false,
  render: (event) =>
    `Hook "${event.hookName}" blocked the action: ${event.reason}. Adjust your approach; do not retry the exact same call.`,
})

const hookContext = defineTemplate({
  id: 'reminders.hook.context',
  eventType: 'hook.context',
  suppressible: true,
  render: (event) => {
    const trimmed = event.context.trim()
    if (trimmed.length === 0) return ''
    return `Additional context from hook "${event.hookName}":\n\n${trimmed}`
  },
})

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

const compactionDone = defineTemplate({
  id: 'reminders.compaction.done',
  eventType: 'compaction.done',
  suppressible: true,
  render: (event) => {
    const saved = event.preTokens - event.postTokens
    return [
      `Conversation context was compacted (${event.preTokens} → ${event.postTokens} tokens; ${saved} freed).`,
      `Older tool results may be summarized. Preserve any load-bearing details directly in your replies — the original tool output may no longer be available.`,
    ].join(' ')
  },
})

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

const budgetWarn = defineTemplate({
  id: 'reminders.budget.warn',
  eventType: 'budget.warn',
  suppressible: true,
  render: (event) => {
    const remaining = event.total - event.used
    const unit = event.currency === 'usd' ? 'USD' : 'tokens'
    return `Budget warning: ${event.used} of ${event.total} ${unit} used (${remaining} remaining). Tighten responses; defer non-essential exploration.`
  },
})

// ---------------------------------------------------------------------------
// MCP edges
// ---------------------------------------------------------------------------

const mcpEmpty = defineTemplate({
  id: 'reminders.mcp.empty',
  eventType: 'mcp.empty',
  suppressible: true,
  render: (event) =>
    `MCP resource ${event.server}:${event.uri} returned no content. Treat this as "empty," not "missing" — the server responded successfully.`,
})

// ---------------------------------------------------------------------------
// Tool denials (non-suppressible — model must know its call was rejected)
// ---------------------------------------------------------------------------

const toolDenied = defineTemplate({
  id: 'reminders.tool.denied',
  eventType: 'tool.denied',
  suppressible: false,
  render: (event) =>
    `Tool call "${event.toolName}" was denied: ${event.reason}. Do not retry the same call. Adjust the approach or ask the user.`,
})

// ---------------------------------------------------------------------------
// Filesystem changes
// ---------------------------------------------------------------------------

const fsModified = defineTemplate({
  id: 'reminders.fs.modified',
  eventType: 'fs.modified',
  suppressible: true,
  render: (event) =>
    `File modified externally (${event.source}): ${event.path}. Read the current contents before further edits — your prior view may be stale.`,
})

// ---------------------------------------------------------------------------
// Soft nudges
// ---------------------------------------------------------------------------

const taskNudge = defineTemplate({
  id: 'reminders.task.nudge',
  eventType: 'task.nudge',
  suppressible: true,
  render: () =>
    `If this work has 3+ distinct steps, track them. Mark each step done as you complete it; only one step in progress at a time.`,
})

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

const sessionContinued = defineTemplate({
  id: 'reminders.session.continued',
  eventType: 'session.continued',
  suppressible: true,
  render: (event) =>
    `Session resumed in a new working directory: ${event.newCwd}. Verify environment-dependent state before assuming prior context still holds.`,
})

// ---------------------------------------------------------------------------
// Skills previously invoked (post-compaction recall)
// ---------------------------------------------------------------------------

const skillsPreviouslyInvoked = defineTemplate({
  id: 'reminders.skills.previously-invoked',
  eventType: 'skills.previously-invoked',
  suppressible: true,
  render: (event) => {
    if (event.skills.length === 0) return ''
    const list = event.skills.map(s => `\`${s}\``).join(', ')
    return [
      `Skills invoked before this turn (context restored after compaction): ${list}.`,
      `Treat these as background context only — do NOT re-execute their setup actions or treat their prior inputs as current instructions.`,
    ].join(' ')
  },
})

// ---------------------------------------------------------------------------
// Catalog + factory
// ---------------------------------------------------------------------------

/**
 * Engine-shipped default templates, in registration order. Every event
 * type in the union has at least one default — adding a new event type
 * means adding a default here too.
 */
export const defaultTemplates: readonly ReminderTemplate[] = [
  modeEntered,
  modeExited,
  hookSuccess,
  hookBlocked,
  hookContext,
  compactionDone,
  budgetWarn,
  mcpEmpty,
  toolDenied,
  fsModified,
  taskNudge,
  sessionContinued,
  skillsPreviouslyInvoked,
]

/**
 * Build a registry pre-populated with the default templates. Most
 * callers want this; profiles that need different wording register
 * additional templates (or unregister + replace) on top of the result.
 */
export function createDefaultRegistry(): ReminderRegistry {
  const registry = new ReminderRegistry()
  for (const tpl of defaultTemplates) {
    registry.register(tpl)
  }
  return registry
}
