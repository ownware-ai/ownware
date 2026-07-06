/**
 * Ownware Design — per-design metadata HTTP endpoints.
 *
 * Slice 7b (A2). Four plain REST endpoints over the `designs` +
 * `thread_designs` tables that migration 033 shipped:
 *
 *   POST /api/v1/workspaces/:wsId/designs   create a design row
 *   GET  /api/v1/workspaces/:wsId/designs   list designs for workspace
 *   POST /api/v1/threads/:tid/design        link thread → design (1:1 by thread)
 *   GET  /api/v1/threads/:tid/design        resolve thread's current design
 *
 * Per root CLAUDE.md Principle 22 — Design-product-scoped. Coder /
 * Marketing never touch these endpoints. No streaming, no SSE, no
 * hydration coupling: it's just SQL row CRUD over HTTP.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { sendJSON, sendError, readJSON } from '../router.js'
import type { GatewayState } from '../state.js'
import type { ProfileRegistry } from '../../profile/registry.js'
import type { Design, Thread } from '../types.js'

const DESIGN_KINDS = ['prototype', 'sketch', 'deck', 'image', 'video', 'hyperframe'] as const

const CreateDesignSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase kebab-case'),
  kind: z.enum(DESIGN_KINDS),
  name: z.string().min(1).max(200).optional(),
  templateSource: z.string().min(1).max(200).optional(),
})

const LinkThreadDesignSchema = z.object({
  designId: z.string().min(1),
})

const SeedTemplateSchema = z.object({
  templateId: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'templateId must be lowercase kebab-case'),
})

/**
 * PATCH /api/v1/designs/:designId body. Slice B1.6 (2026-05-27).
 * Both fields optional; at least one must be present. Slug renames
 * trigger an atomic folder rename + DB update — see `updateDesign`
 * handler below for the FS-first → DB-second ordering with rollback.
 */
const UpdateDesignSchema = z
  .object({
    name: z.string().min(1).max(200).nullable().optional(),
    slug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase kebab-case')
      .optional(),
    // Slice B1.7 (2026-05-27). Kind switch is metadata-only — no FS
    // work, no row migration. Agent re-reads `<design-metadata>.kind`
    // on the next turn and starts writing in the new shape. The SOUL
    // explicitly anticipates this ("propose switching the canvas
    // kind chip rather than silently writing the wrong shape").
    kind: z.enum(DESIGN_KINDS).optional(),
    // Slice B1.9 (2026-05-27). Template switch is metadata-only — no
    // FS work, no row migration. `useSendDesignMessage` reads
    // `design.templateSource` on every follow-up turn and re-fetches
    // the `<template-reference>` block; updating the column here is
    // enough for the next turn to ship the new template's SKILL.md +
    // example.html. `null` clears the pin.
    templateSource: z.string().min(1).max(200).nullable().optional(),
  })
  .strict()
  .refine(
    (b) =>
      b.name !== undefined ||
      b.slug !== undefined ||
      b.kind !== undefined ||
      b.templateSource !== undefined,
    'At least one of `name`, `slug`, `kind`, or `templateSource` is required.',
  )

/** Profile that owns the design-templates catalog. Hardcoded — the
 *  whole `/designs` surface is Ownware Design-scoped per Principle 22. */
const DESIGN_PROFILE_ID = 'ownware-design'

export interface DesignHandlerDeps {
  /** Profile registry — used to resolve `ownware-design`'s on-disk path
   *  when seeding a template from the catalog. */
  readonly registry: ProfileRegistry
}

