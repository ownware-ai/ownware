/**
 * Ownware Design — human-write endpoint for design workspace files.
 *
 * Slice B3.1. ONE POST endpoint that writes a UTF-8 string into the
 * design's workspace folder at the given path. Used today by the
 * sketch editor's Save button; reusable by any future human-driven
 * write (poster JSON, image pin sidecar, etc.).
 *
 *   POST /api/v1/designs/:designId/files/*path
 *   Body: { "content": "<file contents as a string>" }
 *
 * Why a dedicated handler instead of routing through the agent's
 * `writeFile` tool: human Save shouldn't pay an LLM round-trip,
 * shouldn't burn tokens, and shouldn't block on agent latency. The
 * sketch is the user's own artifact — they own the write path.
 *
 * Why a JSON envelope rather than raw bytes: every other client
 * api method goes through `api.post()` which always serialises
 * JSON. Forcing raw bodies would mean a parallel low-level fetch
 * surface in the client for this one endpoint. The envelope is small,
 * matches existing conventions, and leaves room for future fields
 * (`ifMatch`, `mode`, etc.) without breaking the wire shape.
 *
 * Path safety mirrors `designs.ts:seedTemplate`:
 *   - splat path captured by the router's `*path` syntax
 *   - resolve() against the workspace root
 *   - reject any result that escapes the workspace's directory
 *
 * Parent directory creation is automatic — future kinds (e.g.
 * pins under `pins/`, assets under `assets/`) shouldn't have to
 * PUT a directory first.
 *
 * Returns 201 + `{ designId, path, bytes }` so the caller can
 * verify what landed.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { promises as fs } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { z } from 'zod'
import { readJSON, sendJSON, sendError } from '../router.js'
import type { GatewayState } from '../state.js'

const WriteFileSchema = z.object({
  content: z.string(),
})

export function createDesignsFilesHandlers(state: GatewayState) {
  // POST /api/v1/designs/:designId/files/*path
  async function writeFile(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const designId = params['designId']!
    const rawPath = params['path']!

    if (rawPath.length === 0) {
      sendError(res, 400, 'Path is required')
      return
    }

    const design = state.getDesign(designId)
    if (!design) {
      sendError(res, 404, `Design "${designId}" not found`)
      return
    }

    const workspace = state.getWorkspace(design.workspaceId)
    if (!workspace) {
      // FK ON DELETE CASCADE normally takes the design row with the
      // workspace, so this branch is reachable only on a corrupted
      // DB. Mirror the symmetric branch in `designs-raw.ts`.
      sendError(res, 404, `Workspace "${design.workspaceId}" not found`)
      return
    }

    const body = await readJSON(req)
    if (!body) {
      sendError(res, 400, 'Request body required')
      return
    }
    const parsed = WriteFileSchema.safeParse(body)
    if (!parsed.success) {
      sendError(
        res,
        400,
        parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
      )
      return
    }

    // Defense in depth — the router URL-normalises `..` and the
    // param guard rejects raw `..` / null bytes / encoded slashes.
    // We still resolve against the workspace root and refuse any
    // result that doesn't sit under it.
    const workspaceRoot = resolve(workspace.path)
    const absolute = resolve(workspaceRoot, rawPath)
    if (
      absolute !== workspaceRoot &&
      !absolute.startsWith(workspaceRoot + '/')
    ) {
      sendError(res, 400, 'Path escapes the design workspace')
      return
    }

    // Create parent directories implicitly so the caller doesn't
    // have to PUT them first. Sketches today land at the workspace
    // root, but future kinds will land under `pins/`, `assets/`, …
    await fs.mkdir(dirname(absolute), { recursive: true })
    await fs.writeFile(absolute, parsed.data.content, 'utf-8')

    sendJSON(res, 201, {
      designId: design.id,
      path: rawPath,
      bytes: Buffer.byteLength(parsed.data.content, 'utf-8'),
    })
  }

  return { writeFile }
}
