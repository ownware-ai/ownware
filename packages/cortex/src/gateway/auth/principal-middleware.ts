import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendError } from '../router.js'
import {
  PrincipalAuthError,
  ScopedPrincipalService,
  setRequestPrincipal,
} from './scoped-principal.js'

const AUTH_EXEMPT_PATHS = new Set(['/api/v1/health'])

export function createPrincipalAuthMiddleware(
  ownerToken: string,
  service: ScopedPrincipalService,
  options: { readonly disabled: boolean },
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    if (options.disabled) {
      setRequestPrincipal(req, { kind: 'owner' })
      return true
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (AUTH_EXEMPT_PATHS.has(url.pathname) || req.method === 'OPTIONS') return true

    const token = bearerToken(req.headers.authorization)
    if (!token) {
      sendError(res, 401, 'Missing authorization token', 'unauthorized', 'auth')
      return false
    }
    if (constantTimeTokenEqual(token, ownerToken)) {
      setRequestPrincipal(req, { kind: 'owner' })
      return true
    }

    try {
      setRequestPrincipal(req, await service.verify(token))
      return true
    } catch (error) {
      const code = error instanceof PrincipalAuthError ? error.code : 'principal_invalid'
      sendError(res, 401, 'Invalid or expired delegated principal', code, 'auth')
      return false
    }
  }
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer ([^\s]+)$/.exec(header)
  return match?.[1] ?? null
}

function constantTimeTokenEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
