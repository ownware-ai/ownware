import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { getRequestPrincipal } from '../auth/scoped-principal.js'
import { ACCESS_GRANT_OPAQUE_ID_PATTERN } from '../access-grant-store.js'
import { CSV_DATA_VIEW_MAX_ROWS } from '../csv-data-view.js'
import { CSV_DATA_VIEW_SELECTION_MAX_FIELDS } from '../csv-data-view-selection.js'
import {
  PROTECTED_DATA_VIEW_SELECTION_MAX_ROWS,
  ProtectedDataViewSelectionError,
  type ProtectedDataViewSelectionService,
} from '../protected-data-view-selection.js'
import { readJSON, sendError, sendJSON } from '../router.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ConsentSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_required') }).strict(),
  z.object({
    state: z.literal('recorded'),
    evidenceId: z.string().regex(ACCESS_GRANT_OPAQUE_ID_PATTERN),
  }).strict(),
])
const QuerySchema = z.object({
  consent: ConsentSchema,
  fieldIds: z.array(z.string().regex(/^field\.[0-9a-f]{32}$/))
    .min(1).max(CSV_DATA_VIEW_SELECTION_MAX_FIELDS),
  rowOffset: z.number().int().min(0).max(CSV_DATA_VIEW_MAX_ROWS - 1),
  rowCount: z.number().int().min(1).max(PROTECTED_DATA_VIEW_SELECTION_MAX_ROWS),
}).strict()

export function createSourceDataViewQueryHandler(
  selections: ProtectedDataViewSelectionService,
): (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> {
  return async (req, res, params): Promise<void> => {
    const principal = getRequestPrincipal(req)
    if (principal?.kind !== 'delegated' || !principal.subjectId) {
      sendError(res, 403, 'A subject-bound scoped principal is required for Data View queries.',
        'source_data_view_scoped_principal_required', 'auth')
      return
    }
    if (hasQuery(req)) return invalid(res)
    const dataViewId = params['dataViewId'] ?? ''
    const body = await readJSON(req)
    if (limitExceeded(body)) return limit(res)
    const parsed = QuerySchema.safeParse(body)
    if (!UUID.test(dataViewId) || !parsed.success ||
        new Set(parsed.data.fieldIds).size !== parsed.data.fieldIds.length) {
      return invalid(res)
    }
    try {
      const result = await selections.select({
        workspaceId: principal.workspaceId,
        profileId: principal.profileId,
        subjectId: principal.subjectId,
        purpose: principal.purpose,
        channel: principal.channel ?? null,
        dataViewId,
        consent: parsed.data.consent,
        permissionMode: 'auto',
        fieldIds: parsed.data.fieldIds,
        rowOffset: parsed.data.rowOffset,
        rowCount: parsed.data.rowCount,
      })
      res.setHeader('Cache-Control', 'no-store')
      sendJSON(res, 200, result)
    } catch (error) {
      if (!(error instanceof ProtectedDataViewSelectionError)) throw error
      unavailable(res)
    }
  }
}

function limitExceeded(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const body = value as { readonly fieldIds?: unknown; readonly rowCount?: unknown }
  return (Array.isArray(body.fieldIds) &&
      body.fieldIds.length > CSV_DATA_VIEW_SELECTION_MAX_FIELDS) ||
    (typeof body.rowCount === 'number' &&
      body.rowCount > PROTECTED_DATA_VIEW_SELECTION_MAX_ROWS)
}

function hasQuery(req: IncomingMessage): boolean {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  return [...url.searchParams.keys()].length > 0
}

function invalid(res: ServerResponse): void {
  sendError(res, 400, 'Data View query request is invalid.',
    'source_data_view_query_invalid', 'invalid_request')
}

function limit(res: ServerResponse): void {
  sendError(res, 413, 'Data View query exceeds the supported limit.',
    'source_data_view_query_limit_exceeded', 'invalid_request')
}

function unavailable(res: ServerResponse): void {
  sendError(res, 404, 'Data View is unavailable.',
    'source_data_view_unavailable', 'not_found')
}
