/**
 * Minimal HTTP router — no Express needed.
 *
 * Supports path params (:id), async handlers, and JSON helpers.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleCORS } from './cors.js'
import { validateParams } from './middleware/param-guard.js'
import type { ErrorCategory } from '../errors/categories.js'
import { classifyError } from '../errors/classify.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum request body size: 10 MB */
const MAX_BODY_SIZE = 10 * 1024 * 1024

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void>

interface Route {
  readonly method: string
  readonly pattern: RegExp
  readonly paramNames: string[]
  readonly handler: Handler
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export type Middleware = (req: IncomingMessage, res: ServerResponse) => boolean

export class Router {
  private readonly routes: Route[] = []
  private readonly middlewares: Middleware[] = []
  private corsOrigin: string | readonly string[] = '*'

  setCorsOrigin(origin: string | readonly string[]): void {
    this.corsOrigin = origin
  }

  /** Add a middleware that runs before route handlers. Return false to abort. */
  use(middleware: Middleware): void {
    this.middlewares.push(middleware)
  }

  get(path: string, handler: Handler): void {
    this.addRoute('GET', path, handler)
  }

  post(path: string, handler: Handler): void {
    this.addRoute('POST', path, handler)
  }

  put(path: string, handler: Handler): void {
    this.addRoute('PUT', path, handler)
  }

  patch(path: string, handler: Handler): void {
    this.addRoute('PATCH', path, handler)
  }

  delete(path: string, handler: Handler): void {
    this.addRoute('DELETE', path, handler)
  }

  /**
   * Match and dispatch an incoming request.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS
    if (handleCORS(req, res, this.corsOrigin)) return

    // Run middleware chain
    for (const mw of this.middlewares) {
      if (!mw(req, res)) return // Middleware rejected — response already sent
    }

    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const pathname = url.pathname

    for (const route of this.routes) {
      if (route.method !== method) continue

      const match = pathname.match(route.pattern)
      if (!match) continue

      // Extract path params
      const params: Record<string, string> = {}
      for (let i = 0; i < route.paramNames.length; i++) {
        const value = match[i + 1]
        if (value !== undefined) {
          params[route.paramNames[i]!] = decodeURIComponent(value)
        }
      }

      // Validate params against unsafe characters
      try {
        validateParams(params)
      } catch (err) {
        if (err instanceof RequestError) {
          sendError(res, err.status, err.message, undefined, err.category)
        } else {
          sendError(res, 400, 'Invalid path parameters', undefined, 'invalid_request')
        }
        return
      }

      try {
        await route.handler(req, res, params)
      } catch (err) {
        if (!res.headersSent) {
          if (err instanceof RequestError) {
            sendError(res, err.status, err.message, undefined, err.category)
          } else {
            // Catch-all: classify the raw thrown value via the cause-graph
            // walker. Every handler that throws an unclassified error gets
            // automatic category tagging without changing the handler itself
            // — this is the single point that closes the "the client sees
            // category=unknown for everything" gap.
            const classified = classifyError(err)
            sendError(res, 500, classified.message, undefined, classified.category)
          }
        }
      }
      return
    }

    // No route matched
    sendError(res, 404, `Route not found: ${method} ${pathname}`, undefined, 'not_found')
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private addRoute(method: string, path: string, handler: Handler): void {
    const { pattern, paramNames } = compilePath(path)
    this.routes.push({ method, pattern, paramNames, handler })
  }
}

// ---------------------------------------------------------------------------
// Path compilation: "/threads/:threadId" → regex + param names
//
// Supports two param shapes:
//   :name      single segment, captures via `([^/]+)`
//   *name      trailing greedy splat, captures the rest of the path
//              (one or more characters including `/`) via `(.+)`
//
// The splat is only valid as the final segment ("/foo/*rest"). It exists
// to support endpoints that accept nested file paths — for example,
// `/api/v1/designs/:designId/raw/*path` resolving to `assets/logo.svg`.
// Path-traversal safety is the handler's responsibility (resolve + prefix
// check); the router only extracts the captured string.
// ---------------------------------------------------------------------------

function compilePath(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = []
  let basePath = path
  let splatName: string | null = null
  const trailingSplat = /\/\*([a-zA-Z0-9_]+)$/.exec(path)
  if (trailingSplat) {
    splatName = trailingSplat[1]!
    basePath = path.slice(0, trailingSplat.index)
  }
  // Replace :name first so its capture group lands before the splat's.
  // The regex group order must match the paramNames order — that's how
  // handle() pairs captures back to names.
  const regexStr = basePath.replace(/:([a-zA-Z0-9_]+)/g, (_match, name: string) => {
    paramNames.push(name)
    return '([^/]+)'
  })
  if (splatName !== null) {
    paramNames.push(splatName)
    return { pattern: new RegExp(`^${regexStr}/(.+)$`), paramNames }
  }
  return { pattern: new RegExp(`^${regexStr}$`), paramNames }
}

// ---------------------------------------------------------------------------
// Request/response helpers
// ---------------------------------------------------------------------------

/**
 * Read the full request body as a string.
 * Rejects with RequestError(413) if body exceeds MAX_BODY_SIZE (10 MB).
 */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalSize = 0

    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy()
        reject(new RequestError(413, `Request body exceeds maximum size of ${MAX_BODY_SIZE} bytes`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

/**
 * Parse request body as JSON. Returns null on empty body.
 * Throws with clear message on invalid JSON.
 */
export async function readJSON<T = unknown>(req: IncomingMessage): Promise<T | null> {
  const body = await readBody(req)
  if (!body.trim()) return null

  try {
    return JSON.parse(body) as T
  } catch {
    throw new RequestError(400, 'Invalid JSON in request body')
  }
}

/**
 * Send a JSON response.
 */
export function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  const json = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  })
  res.end(json)
}

/**
 * Send an error response. Carries the closed-enum `category` field that
 * the client uses to dispatch error UI (see `categories.md`). Callers that
 * don't pass a category get a sensible derivation from the HTTP status.
 *
 * Prefer {@link sendClassifiedError} from `errors/send-classified.ts`
 * when you have a thrown `Error` — it walks the cause graph and picks
 * a more precise category than the status code alone can.
 */
export function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  error?: string,
  category?: ErrorCategory,
): void {
  sendJSON(res, status, {
    error: error ?? statusToCode(status),
    message,
    category: category ?? statusToCategory(status),
  })
}

/**
 * Request error with HTTP status code. Optionally carries an
 * `ErrorCategory` so handlers throwing through the router get the right
 * wire category without an explicit catch.
 */
export class RequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly category?: ErrorCategory,
  ) {
    super(message)
    this.name = 'RequestError'
  }
}

function statusToCode(status: number): string {
  switch (status) {
    case 400: return 'invalid_request'
    case 404: return 'not_found'
    case 409: return 'conflict'
    case 422: return 'validation_error'
    case 500: return 'internal_error'
    default: return 'error'
  }
}

/**
 * Map an HTTP status to a default {@link ErrorCategory}. Used when a
 * caller passes only `status + message` and we have no error object to
 * classify. Less precise than {@link sendClassifiedError}; prefer that
 * when an `Error` is in hand.
 */
function statusToCategory(status: number): ErrorCategory {
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not_found'
  if (status === 422 || status === 400 || status === 409) return 'invalid_request'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'overload'
  return 'unknown'
}
