/**
 * Edit-by-talking — bind a Builder thread to the agent it edits.
 *
 *   POST /api/v1/threads/:threadId/edit-target   { slug }   link thread → agent
 *
 * The client calls this right after opening an edit conversation, so the
 * binding is durable (survives reopen) and queryable (an agent's edit history,
 * since many threads can edit the same agent over time). The general 'builder'
 * profile is untouched — this only records WHICH agent a thread is updating,
 * mirroring the `thread_designs` pattern (Principle 22: a new concern gets its
 * own thread-join, never a column on the core threads table). Cortex stores the
 * binding; the client's vertical re-injects the edit context per turn from it.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { sendJSON, sendError, readJSON } from '../router.js'
import type { GatewayState } from '../state.js'

const LinkEditTargetSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase kebab-case'),
})

export function createEditTargetHandlers(state: GatewayState) {
  async function link(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const threadId = params['threadId']!
    const thread = state.getThread(threadId)
    if (!thread) {
      sendError(res, 404, `Thread "${threadId}" not found`)
      return
    }

    const body = await readJSON(req)
    if (!body) {
      sendError(res, 400, 'Request body required')
      return
    }

    const parsed = LinkEditTargetSchema.safeParse(body)
    if (!parsed.success) {
      sendError(
        res,
        400,
        parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
      )
      return
    }

    state.linkThreadToEdit(threadId, parsed.data.slug)
    sendJSON(res, 200, { threadId, slug: parsed.data.slug })
  }

  /**
   * GET /api/v1/threads/:threadId/edit-target → { slug: string | null }
   *
   * Resolve the agent a thread is editing (null when it isn't an edit thread).
   * The client reads this on REOPEN: a bound thread re-enters edit mode (ribbon
   * + per-turn re-inject) instead of coming back as a generic create. An
   * unbound thread is a normal state — `{ slug: null }`, not a 404.
   */
  async function getTarget(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const threadId = params['threadId']!
    const thread = state.getThread(threadId)
    if (!thread) {
      sendError(res, 404, `Thread "${threadId}" not found`)
      return
    }
    sendJSON(res, 200, { slug: state.getEditForThread(threadId) ?? null })
  }

  /**
   * GET /api/v1/profiles/:slug/edits → { threads: Thread[] }
   *
   * Every edit conversation for an agent, most-recently-active first — backs
   * the edit-thread switcher + resume-latest. An agent can have many edit
   * threads over time; this is its edit history.
   */
  async function listForAgent(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const slug = params['slug']!
    const threads = state
      .getThreadsForEdit(slug)
      .map((id) => state.getThread(id))
      .filter((t): t is NonNullable<typeof t> => t != null)
      // Most-recently-active on top — "the last edit comes up first".
      .slice()
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    sendJSON(res, 200, { threads })
  }

  return { link, getTarget, listForAgent }
}
