/**
 * Reminders — public API
 *
 * Engine-level subsystem for injecting `<system-reminder>` tags onto
 * outgoing messages. See ./types.ts for design overview.
 */

export type {
  ReminderEvent,
  ReminderEventType,
  ReminderTemplate,
  ReminderRenderContext,
  QueuedReminder,
  ModeExitOutcome,
  BudgetCurrency,
  FsModifiedSource,
} from './types.js'
export { defineTemplate } from './types.js'

export { ReminderRegistry } from './registry.js'

export { ReminderInjector } from './injector.js'
export type { ReminderInjectorOptions } from './injector.js'

export { defaultTemplates, createDefaultRegistry } from './defaults.js'
