import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { getRequestPrincipal } from '../auth/scoped-principal.js'
import {
  ProtectedSourceReadError,
  type ProtectedSourceReadService,
} from '../protected-source-read.js'
import {
  ProtectedSourceSearchError,
  type ProtectedSourceSearchService,
} from '../protected-source-search.js'
import {
  SOURCE_UTF8_SEARCH_MAX_CONTEXT_BYTES,
  SOURCE_UTF8_SEARCH_MAX_MATCHES,
} from '../source-byte-store.js'
import { readJSON, sendError, sendJSON } from '../router.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BodySchema = z.object({
  subjectId: z.string().min(1).max(128),
  consent: z.discriminatedUnion('state', [
    z.object({ state: z.literal('not_required') }).strict(),
    z.object({
      state: z.literal('recorded'),
      evidenceId: z.string().min(1).max(128),
    }).strict(),
  ]),
  byteStart: z.number().int().nonnegative(),
  byteEnd: z.number().int().positive(),
}).strict()
const SearchBodySchema = z.object({
  subjectId: z.string().min(1).max(128),
  consent: z.discriminatedUnion('state', [
    z.object({ state: z.literal('not_required') }).strict(),
    z.object({
      state: z.literal('recorded'),
      evidenceId: z.string().min(1).max(128),
    }).strict(),
  ]),
  query: z.string().min(1).max(128),
  matchMode: z.enum(['exact_utf8', 'ascii_case_insensitive']),
  maxMatches: z.number().int().min(1).max(SOURCE_UTF8_SEARCH_MAX_MATCHES),
  contextBytes: z.number().int().min(0).max(SOURCE_UTF8_SEARCH_MAX_CONTEXT_BYTES),
}).strict()

export function createReadSourceContentHandler(
  reads: ProtectedSourceReadService,
): (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> {
  return async (req, res, params): Promise<void> => {
    const principal = getRequestPrincipal(req)
    if (principal?.kind !== 'delegated') {
      sendError(res, 403, 'A scoped principal is required for protected content.',
        'source_content_scoped_principal_required', 'auth')
      return
    }
    if (hasQuery(req)) return invalid(res)
    const resourceId = params['resourceId'] ?? ''
    const parsed = BodySchema.safeParse(await readJSON(req))
    if (!UUID.test(resourceId) || !parsed.success ||
        parsed.data.byteStart >= parsed.data.byteEnd) return invalid(res)
    try {
      res.setHeader('Cache-Control', 'no-store')
      sendJSON(res, 200, await reads.read({
        workspaceId: principal.workspaceId,
        profileId: principal.profileId,
        purpose: principal.purpose,
        channel: principal.channel ?? null,
        resourceId,
        subjectId: parsed.data.subjectId,
        consent: parsed.data.consent,
        permissionMode: 'auto',
        byteStart: parsed.data.byteStart,
        byteEnd: parsed.data.byteEnd,
      }))
    } catch (error) {
      if (!(error instanceof ProtectedSourceReadError)) throw error
      if (error.code === 'protected_source_range_invalid') return invalid(res)
      if (error.code === 'protected_source_range_too_large') {
        sendError(res, 413, 'Requested source range exceeds the supported limit.',
          'source_content_range_too_large', 'invalid_request')
        return
      }
      sendError(res, 404, 'Protected source content is unavailable.',
        'source_content_unavailable', 'not_found')
    }
  }
}

export function createSearchSourceContentHandler(
  searches: ProtectedSourceSearchService,
): (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> {
  return async (req, res, params): Promise<void> => {
    const principal = getRequestPrincipal(req)
    if (principal?.kind !== 'delegated') {
      sendError(res, 403, 'A scoped principal is required for protected content.',
        'source_content_scoped_principal_required', 'auth')
      return
    }
    if (hasQuery(req)) return invalidSearch(res)
    const resourceId = params['resourceId'] ?? ''
    const parsed = SearchBodySchema.safeParse(await readJSON(req))
    if (!UUID.test(resourceId) || !parsed.success) return invalidSearch(res)
    try {
      res.setHeader('Cache-Control', 'no-store')
      sendJSON(res, 200, await searches.search({
        workspaceId: principal.workspaceId,
        profileId: principal.profileId,
        purpose: principal.purpose,
        channel: principal.channel ?? null,
        resourceId,
        subjectId: parsed.data.subjectId,
        consent: parsed.data.consent,
        permissionMode: 'auto',
        query: parsed.data.query,
        matchMode: parsed.data.matchMode,
        maxMatches: parsed.data.maxMatches,
        contextBytes: parsed.data.contextBytes,
      }))
    } catch (error) {
      if (!(error instanceof ProtectedSourceSearchError)) throw error
      if (error.code === 'protected_source_search_invalid') return invalidSearch(res)
      if (error.code === 'protected_source_search_timed_out') {
        sendError(res, 504, 'Protected source search timed out without returning partial results.',
          'source_content_search_timed_out')
        return
      }
      sendError(res, 404, 'Protected source content is unavailable.',
        'source_content_unavailable', 'not_found')
    }
  }
}

function hasQuery(req: IncomingMessage): boolean {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  return [...url.searchParams.keys()].length > 0
}

function invalid(res: ServerResponse): void {
  sendError(res, 400, 'Protected source content request is invalid.',
    'source_content_request_invalid', 'invalid_request')
}

function invalidSearch(res: ServerResponse): void {
  sendError(res, 400, 'Protected source search request is invalid.',
    'source_content_search_request_invalid', 'invalid_request')
}
