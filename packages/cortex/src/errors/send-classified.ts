/**
 * sendClassifiedError — the funneled exit point for caught exceptions
 * in HTTP handlers.
 *
 * Call this from any handler's catch block where you have an unknown
 * thrown value and need to render an error response with the right
 * `category` for the client to dispatch on. It:
 *
 *   1. Walks the cause graph with `classifyError(err)`.
 *   2. Maps the classified category to a sensible HTTP status when the
 *      caller didn't pass one (`auth → 401`, `not_found → 404`, etc.).
 *   3. Emits the standard `{ error, message, category }` envelope via
 *      the router's `sendError` so the client's GatewayError picks it up.
 *
 * Lives in `errors/` (not `gateway/router.ts`) so the router stays
 * dependency-clean — no Loom imports leak into the HTTP layer.
 */

import type { ServerResponse } from 'node:http'
import { sendError } from '../gateway/router.js'
import { classifyError } from './classify.js'
import type { ErrorCategory } from './categories.js'

/**
 * Send a classified error response. If `status` is omitted, the category
 * is mapped to a sensible HTTP status code.
 */
export function sendClassifiedError(
  res: ServerResponse,
  err: unknown,
  status?: number,
): void {
  const classified = classifyError(err)
  const httpStatus = status ?? categoryToStatus(classified.category)
  sendError(
    res,
    httpStatus,
    classified.message,
    statusToCode(httpStatus),
    classified.category,
  )
}

/**
 * Default HTTP status for a classified category. Used when the caller
 * didn't specify a status explicitly. Conservative defaults — choose
 * 5xx only for genuinely server-side failures.
 */
function categoryToStatus(category: ErrorCategory): number {
  switch (category) {
    case 'auth':
    case 'connector_auth_expired':
      return 401
    case 'connector_not_configured':
      return 409 // resource exists but isn't configured
    case 'not_found':
      return 404
    case 'rate_limit':
    case 'connector_rate_limited':
      return 429
    case 'overload':
    case 'connector_vendor':
    case 'sqlite':
    case 'network':
      return 503
    case 'context_window':
    case 'content_policy':
    case 'invalid_request':
    case 'connector_validation':
    case 'config':
      return 400
    case 'tool_timeout':
      return 504
    case 'tool_permission':
    case 'aborted':
      return 409
    case 'unknown':
      return 500
  }
}

function statusToCode(status: number): string {
  switch (status) {
    case 400: return 'invalid_request'
    case 401: return 'unauthorized'
    case 403: return 'forbidden'
    case 404: return 'not_found'
    case 409: return 'conflict'
    case 422: return 'validation_error'
    case 429: return 'rate_limited'
    case 500: return 'internal_error'
    case 503: return 'service_unavailable'
    case 504: return 'gateway_timeout'
    default: return 'error'
  }
}
