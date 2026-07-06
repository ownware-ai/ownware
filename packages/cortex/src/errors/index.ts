/**
 * Cortex error pipeline — public surface.
 *
 * Consumers (gateway handlers, session-runner, UI clients via the shared
 * tsconfig alias) import everything from this file rather than reaching
 * into individual modules. See `categories.md` for semantics.
 */

export {
  ERROR_CATEGORIES,
  USER_ACTIONS,
  MAX_MESSAGE_LEN,
  boundMessage,
} from './categories.js'

export type {
  ErrorCategory,
  UserAction,
  ClassifiedError,
} from './categories.js'

export { classifyError } from './classify.js'
export { sendClassifiedError } from './send-classified.js'
