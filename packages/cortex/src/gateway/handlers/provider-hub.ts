import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import {
  OpenAICompatibleConnectionInputSchema,
  OpenAICompatibleConnectionNotFoundError,
  PROVIDER_HUB_MAX_PAGE_SIZE,
  ProviderHubCursorError,
  UsageCostSchema,
  type OpenAICompatibleConnectionManager,
  type ProviderHubService,
} from '../../provider-hub/index.js'
import {
  UsageEvidenceIntegrityError,
  UsageEvidenceNotFoundError,
  type UsageEvidenceRepository,
} from '../../storage/usage-evidence-repository.js'
import { readJSON, sendError, sendJSON } from '../router.js'

const ModelQuerySchema = z.object({
  q: z.string().trim().min(1).max(500).optional(),
  providerFamilyId: z.string().trim().min(1).max(512).optional(),
  providerRouteId: z.string().trim().min(1).max(512).optional(),
  connectionId: z.string().trim().min(1).max(512).optional(),
  lifecycle: z.enum(['active', 'experimental', 'deprecated', 'hidden']).optional(),
  scope: z.enum(['all', 'connectable', 'connected', 'verified', 'recommended']).optional(),
  limit: z.coerce.number().int().min(1).max(PROVIDER_HUB_MAX_PAGE_SIZE).optional(),
  cursor: z.string().trim().min(1).max(4_096).optional(),
}).strict()

const RefreshQuerySchema = z.object({
  force: z.enum(['true', 'false']).transform(value => value === 'true').default('false'),
}).strict()

const UsageQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  profileId: z.string().trim().min(1).max(512).optional(),
  threadId: z.string().trim().min(1).max(512).optional(),
  classification: z.enum([
    'estimated', 'provider_reported', 'reconciled', 'subscription', 'local', 'unknown',
  ]).optional(),
  limit: z.coerce.number().int().min(1).max(1_000).optional(),
}).strict()

const ReconciliationSchema = UsageCostSchema.refine(
  cost => cost.classification === 'reconciled',
  'Only reconciled cost observations may be appended through the operator API',
)

