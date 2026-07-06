/**
 * Ownware Design — design-systems catalogue HTTP endpoints.
 *
 * Slice A5a (`listDesignSystems`): the client's composer context picker
 * needs to list the design systems available for a profile.
 * The existing `list_design_systems` cortex tool gives this data to
 * the AGENT, but the UI can't invoke an agent tool directly — so we
 * expose a lightweight HTTP endpoint that walks the same on-disk
 * catalogue.
 *
 *   GET /api/v1/profiles/:profileId/design-systems
 *   → array of summaries (no full content; cheap to call on every
 *     popover open).
 *
 * Slice B1.8.B (`getDesignSystemContent`): when the user pins a DS in
 * the 🎨 picker, the client side bakes the full DESIGN.md +
 * tokens.css into the `<active-design-systems>` system-prompt block.
 * That bake reads from this on-demand endpoint — one call per pinned
 * DS, fetched in parallel before each `/run` POST.
 *
 *   GET /api/v1/profiles/:profileId/design-systems/:dsId/content
 *   → { id, designMd, tokensCss }
 *
 * Why split the list + content reads instead of putting full content
 * on the list endpoint: the list is called on every popover open
 * (6 manifest reads = cheap). Inlining 6× DESIGN.md + 6× tokens.css
 * would balloon the response and re-read those files every popover
 * open. On-demand is correct — only pinned DS are fetched, only
 * before send.
 *
 * Per Principle 22 — endpoints are profile-scoped so any product
 * with a `design-systems/` folder works (today only ownware-design).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { sendJSON, sendError } from '../router.js'
import type { ProfileRegistry } from '../../profile/registry.js'

export interface DesignSystemSummary {
  readonly id: string
  readonly name: string
  readonly category: string
  readonly surface: string
  readonly summary: string
  readonly swatches: readonly string[]
}

export interface DesignSystemContent {
  readonly id: string
  readonly designMd: string
  readonly tokensCss: string
}

export interface DesignSystemsListDeps {
  readonly registry: ProfileRegistry
}

const DS_ID_RE = /^[a-z0-9][a-z0-9-]*$/

export function createDesignSystemsListHandlers(deps: DesignSystemsListDeps) {
  // GET /api/v1/profiles/:profileId/design-systems
  async function listDesignSystems(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const profileId = params['profileId']!
    const profile = deps.registry.viewFor(profileId)
    if (profile == null) {
      sendError(res, 404, `Profile "${profileId}" not found`)
      return
    }

    const catalogueDir = join(profile.path, 'design-systems')
    let entries
    try {
      entries = await fs.readdir(catalogueDir, { withFileTypes: true })
    } catch {
      // No design-systems folder for this profile — honest empty list.
      sendJSON(res, 200, [])
      return
    }

    const out: DesignSystemSummary[] = []
    for (const entry of entries) {
      // Skip schema-only directories (e.g. `_schema`) and non-folders.
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue

      const manifestPath = join(catalogueDir, entry.name, 'manifest.json')
      let raw: string
      try {
        raw = await fs.readFile(manifestPath, 'utf8')
      } catch {
        // Missing manifest — skip rather than 500. Catalogue can have
        // half-built entries; the UI gets a clean partial list.
        continue
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        // Malformed manifest — same discipline; skip + log via the
        // returned list being one short, no error to the user.
        continue
      }

      if (parsed == null || typeof parsed !== 'object') continue
      const m = parsed as Record<string, unknown>
      if (typeof m['id'] !== 'string' || typeof m['name'] !== 'string') continue

      out.push({
        id: m['id'],
        name: m['name'],
        category: typeof m['category'] === 'string' ? m['category'] : '',
        surface: typeof m['surface'] === 'string' ? m['surface'] : '',
        summary: typeof m['summary'] === 'string' ? m['summary'] : '',
        swatches: Array.isArray(m['swatches'])
          ? m['swatches'].filter((s): s is string => typeof s === 'string')
          : [],
      })
    }

    // Sort by name so the picker UI has a stable order.
    out.sort((a, b) => a.name.localeCompare(b.name))
    sendJSON(res, 200, out)
  }

  // GET /api/v1/profiles/:profileId/design-systems/:dsId/content
  async function getDesignSystemContent(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const profileId = params['profileId']!
    const dsId = params['dsId']!

    if (!DS_ID_RE.test(dsId)) {
      sendError(res, 400, 'dsId must be lowercase kebab-case')
      return
    }

    const profile = deps.registry.viewFor(profileId)
    if (profile == null) {
      sendError(res, 404, `Profile "${profileId}" not found`)
      return
    }

    const dsDir = join(profile.path, 'design-systems', dsId)
    try {
      // `stat` defends against path traversal — `dsId` already passed the
      // regex so it can't contain `..` or `/`, but a missing folder
      // surfaces as a clean 404 rather than a confusing ENOENT on the
      // file reads below.
      const st = await fs.stat(dsDir)
      if (!st.isDirectory()) {
        sendError(res, 404, `Design system "${dsId}" not found`)
        return
      }
    } catch {
      sendError(res, 404, `Design system "${dsId}" not found`)
      return
    }

    let designMd: string
    let tokensCss: string
    try {
      designMd = await fs.readFile(join(dsDir, 'DESIGN.md'), 'utf8')
    } catch {
      sendError(res, 404, `DESIGN.md missing for "${dsId}"`)
      return
    }
    try {
      tokensCss = await fs.readFile(join(dsDir, 'tokens.css'), 'utf8')
    } catch {
      sendError(res, 404, `tokens.css missing for "${dsId}"`)
      return
    }

    const out: DesignSystemContent = { id: dsId, designMd, tokensCss }
    sendJSON(res, 200, out)
  }

  return { listDesignSystems, getDesignSystemContent }
}
