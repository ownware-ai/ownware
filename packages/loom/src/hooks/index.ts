/**
 * Hooks — public API
 *
 * Engine-level lifecycle hook subsystem. Profiles bind hooks to events
 * (session.start, user.prompt.submit, tool.pre, tool.post); the loop
 * runs them at the matching points and routes outcomes through the
 * reminder injector. See ./types.ts for the design overview.
 */

export type {
  HookEvent,
  HookContext,
  HookResult,
  HookFn,
  HookSpec,
  HookRunResult,
} from './types.js'

export { HookRegistry } from './registry.js'

export { HookRuntime } from './runtime.js'
export type { HookRuntimeOptions } from './runtime.js'

export { executeHook } from './executor.js'