/** Additive HTTP facade for the central provider control plane. */
export function createProviderHubHandlers(
  service: ProviderHubService,
  options: {
    readonly openAICompatible?: OpenAICompatibleConnectionManager
    readonly usageEvidence?: UsageEvidenceRepository
  } = {},
) {
  async function overview(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    sendJSON(res, 200, await service.overview())
  }

  async function providers(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    sendJSON(res, 200, await service.providers())
  }

  async function connections(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    sendJSON(res, 200, await service.connections())
  }

  async function verifications(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    sendJSON(res, 200, await service.verifications())
  }

  async function models(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const query = parseSearchParams(req)
    const parsed = ModelQuerySchema.safeParse(query)
    if (!parsed.success) {
      sendError(res, 400, `Invalid provider model query: ${parsed.error.message}`)
      return
    }
    try {
      sendJSON(res, 200, await service.models(parsed.data))
    } catch (error) {
      if (error instanceof ProviderHubCursorError) {
        sendError(res, 400, error.message)
        return
      }
      throw error
    }
  }

  async function health(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    sendJSON(res, 200, await service.health())
  }

  async function refresh(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = RefreshQuerySchema.safeParse(parseSearchParams(req))
    if (!parsed.success) {
      sendError(res, 400, `Invalid provider catalog refresh query: ${parsed.error.message}`)
      return
    }
    const result = await service.refresh(parsed.data.force)
    sendJSON(res, result.catalogHealth.status === 'fresh' ? 200 : 202, result)
  }

  async function compatibleConnections(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (options.openAICompatible == null) {
      sendError(res, 501, 'OpenAI-compatible connections are unavailable in this build')
      return
    }
    sendJSON(res, 200, { items: await options.openAICompatible.list() })
  }

  async function saveCompatibleConnection(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (options.openAICompatible == null) {
      sendError(res, 501, 'OpenAI-compatible connections are unavailable in this build')
      return
    }
    const parsed = OpenAICompatibleConnectionInputSchema.safeParse(await readJSON(req))
    if (!parsed.success) {
      sendError(res, 400, `Invalid OpenAI-compatible connection: ${parsed.error.message}`)
      return
    }
    try {
      const connection = await options.openAICompatible.save(parsed.data)
      sendJSON(res, parsed.data.id == null ? 201 : 200, connection)
    } catch (error) {
      sendError(res, 400, safeMessage(error))
    }
  }

  async function removeCompatibleConnection(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    if (options.openAICompatible == null) {
      sendError(res, 501, 'OpenAI-compatible connections are unavailable in this build')
      return
    }
    try {
      const removed = await options.openAICompatible.remove(params['connectionId'] ?? '')
      if (!removed) {
        sendError(res, 404, 'OpenAI-compatible connection not found')
        return
      }
      sendJSON(res, 200, { removed: true })
    } catch (error) {
      sendError(res, 400, safeMessage(error))
    }
  }

  async function discoverCompatibleModels(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    if (options.openAICompatible == null) {
      sendError(res, 501, 'OpenAI-compatible connections are unavailable in this build')
      return
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const connection = await options.openAICompatible.discover(
        params['connectionId'] ?? '',
        controller.signal,
      )
      sendJSON(res, 200, connection)
    } catch (error) {
      if (error instanceof OpenAICompatibleConnectionNotFoundError) {
        sendError(res, 404, 'OpenAI-compatible connection not found')
        return
      }
      sendError(res, 502, controller.signal.aborted
        ? 'Compatible model discovery timed out'
        : 'The endpoint did not return a compatible model list')
    } finally {
      clearTimeout(timeout)
    }
  }

  async function usage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (options.usageEvidence === undefined) {
      sendError(res, 501, 'Provider usage evidence is unavailable in this build')
      return
    }
    const parsed = UsageQuerySchema.safeParse(parseSearchParams(req))
    if (!parsed.success) {
      sendError(res, 400, 'Invalid provider usage query')
      return
    }
    sendJSON(res, 200, { items: await options.usageEvidence.list(parsed.data) })
  }

  async function usageSummary(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (options.usageEvidence === undefined) {
      sendError(res, 501, 'Provider usage evidence is unavailable in this build')
      return
    }
    const parsed = UsageQuerySchema.omit({ classification: true, limit: true })
      .safeParse(parseSearchParams(req))
    if (!parsed.success) {
      sendError(res, 400, 'Invalid provider usage summary query')
      return
    }
    sendJSON(res, 200, await options.usageEvidence.summary(parsed.data))
  }

  async function usageExport(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (options.usageEvidence === undefined) {
      sendError(res, 501, 'Provider usage evidence is unavailable in this build')
      return
    }
    sendJSON(res, 200, await options.usageEvidence.exportEvidence())
  }

  async function appendUsageCostObservation(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    if (options.usageEvidence === undefined) {
      sendError(res, 501, 'Provider usage evidence is unavailable in this build')
      return
    }
    const parsed = ReconciliationSchema.safeParse(await readJSON(req))
    if (!parsed.success) {
      sendError(res, 400, 'Invalid provider usage reconciliation')
      return
    }
    try {
      sendJSON(res, 201, await options.usageEvidence.appendCostObservation(
        params['usageId'] ?? '',
        parsed.data,
      ))
    } catch (error) {
      if (error instanceof UsageEvidenceNotFoundError) {
        sendError(res, 404, error.message)
        return
      }
      if (error instanceof UsageEvidenceIntegrityError) {
        sendError(res, 409, error.message)
        return
      }
      throw error
    }
  }

  return {
    overview,
    providers,
    connections,
    verifications,
    models,
    health,
    refresh,
    compatibleConnections,
    saveCompatibleConnection,
    removeCompatibleConnection,
    discoverCompatibleModels,
    usage,
    usageSummary,
    usageExport,
    appendUsageCostObservation,
  }
}

function parseSearchParams(req: IncomingMessage): Record<string, string> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  return Object.fromEntries(url.searchParams.entries())
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
