/**
 * Hook Runtime
 *
 * Runs the hooks bound to a lifecycle event in registration order.
 * The first hook returning `continue: false` blocks the chain — later
 * hooks for that event do not run.
 *
 * Outcomes flow into the optional reminder injector so the model sees
 * what happened on the next turn:
 *   - `continue: false`        →  `hook.blocked` reminder
 *   - `output: <text>`         →  `hook.success` reminder
 *   - `additionalContext: <s>` →  `hook.context` reminder (skipped if whitespace-only)
 *
 * Hook implementation failures are converted to a block. Host-authority
 * failures (for example, inability to durably record an egress decision)
 * still propagate: continuing would execute without the promised evidence.
 */

import type { ReminderInjector } from '../reminders/index.js'
import type { HookContext, HookRunResult } from './types.js'
import type { HookRegistry } from './registry.js'
import { executeHook } from './executor.js'
import { EgressBlockedError, type EgressControl } from '../egress/types.js'

export interface HookRuntimeOptions {
  readonly registry: HookRegistry
  /** Optional injector — when set, hook outcomes emit reminder events. */
  readonly reminders?: ReminderInjector
}

export class HookRuntime {
  private readonly registry: HookRegistry
  private readonly reminders?: ReminderInjector

  constructor(opts: HookRuntimeOptions) {
    this.registry = opts.registry
    this.reminders = opts.reminders
  }

  /**
   * Whether the runtime would call any hook for the given event. Used
   * by the loop to skip the (cheap) machinery entirely when nothing
   * is bound — keeps the no-hook path identical to before.
   */
  has(event: HookContext['event']): boolean {
    return this.registry.has(event)
  }

  /**
   * Run every hook bound to ctx.event in order.
   *
   * Returns `{ continue: true }` when all hooks allow, or
   * `{ continue: false, blockedHook, blockedReason }` on the first
   * block. Hook implementation failures are contained by `executeHook`;
   * host-authority failures deliberately propagate.
   */
  async run(
    ctx: HookContext,
    signal?: AbortSignal,
    egressControl?: EgressControl,
  ): Promise<HookRunResult> {
    const hooks = this.registry.for(ctx.event)
    if (hooks.length === 0) return { continue: true }

    for (const spec of hooks) {
      if (egressControl !== undefined && spec.egress?.mediation !== 'none') {
        try {
          await egressControl.routeUnavailable({
            sourceKind: spec.egress?.sourceKind ?? (spec.type === 'command' ? 'process' : 'tool'),
            sourceRef: spec.egress?.sourceRef ?? 'profile_hook',
            mediation: spec.egress?.mediation === 'uncontained'
              ? 'uncontained'
              : 'unknown',
          })
        } catch (error) {
          if (!(error instanceof EgressBlockedError)) throw error
          const reason = 'Hook has no verified outbound containment for this local-only run.'
          this.reminders?.emit({
            type: 'hook.blocked',
            hookName: spec.name,
            reason,
          })
          return { continue: false, blockedHook: spec.name, blockedReason: reason }
        }
      }
      const result = await executeHook(spec, ctx, signal)
      const allowed = result.continue !== false

      if (!allowed) {
        const reason = result.reason ?? 'Hook returned continue: false'
        this.reminders?.emit({
          type: 'hook.blocked',
          hookName: spec.name,
          reason,
        })
        return { continue: false, blockedHook: spec.name, blockedReason: reason }
      }

      if (result.output !== undefined) {
        this.reminders?.emit({
          type: 'hook.success',
          hookName: spec.name,
          output: result.output,
        })
      }
      if (result.additionalContext !== undefined && result.additionalContext.trim().length > 0) {
        this.reminders?.emit({
          type: 'hook.context',
          hookName: spec.name,
          context: result.additionalContext,
        })
      }
    }

    return { continue: true }
  }
}
