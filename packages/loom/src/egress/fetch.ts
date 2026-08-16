import type { ProviderFetch } from '../provider/types.js'
import {
  EgressBlockedError,
  type EgressControl,
  type EgressMediation,
} from './types.js'

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input)
}

function originOf(value: string | URL): string {
  const url = new URL(value)
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username.length > 0
    || url.password.length > 0
  ) {
    throw new EgressBlockedError('local_only_route_unavailable')
  }
  return url.origin
}

/**
 * Wrap one provider HTTP attempt with host authorization and observation.
 *
 * Local-only forces `redirect: manual`: an implementation-controlled local
 * request can therefore never be silently redirected to a remote origin.
 * Redirects are rejected instead of replayed because replaying streamed POST
 * bodies is not generally safe. Unrestricted mode preserves the caller's
 * redirect behavior and records the final response origin exposed by Fetch.
 */
export function createEgressFetch(input: {
  readonly fetch: ProviderFetch
  readonly control: EgressControl
  readonly sourceRef: string
  readonly mediation: Extract<EgressMediation, 'platform_fetch' | 'custom_fetch'>
}): ProviderFetch {
  return async (request, init) => {
    const requestedUrl = requestUrl(request)
    const token = await input.control.beforeDispatch({
      sourceKind: 'provider',
      sourceRef: input.sourceRef,
      transport: requestedUrl.protocol === 'https:' ? 'https' : 'http',
      destinationOrigin: originOf(requestedUrl),
      mediation: input.mediation,
    })

    try {
      const response = await input.fetch(request, {
        ...init,
        ...(input.control.mode === 'local-only' ? { redirect: 'manual' } : {}),
      })
      if (
        input.control.mode === 'local-only'
        && REDIRECT_STATUS.has(response.status)
        && response.headers.has('location')
      ) {
        const location = response.headers.get('location')!
        await input.control.redirectBlocked(
          token,
          originOf(new URL(location, response.url.length > 0 ? response.url : requestedUrl)),
        )
        throw new EgressBlockedError('local_only_redirect')
      }
      await input.control.responseObserved(
        token,
        originOf(response.url.length > 0 ? response.url : requestedUrl),
      )
      return response
    } catch (error) {
      await input.control.dispatchFailed(token)
      throw error
    }
  }
}
