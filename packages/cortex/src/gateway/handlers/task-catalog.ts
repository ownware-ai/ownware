import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { PluginService } from '../../plugin/service.js'
import { getRequestPrincipal } from '../auth/scoped-principal.js'
import { readJSON, sendError, sendJSON } from '../router.js'

const SetTaskPackScopeSchema = z.object({
  scopeKind: z.enum(['global', 'workspace', 'agent']),
  scopeId: z.string().min(1).max(256).nullable(),
  decision: z.enum(['allow', 'deny']),
  version: z.string().min(1).max(128).nullable(),
  expectedRevision: z.number().int().min(1).nullable(),
}).strict()

export function createTaskCatalogHandlers(
  service: PluginService,
  options: { readonly authEnabled: boolean },
) {
  async function list(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!ownerOnly(request, response, options.authEnabled)) return
    const context = parseCatalogContext(request)
    if (context === null) {
      sendError(response, 400, 'Task catalog context is invalid.')
      return
    }
    sendJSON(response, 200, { taskPacks: await service.catalog(context) })
  }

  async function setScope(
    request: IncomingMessage,
    response: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    if (!ownerOnly(request, response, options.authEnabled)) return
    const body = await readJSON(request)
    const parsed = SetTaskPackScopeSchema.safeParse(body)
    if (!parsed.success) {
      sendError(response, 400, 'Task scope request is invalid.')
      return
    }
    try {
      const grant = await service.setGrant({
        pluginId: params['taskPackId']!,
        scopeKind: parsed.data.scopeKind,
        scopeId: parsed.data.scopeId,
        decision: parsed.data.decision,
        version: parsed.data.version,
      }, parsed.data.expectedRevision)
      sendJSON(response, 200, {
        scope: {
          taskPackId: grant.pluginId,
          scopeKind: grant.scopeKind,
          scopeId: grant.scopeId,
          decision: grant.decision,
          version: grant.version,
          revision: grant.revision,
          updatedAt: grant.updatedAt,
        },
      })
    } catch (error) {
      if (error instanceof TypeError) {
        sendError(response, 400, 'Task scope request is invalid.')
        return
      }
      if (error instanceof Error && error.name === 'PluginVersionNotFoundError') {
        sendError(response, 404, 'Task pack version was not found.')
        return
      }
      if (error instanceof Error && error.name === 'PluginGrantConflictError') {
        sendError(response, 409, 'Task scope changed; refresh and retry.')
        return
      }
      throw error
    }
  }

  return { list, setScope }
}

function parseCatalogContext(
  request: IncomingMessage,
): { readonly workspaceId?: string; readonly agentId?: string } | null {
  const url = new URL(request.url ?? '/', `http://${request.headers?.host ?? 'localhost'}`)
  const allowed = new Set(['workspaceId', 'agentId'])
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return null
  }
  const values = Object.fromEntries(
    [...allowed]
      .map(key => [key, url.searchParams.get(key)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== null),
  )
  for (const value of Object.values(values)) {
    if (value.length < 1 || value.length > 256 || value.trim() !== value || value.includes('\0')) {
      return null
    }
  }
  return values
}

function ownerOnly(
  request: IncomingMessage,
  response: ServerResponse,
  authEnabled: boolean,
): boolean {
  response.setHeader('Cache-Control', 'no-store')
  const principal = getRequestPrincipal(request)
  if ((authEnabled && principal?.kind !== 'owner') || principal?.kind === 'delegated') {
    sendError(
      response,
      403,
      'Only the install owner can manage task packs.',
      'owner_required',
      'auth',
    )
    return false
  }
  return true
}