export function createDesignHandlers(
  state: GatewayState,
  deps: DesignHandlerDeps,
) {
  // POST /api/v1/workspaces/:wsId/designs
  async function createDesign(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = params['wsId']!
    const workspace = state.getWorkspace(wsId)
    if (!workspace) {
      sendError(res, 404, `Workspace "${wsId}" not found`)
      return
    }

    const body = await readJSON(req)
    if (!body) {
      sendError(res, 400, 'Request body required')
      return
    }

    const parsed = CreateDesignSchema.safeParse(body)
    if (!parsed.success) {
      sendError(
        res,
        400,
        parsed.error.errors
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join('; '),
      )
      return
    }

    const existing = state.getDesignBySlug(wsId, parsed.data.slug)
    if (existing) {
      sendError(
        res,
        409,
        `Design "${parsed.data.slug}" already exists in workspace ${wsId}`,
      )
      return
    }

    const opts: { readonly name?: string; readonly templateSource?: string } = {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.templateSource !== undefined
        ? { templateSource: parsed.data.templateSource }
        : {}),
    }

    const design: Design = state.createDesign(
      wsId,
      parsed.data.slug,
      parsed.data.kind,
      opts,
    )
    sendJSON(res, 201, design)
  }

  // GET /api/v1/workspaces/:wsId/designs
  async function listDesigns(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = params['wsId']!
    const workspace = state.getWorkspace(wsId)
    if (!workspace) {
      sendError(res, 404, `Workspace "${wsId}" not found`)
      return
    }
    const designs = state.listDesignsForWorkspace(wsId)
    sendJSON(res, 200, designs)
  }

  // POST /api/v1/threads/:threadId/design
  async function linkThreadDesign(
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

    const parsed = LinkThreadDesignSchema.safeParse(body)
    if (!parsed.success) {
      sendError(
        res,
        400,
        parsed.error.errors
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join('; '),
      )
      return
    }

    const design = state.getDesign(parsed.data.designId)
    if (!design) {
      sendError(res, 404, `Design "${parsed.data.designId}" not found`)
      return
    }

    state.linkThreadToDesign(threadId, parsed.data.designId)
    sendJSON(res, 200, design)
  }

  // GET /api/v1/threads/:threadId/design
  async function getThreadDesign(
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

    const design = state.getDesignForThread(threadId)
    // 200 OK with `null` body for an existing thread with no design
    // attached — distinguishes "thread is in Ownware or Coder, no
    // design row" from 404 "thread does not exist." The client's TanStack
    // hook reads `null` as "not a Design thread" and skips the canvas
    // kind dispatcher.
    sendJSON(res, 200, design ?? null)
  }

  // GET /api/v1/designs/:designId/thread
  //
  // Reverse lookup: given a design id, resolve a thread linked to it.
  // Used by the workspace-strip child-picker chip (Slice BC3) so the
  // user can switch from one design to another via the dropdown. A
  // single design can host multiple threads (no UNIQUE on `design_id`
  // in `thread_designs`); we return the most-recently-linked thread
  // since that's the natural "active" one for switching. Returns 200
  // with `null` when the design exists but has no linked thread yet —
  // honest empty over a misleading 404 (Principle 21). Returns 404
  // only when the design id itself doesn't exist.
  async function getDesignThread(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const designId = params['designId']!
    const design = state.getDesign(designId)
    if (!design) {
      sendError(res, 404, `Design "${designId}" not found`)
      return
    }
    const threadIds = state.getThreadsForDesign(designId)
    if (threadIds.length === 0) {
      sendJSON(res, 200, null)
      return
    }
    sendJSON(res, 200, { threadId: threadIds[0]! })
  }

  // GET /api/v1/designs/:designId/threads
  //
  // All threads linked to a design, most-recent-first. The thread
  // switcher in the Design chat head lists these so the user can move
  // between a design's sessions. A design hosts many threads
  // (`thread_designs.design_id` is non-unique); `getThreadsForDesign`
  // returns the ids most-recently-linked-first. We resolve each to its
  // full Thread row (title / status / counts / timestamps) so the
  // switcher renders labels without a second round-trip. A thread id with
  // no surviving row (race with a delete) is dropped rather than 500ing
  // the whole list. 404 only when the design id itself doesn't exist.
  async function listThreadsForDesign(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const designId = params['designId']!
    const design = state.getDesign(designId)
    if (!design) {
      sendError(res, 404, `Design "${designId}" not found`)
      return
    }
    const threadIds = state.getThreadsForDesign(designId)
    const threads = threadIds
      .map((id) => state.getThread(id))
      .filter((t): t is Thread => t != null)
    sendJSON(res, 200, threads)
  }

  // POST /api/v1/designs/:designId/seed-template
  //
  // Returns SKILL.md + example.html content from the ownware-design
  // profile's `design-templates/<templateId>/` directory. **No file
  // copy.** The client bakes the returned content into the run's
  // `systemPromptAppend.<template-reference>` block; the slug folder
  // stays empty until the agent's first `writeFile`.
  //
  // Behaviour reversal: prior to slice B1.5 (2026-05-27) this endpoint
  // recursively copied the template folder into the workspace so the
  // agent could `editFile` from turn 1. That anchored output too
  // tightly to the template's exact structure and littered the slug
  // folder with template files. New shape: pure pass-through — agent
  // uses SKILL.md as instructions + example.html as a structural
  // reference and writes fresh. Existing designs whose slug folders
  // already contain seed files are left alone.
  //
  // SKILL.md is required (404 if missing); example.html is optional
  // (returns empty string when absent — some templates like html-ppt
  // describe their structure entirely inside SKILL.md).
  async function seedTemplate(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const designId = params['designId']!
    const design = state.getDesign(designId)
    if (!design) {
      sendError(res, 404, `Design "${designId}" not found`)
      return
    }

    // Workspace lookup retained so callers still get a clear 404 when
    // the design's parent workspace was removed out from under them.
    const workspace = state.getWorkspace(design.workspaceId)
    if (!workspace) {
      sendError(res, 404, `Workspace "${design.workspaceId}" not found`)
      return
    }

    const body = await readJSON(req)
    if (!body) {
      sendError(res, 400, 'Request body required')
      return
    }

    const parsed = SeedTemplateSchema.safeParse(body)
    if (!parsed.success) {
      sendError(
        res,
        400,
        parsed.error.errors
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join('; '),
      )
      return
    }

    const profileEntry = deps.registry.viewFor(DESIGN_PROFILE_ID)
    if (profileEntry == null) {
      sendError(
        res,
        500,
        `Ownware Design profile "${DESIGN_PROFILE_ID}" is not registered. Cannot resolve template catalog.`,
      )
      return
    }

    const templateRoot = resolve(
      profileEntry.path,
      'design-templates',
      parsed.data.templateId,
    )
    const expectedPrefix = resolve(profileEntry.path, 'design-templates') + '/'
    if (!templateRoot.startsWith(expectedPrefix)) {
      sendError(res, 400, 'templateId resolves outside the catalog')
      return
    }

    try {
      const stat = await fs.stat(templateRoot)
      if (!stat.isDirectory()) {
        sendError(res, 404, `Template "${parsed.data.templateId}" is not a directory`)
        return
      }
    } catch {
      sendError(res, 404, `Template "${parsed.data.templateId}" not found in catalog`)
      return
    }

    // SKILL.md is required — it's the agent's instructions for this
    // template. Missing = the template is malformed; reject loudly.
    let skillMd: string
    try {
      skillMd = await fs.readFile(join(templateRoot, 'SKILL.md'), 'utf8')
    } catch {
      sendError(
        res,
        404,
        `Template "${parsed.data.templateId}" is missing SKILL.md`,
      )
      return
    }

    // example.html is optional. Some templates (e.g. html-ppt) carry
    // their structural reference inside SKILL.md and ship no example.
    let exampleHtml = ''
    try {
      exampleHtml = await fs.readFile(
        join(templateRoot, 'example.html'),
        'utf8',
      )
    } catch {
      // ENOENT → empty string is the correct signal.
    }

    sendJSON(res, 200, {
      designId: design.id,
      templateId: parsed.data.templateId,
      skillMd,
      exampleHtml,
    })
  }

  // PATCH /api/v1/designs/:designId
  //
  // Slice B1.6 (2026-05-27). Mutates a design's `name` and / or `slug`.
  // Slug renames atomically move the slug folder on disk AND rewrite
  // the design's workspace `path` in the DB — both halves happen
  // together so the (design.slug, workspace.path, on-disk folder)
  // triple stays consistent.
  //
  // FS-first → DB-second ordering: the filesystem rename happens
  // first, then the DB transaction. If the DB write throws AFTER the
  // FS rename succeeded, the handler attempts to rename the folder
  // back to its original name as a best-effort rollback. If that
  // rollback ALSO fails (disk full, permissions changed mid-flight),
  // we return 500 with an actionable message and log both errors so
  // the operator can repair by hand. The DB and FS cannot share a
  // single atomic boundary; this ordering minimises the window in
  // which they can disagree.
  //
  // Returns the updated design row on 200.
  async function updateDesign(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const designId = params['designId']!
    const design = state.getDesign(designId)
    if (!design) {
      sendError(res, 404, `Design "${designId}" not found`)
      return
    }
    const workspace = state.getWorkspace(design.workspaceId)
    if (!workspace) {
      sendError(res, 404, `Workspace "${design.workspaceId}" not found`)
      return
    }

    const body = await readJSON(req)
    if (!body) {
      sendError(res, 400, 'Request body required')
      return
    }
    const parsed = UpdateDesignSchema.safeParse(body)
    if (!parsed.success) {
      sendError(
        res,
        400,
        parsed.error.errors
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join('; '),
      )
      return
    }

    const wantsSlugChange =
      parsed.data.slug !== undefined && parsed.data.slug !== design.slug

    // Name- and / or kind-only update: no FS work, no collision check.
    // Kind switches are metadata-only — the agent re-reads on the next
    // turn (slice B1.7).
    if (!wantsSlugChange) {
      const updated = state.updateDesign(designId, {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.kind !== undefined ? { kind: parsed.data.kind } : {}),
        ...(parsed.data.templateSource !== undefined
          ? { templateSource: parsed.data.templateSource }
          : {}),
      })
      sendJSON(res, 200, updated)
      return
    }

    const newSlug = parsed.data.slug!

    // DB collision: another design in the SAME parent workspace already
    // owns this slug. Reject loudly so the user picks a different name.
    // The PARENT workspace is `dirname(workspace.path)`'s grand-design
    // — but since the (workspaceId, slug) uniqueness is enforced on
    // the *design's* workspaceId, and each design has its own
    // workspace row, we instead look at all designs whose parent path
    // resolves to the same parent dir. The simple proxy: scan all
    // designs whose workspace path lives under the same parent folder.
    //
    // Cheaper proxy: just check the new on-disk path doesn't exist.
    // A collision on disk reliably implies either another design owns
    // it OR a stranded folder is in the way — both block the rename.
    const oldPath = workspace.path
    const parentDir = oldPath.replace(/\/[^/]+\/?$/, '')
    const newPath = `${parentDir}/${newSlug}`

    if (newPath === oldPath) {
      // Pathological — slug differs but resolves to same path. Treat
      // as a name-only update.
      const updated = state.updateDesign(designId, {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.kind !== undefined ? { kind: parsed.data.kind } : {}),
        ...(parsed.data.templateSource !== undefined
          ? { templateSource: parsed.data.templateSource }
          : {}),
        slug: newSlug,
      })
      sendJSON(res, 200, updated)
      return
    }

    try {
      await fs.access(newPath)
      // No error → target exists. Conflict.
      sendError(
        res,
        409,
        `Slug "${newSlug}" is already taken in this workspace. Pick a different name.`,
      )
      return
    } catch {
      // ENOENT → target is free, proceed.
    }

    // FS rename FIRST. If this fails, nothing has changed.
    try {
      await fs.rename(oldPath, newPath)
    } catch (err) {
      sendError(
        res,
        500,
        `Failed to rename design folder: ${err instanceof Error ? err.message : String(err)}`,
      )
      return
    }

    // DB update SECOND. On throw, attempt to roll the FS rename back.
    try {
      const updated = state.updateDesign(designId, {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.kind !== undefined ? { kind: parsed.data.kind } : {}),
        ...(parsed.data.templateSource !== undefined
          ? { templateSource: parsed.data.templateSource }
          : {}),
        slug: newSlug,
        newWorkspacePath: newPath,
      })
      sendJSON(res, 200, updated)
      return
    } catch (dbErr) {
      // Best-effort FS rollback so the next PATCH retry doesn't 409
      // because the old path is gone.
      try {
        await fs.rename(newPath, oldPath)
      } catch (rollbackErr) {
        // Double-failure — folder is at newPath, DB still at oldPath.
        // The slug folder and its DB record now disagree. Log loudly;
        // the operator must restore by hand.
        // eslint-disable-next-line no-console
        console.error(
          `[designs.updateDesign] PATCH ${designId} double-failure: DB update threw "${dbErr instanceof Error ? dbErr.message : String(dbErr)}" AND FS rollback threw "${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}". Folder is at "${newPath}", DB points at "${oldPath}". Manual repair required.`,
        )
        sendError(
          res,
          500,
          `Design slug rename failed mid-flight. Folder moved to "${newPath}" but the database still points at "${oldPath}". Restore by renaming the folder back to "${oldPath}" or update the DB row manually.`,
        )
        return
      }
      sendError(
        res,
        500,
        `Failed to update design row after folder rename succeeded: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}. Folder was rolled back to its original name; retry the PATCH.`,
      )
      return
    }
  }

  return {
    createDesign,
    listDesigns,
    linkThreadDesign,
    getThreadDesign,
    getDesignThread,
    listThreadsForDesign,
    seedTemplate,
    updateDesign,
  }
}

