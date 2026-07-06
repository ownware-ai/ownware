/**
 * Profile Skills HTTP Handlers
 *
 * POST   /api/v1/profiles/:profileId/skills            install a skill (URL or pasted)
 * DELETE /api/v1/profiles/:profileId/skills/:slug      remove an installed skill
 *
 * The heavy lifting is in `packages/cortex/src/profile/skills/` — these
 * handlers are thin: parse + validate request, fork builtin if needed,
 * delegate, map errors to HTTP status codes.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { readJSON, sendError, sendJSON } from '../router.js'
import type { ProfileRegistry } from '../../profile/registry.js'
import {
  installSkill,
  removeSkill,
  SkillInstallError,
  type SkillInstallErrorCode,
} from '../../profile/skills/installer.js'
import { setSkillActive } from '../../profile/skills/activate.js'
import {
  resolveSkillUrl,
  SkillUrlError,
} from '../../profile/skills/url-resolver.js'
import { listSkillsInRepo, SkillFetchError } from '../../profile/skills/fetcher.js'

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const InstallSkillRequestSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('url'),
    url: z.string().min(1).max(2048),
  }),
  z.object({
    source: z.literal('content'),
    content: z.string().min(1).max(64 * 1024),
    sourceUrl: z.string().min(1).max(2048).nullable().optional(),
  }),
  z.object({
    source: z.literal('github-folder'),
    owner: z.string().min(1).max(100),
    repo: z.string().min(1).max(100),
    ref: z.string().min(1).max(255),
    path: z.string().min(1).max(1024),
  }),
])

const SLUG_RE = /^[a-zA-Z0-9_-]+$/

const SetSkillActiveRequestSchema = z.object({
  active: z.boolean(),
})

// ---------------------------------------------------------------------------
// Status code mapping
// ---------------------------------------------------------------------------

function statusFor(code: SkillInstallErrorCode): number {
  switch (code) {
    case 'INVALID_URL':
    case 'UNSUPPORTED_SCHEME':
    case 'PRIVATE_HOST':
    case 'UNSUPPORTED_HOST':
    case 'MALFORMED_FRONTMATTER':
    case 'INVALID_YAML':
    case 'MISSING_OR_INVALID_NAME':
    case 'MISSING_OR_INVALID_DESCRIPTION':
    case 'UNSAFE_NAME':
    case 'EMPTY_BODY':
    case 'INVALID_SLUG':
      return 400
    case 'NOT_FOUND':
      return 404
    case 'SKILL_EXISTS':
      return 409
    case 'TOO_LARGE':
    case 'TREE_TOO_LARGE':
      return 413
    case 'WRONG_CONTENT_TYPE':
      return 415
    case 'FETCH_FAILED':
    case 'TOO_MANY_REDIRECTS':
    case 'GIST_FILE_NOT_FOUND':
      return 502
    case 'WRITE_FAILED':
    case 'DELETE_FAILED':
    case 'RELOAD_FAILED':
      return 500
  }
}

function sendInstallError(res: ServerResponse, err: SkillInstallError): void {
  res.statusCode = statusFor(err.code)
  res.setHeader('Content-Type', 'application/json')
  // Envelope matches the gateway convention used by other handlers:
  //   { error: <CODE>, message: <human>, ...details }
  // The client's api layer reads `error` into GatewayError.code and
  // `message` into GatewayError.message.
  res.end(
    JSON.stringify({
      error: err.code,
      message: err.message,
      ...(err.details ?? {}),
    }),
  )
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export interface SkillHandlers {
  installSkill: (
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ) => Promise<void>
  removeSkill: (
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ) => Promise<void>
  setSkillActive: (
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ) => Promise<void>
  browseSkills: (
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ) => Promise<void>
}

export function createSkillHandlers(
  registry: ProfileRegistry,
  userProfilesDir: string,
): SkillHandlers {
  // POST /api/v1/profiles/:profileId/skills
  async function install(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const profileId = params['profileId']!
    if (!registry.has(profileId)) {
      sendError(res, 404, `Profile "${profileId}" not found`)
      return
    }

    const body = await readJSON<unknown>(req)
    const parsed = InstallSkillRequestSchema.safeParse(body)
    if (!parsed.success) {
      sendError(res, 400, `Invalid request: ${parsed.error.message}`)
      return
    }

    try {
      // Fork-on-write: bundled profiles are read-only.
      await registry.forkBuiltin(profileId, userProfilesDir)
      const loaded = await registry.get(profileId)

      const data = parsed.data
      const source =
        data.source === 'url'
          ? ({ kind: 'url', url: data.url } as const)
          : data.source === 'content'
            ? ({
                kind: 'content',
                content: data.content,
                sourceUrl: data.sourceUrl ?? null,
              } as const)
            : ({
                kind: 'github-folder',
                owner: data.owner,
                repo: data.repo,
                ref: data.ref,
                path: data.path,
              } as const)

      const installed = await installSkill({
        profileId,
        profileBasePath: loaded.basePath,
        source,
        registry,
      })

      sendJSON(res, 201, {
        slug: installed.slug,
        name: installed.name,
        description: installed.description,
        trigger: installed.trigger,
        source: installed.source,
      })
    } catch (err) {
      if (err instanceof SkillInstallError) {
        sendInstallError(res, err)
        return
      }
      sendError(
        res,
        500,
        err instanceof Error ? err.message : 'Failed to install skill.',
      )
    }
  }

  // DELETE /api/v1/profiles/:profileId/skills/:slug
  async function remove(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const profileId = params['profileId']!
    const slug = params['slug']!

    if (!registry.has(profileId)) {
      sendError(res, 404, `Profile "${profileId}" not found`)
      return
    }
    if (!SLUG_RE.test(slug)) {
      sendError(res, 400, 'Invalid slug.')
      return
    }

    try {
      await registry.forkBuiltin(profileId, userProfilesDir)
      const loaded = await registry.get(profileId)

      await removeSkill({
        profileId,
        profileBasePath: loaded.basePath,
        slug,
        registry,
      })

      res.statusCode = 204
      res.end()
    } catch (err) {
      if (err instanceof SkillInstallError) {
        sendInstallError(res, err)
        return
      }
      sendError(
        res,
        500,
        err instanceof Error ? err.message : 'Failed to remove skill.',
      )
    }
  }

  // GET /api/v1/profiles/:profileId/skills/browse?url=<repo-or-tree>
  async function browse(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const profileId = params['profileId']!
    if (!registry.has(profileId)) {
      sendError(res, 404, `Profile "${profileId}" not found`)
      return
    }
    const url = new URL(req.url ?? '', 'http://x').searchParams.get('url')
    if (!url) {
      sendError(res, 400, 'Missing required query param: url')
      return
    }

    let resolved
    try {
      resolved = resolveSkillUrl(url)
    } catch (err) {
      if (err instanceof SkillUrlError) {
        sendError(res, 400, err.message)
        return
      }
      throw err
    }

    if (resolved.origin !== 'github-repo' && resolved.origin !== 'github-tree') {
      sendError(
        res,
        400,
        'Browse requires a repo URL (github.com/<owner>/<repo>) or a tree URL.',
      )
      return
    }

    try {
      const skills = await listSkillsInRepo(resolved)
      sendJSON(res, 200, { skills })
    } catch (err) {
      if (err instanceof SkillFetchError) {
        const status =
          err.code === 'PRIVATE_HOST' || err.code === 'INVALID_URL'
            ? 400
            : err.code === 'TOO_LARGE' || err.code === 'TREE_TOO_LARGE'
              ? 413
              : 502
        res.statusCode = status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: err.code, message: err.message }))
        return
      }
      sendError(
        res,
        500,
        err instanceof Error ? err.message : 'Failed to browse skills.',
      )
    }
  }

  // PATCH /api/v1/profiles/:profileId/skills/:slug
  async function setActive(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const profileId = params['profileId']!
    const slug = params['slug']!

    if (!registry.has(profileId)) {
      sendError(res, 404, `Profile "${profileId}" not found`)
      return
    }
    if (!SLUG_RE.test(slug)) {
      sendError(res, 400, 'Invalid slug.')
      return
    }

    const body = await readJSON<unknown>(req)
    const parsed = SetSkillActiveRequestSchema.safeParse(body)
    if (!parsed.success) {
      sendError(res, 400, `Invalid request: ${parsed.error.message}`)
      return
    }

    try {
      await registry.forkBuiltin(profileId, userProfilesDir)
      const loaded = await registry.get(profileId)
      await setSkillActive({
        profileId,
        profileBasePath: loaded.basePath,
        slug,
        active: parsed.data.active,
        registry,
      })
      sendJSON(res, 200, { slug, active: parsed.data.active })
    } catch (err) {
      if (err instanceof SkillInstallError) {
        sendInstallError(res, err)
        return
      }
      sendError(
        res,
        500,
        err instanceof Error ? err.message : 'Failed to update skill.',
      )
    }
  }

  return {
    installSkill: install,
    removeSkill: remove,
    setSkillActive: setActive,
    browseSkills: browse,
  }
}
