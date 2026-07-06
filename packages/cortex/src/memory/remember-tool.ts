/**
 * `remember` — the Cortex-injected built-in tool.
 *
 * Different semantics from Loom's existing `memory_store / memory_search /
 * memory_forget` (which write through immediately, no approval). Our
 * model is propose-then-accept: every call lands a `memory_proposals`
 * row in 'pending' state and the user accepts via the Memory tab.
 *
 * The tool is created PER SESSION via `createRememberTool({ profileId,
 * threadId, propose })`. The factory captures the scope so the agent
 * never has to know its own profile or thread id — those are
 * authoritative from the gateway, not from anything the model says.
 *
 * Why a factory and not a config-injected store? The Loom tool context
 * exposes `sessionId`, not `profileId` or `threadId`. The session
 * runner (which knows both) is the right place to bind those values
 * before pushing the tool into the assembled tool list. This mirrors
 * how `tasks/scoped-store.ts` wraps the SqliteTaskStore in a per-thread
 * adapter for Loom's `todo_write`.
 */

import { defineTool, type Tool } from '@ownware/loom'
import { RememberInputSchema, type MemoryKind, MAX_MEMORY_CONTENT_CHARS } from './schema.js'

export interface RememberHook {
  /**
   * Persist a proposal. Returns the new (or deduped) proposal id.
   * Throws on validation failure — the tool surfaces the error message
   * to the model verbatim.
   */
  propose(input: { content: string; kind?: MemoryKind }): { proposalId: string }
}

export interface RememberToolDeps {
  readonly hook: RememberHook
  /**
   * Optional callback fired once the proposal has been written. Used
   * by the session runner to publish a gateway-level event so the UI
   * surfaces the approval card without waiting for an SSE round-trip.
   */
  readonly onProposed?: (proposalId: string) => void
}

const REMEMBER_DESCRIPTION = `Propose a memory to persist across future conversations with this user.

When to call:
- The user shared a durable fact about themselves, their work, or their preferences.
- The user corrected you in a way that should bias future answers ("I prefer X over Y").
- You discovered a project-specific convention worth recalling on the next thread.

When NOT to call:
- Transient task state ("currently editing file foo.ts"). That's session scratchpad, not memory.
- Information already documented in code, README, or AGENTS.md — those are read at session start.
- Anything the user explicitly asked you NOT to remember.
- Secrets, API keys, passwords, or anything you would not paste into a public log.

Behaviour:
- Memories are PROPOSED, not stored. The user reviews each proposal in the Memory tab and accepts, edits, or discards.
- Same content proposed again on the same thread is silently deduped — no harm in calling twice.
- Pending proposals do not appear in your context until accepted.

Phrasing:
- Write the fact in third-person about the user ("User uses Bun, not npm").
- Self-contained — future-you will read this without the original conversation context.
- Concise. One fact per call. Multiple facts → multiple calls.`

export function createRememberTool(deps: RememberToolDeps): Tool {
  return defineTool({
    name: 'remember',
    description: REMEMBER_DESCRIPTION,
    category: 'memory',
    isReadOnly: false,
    requiresPermission: false,
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description:
            'The fact to propose. One self-contained sentence in third-person about the user. Max ' +
            MAX_MEMORY_CONTENT_CHARS.toString() +
            ' chars.',
        },
        kind: {
          type: 'string',
          enum: ['fact', 'preference', 'correction', 'identity'],
          description:
            'Optional classification: fact (default) | preference | correction | identity. ' +
            'Used to rank and surface memories in the UI; functionally additive.',
        },
      },
      required: ['content'],
    },
    execute(input) {
      const parsed = RememberInputSchema.safeParse(input)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        const path = issue ? issue.path.join('.') || 'input' : 'input'
        const msg = issue ? issue.message : 'invalid input'
        return Promise.resolve({
          content: `Cannot propose memory: ${path} — ${msg}.`,
          isError: true,
          metadata: { reason: 'validation_failed' },
        })
      }

      try {
        const { proposalId } = deps.hook.propose({
          content: parsed.data.content.trim(),
          kind: parsed.data.kind,
        })
        deps.onProposed?.(proposalId)
        return Promise.resolve({
          content:
            'Proposed for the user to review.\n' +
            'They will see this in the Memory tab and choose to keep, edit, or discard it. ' +
            'It is NOT yet stored — do not assume future sessions will know this until the user accepts.',
          isError: false,
          metadata: { proposalId },
        })
      } catch (err) {
        return Promise.resolve({
          content: `Failed to propose memory: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        })
      }
    },
  })
}
