/**
 * The lease gate — "two members physically cannot collide" (D7/D8).
 *
 * Single-writer-per-resource, enforced at the TOOL boundary:
 *
 *   - The resource key is derived from the tool call's own arguments
 *     by a kernel-side extractor table (D7 verbatim — never a
 *     parameter, never agent-declared; the agent can't forget or lie).
 *   - The check-and-acquire is one synchronous SQLite transaction
 *     (TeamStore.acquireLease), so concurrent members can never both
 *     pass — impossible, not managed.
 *   - A denial is returned AS THE TOOL RESULT with structured text
 *     that teaches the model its options (work elsewhere / ask the
 *     Conductor / wait — doc 11 Part 5's exact ladder).
 *   - Every tool call by a member renews all its leases (D8's free
 *     heartbeat) — wrapped around every tool, mutating or not.
 *
 * Why the tool boundary and not the checkPermission callback the
 * design docs name: loom's `PolicyDecision` is `'allow' | 'ask'`
 * (permissions/types.ts:51) — a checkPermission callback CANNOT deny,
 * it can only route to the HITL. `Tool.validateInput` is the engine's
 * purpose-built pre-execute block whose `message` reaches the model
 * verbatim as an isError tool result (tools/types.ts contract), and
 * cortex already wraps tools at assembly (`applyProfilePolicies`).
 * Same security ownership, exact denial text, zero loom changes.
 * (BUILD-BOARD delta A7 / decision B10.)
 */

import { resolve } from 'node:path'
import type { Tool, ToolContext } from '@ownware/loom'
import type { TeamStore } from './store.js'
import type { TeamLease } from './schema.js'

/**
 * Structural mirror of loom's `ValidateInputResult` (tools/types.ts) —
 * the type itself isn't on loom's public index; the Tool interface is,
 * and TypeScript checks this shape against it structurally.
 */
type ValidateResult =
  | { readonly result: true }
  | { readonly result: false; readonly message: string; readonly errorCode?: number }

/**
 * Resource-key extractors, declared per MUTATING tool, kernel-side.
 * A tool absent from this table acquires no lease (read-only tools,
 * append-only tools, conversational tools). Generalizes per D12: keys
 * are opaque strings — file paths today, record ids when a CRM tool
 * declares its extractor.
 *
 * Paths are canonicalized against the member's workspace so
 * `./fruits.txt`, `fruits.txt`, and an absolute path all contend on
 * one key.
 */
const RESOURCE_KEY_EXTRACTORS: Readonly<
  Record<string, (input: Record<string, unknown>, workspacePath: string) => readonly string[]>
> = {
  writeFile: (input, ws) =>
    typeof input.file_path === 'string' ? [resolve(ws, input.file_path)] : [],
  editFile: (input, ws) =>
    typeof input.file_path === 'string' ? [resolve(ws, input.file_path)] : [],
}

export interface LeaseGateContext {
  readonly store: TeamStore
  readonly runId: string
  readonly taskId: string
  readonly memberSlug: string
  /** Canonical base for relative paths — the run's workspace. */
  readonly workspacePath: string
  /**
   * Called when a member is denied a resource — the scheduler records
   * the waiter and notifies when the resource frees ("(c) wait —
   * you'll be notified").
   */
  readonly onDenied: (resourceKey: string) => void
}

/** The structured denial — part of the design, it teaches the next move. */
export function renderLeaseDenial(
  resourceKey: string,
  holder: TeamLease,
  holderTaskLabel: string,
): string {
  return (
    `\`${resourceKey}\` is held by **${holder.agentId}** for ${holderTaskLabel}. ` +
    `Your write was NOT executed. Options: ` +
    `(a) this resource is not in your task's scope — continue with the rest of your brief; ` +
    `(b) you believe your task genuinely requires it — call ask_team so the Conductor can untangle the overlap; ` +
    `(c) wait — you'll be notified in a team update when it frees, then retry.`
  )
}

/**
 * Wrap a member's tool set with the lease gate + heartbeat.
 *
 * Every tool gets the heartbeat (any call renews the member's leases).
 * Tools with a declared extractor additionally get the atomic
 * check-and-acquire prepended to their `validateInput` chain — the
 * original validator (e.g. writeFile's sensitive-path block) still
 * runs after the gate passes.
 */
export function wrapMemberToolsWithLeaseGate(
  tools: readonly Tool[],
  gate: LeaseGateContext,
): Tool[] {
  const { store, runId, taskId, memberSlug, workspacePath, onDenied } = gate

  return tools.map((tool) => {
    const extractor = RESOURCE_KEY_EXTRACTORS[tool.name]

    const heartbeat = (): void => {
      try {
        store.renewLeasesForAgent(runId, memberSlug)
      } catch {
        // Heartbeat is an optimization on top of task-scoped release;
        // a failed renew must never break the tool call itself.
      }
    }

    const wrapped: Tool = {
      ...tool,
      async validateInput(
        input: Record<string, unknown>,
        context: ToolContext,
      ): Promise<ValidateResult> {
        if (extractor) {
          for (const resourceKey of extractor(input, workspacePath)) {
            const result = store.acquireLease({ runId, resourceKey, taskId, agentId: memberSlug })
            if (!result.acquired) {
              const holderTask = store.getTask(result.holder.taskId)
              const label = holderTask
                ? `T${holderTask.seq} "${holderTask.title}"`
                : `task ${result.holder.taskId}`
              onDenied(resourceKey)
              return {
                result: false,
                message: renderLeaseDenial(resourceKey, result.holder, label),
                // 30–39: team lease gate (loom builtins reserve 10–29).
                errorCode: 30,
              }
            }
          }
        }
        if (tool.validateInput) {
          return tool.validateInput(input, context)
        }
        return { result: true }
      },
      execute(input, context) {
        heartbeat()
        return tool.execute(input, context)
      },
    }
    return wrapped
  })
}
