/**
 * OAuth credential → loom provider transport.
 *
 * This is the seam where the three pieces meet. `oauth-token.ts` says what a
 * token set is, `oauth-token-manager.ts` keeps one alive, and loom's adapters
 * accept a `fetch` closure. This module produces that closure, so a provider
 * powered by an OAuth credential is constructed exactly like any other:
 *
 *     const transport = makeOAuthTransport({ manager, context })
 *     new OpenAIProvider({ apiKey: OAUTH_PLACEHOLDER_KEY, ...transport })
 *
 * Everything provider-specific — which header carries the account, whether the
 * endpoint differs from the vendor default — is expressed by the caller
 * through `authorize`, not baked in here. That is what keeps this one
 * mechanism rather than a per-provider catalogue.
 *
 * ## Why a placeholder API key exists
 *
 * The vendor SDKs refuse to construct without a key, and would otherwise
 * attach their own `Authorization` header from it. The closure strips whatever
 * the SDK set and installs the real bearer, so the placeholder never reaches a
 * server. It is a deliberately recognisable non-secret so that if it ever DID
 * appear in a request log, it reads as a bug rather than a leaked key.
 *
 * ## Per-attempt, not per-stream
 *
 * The closure is re-entered on every HTTP attempt, including SDK-internal
 * retries. It therefore asks the manager for a token each time rather than
 * capturing one — a token captured at stream start would be stale by the time
 * a retry fires after backoff. The manager's durable credential lease makes
 * repeated asks safe and collapses concurrent refreshes across processes.
 */

import type { ProviderFetch, ProviderTransportOptions } from '@ownware/loom'
import type {
  AccessTokenGrant,
  TokenRequestContext,
} from './oauth-token-manager.js'
import { readQuotaFromResponse, type QuotaSignal } from './quota.js'

/**
 * Stand-in key handed to SDKs that refuse to construct without one.
 *
 * Never sent: the transport closure removes the SDK's `Authorization` header
 * before installing the real bearer. Named so it is unmistakable in a log.
 */
export const OAUTH_PLACEHOLDER_KEY = 'ownware-oauth-no-static-key'

/**
 * Provider-specific request shaping, applied AFTER the bearer is installed.
 *
 * Receives the request the SDK intended to send, plus the live grant, and
 * returns what should actually go out. Keeping this a parameter is what stops
 * this file accumulating provider special-cases.
 */
export interface AuthorizeRequest {
  (input: {
    /** URL the SDK targeted. Return a different one to redirect the call. */
    readonly url: string
    /** Headers with the bearer already set and the SDK's own auth removed. */
    readonly headers: Headers
    /** Access token being presented, should a provider need it in the body. */
    readonly accessToken: string
    /** Provider-side account id, when the token set carried one. */
    readonly accountId: string | undefined
  }): { readonly url: string } | void
}

export interface OAuthAccessTokenSource {
  getAccessToken(context: TokenRequestContext): Promise<AccessTokenGrant>
}

interface MakeOAuthTransportBase {
  readonly manager: OAuthAccessTokenSource
  /**
   * Per-attempt audit context. Called on every HTTP attempt so the row carries
   * the live agent/session/thread — these change between turns of one session.
   */
  readonly context: () => TokenRequestContext
  /** Optional provider-specific shaping. Omit for a plain bearer provider. */
  readonly authorize?: AuthorizeRequest
  /**
   * Underlying HTTP call. Injectable so the whole binding is provable against
   * a local fake with no network. Defaults to global `fetch`.
   */
  readonly fetchImpl?: ProviderFetch
}

export interface OAuthTransportObserverFailure {
  readonly code: 'quota_observer_failed'
  readonly observer: 'quota'
}

export type MakeOAuthTransportArgs = MakeOAuthTransportBase & (
  | {
      readonly onQuota?: undefined
      readonly onObserverFailure?: never
    }
  | {
  /**
   * Receives the provider's response-scoped rate-limit signal from each
   * response.
   *
   * This is the only place such a statement can be observed — by the time the
   * SDK has parsed a stream into chunks, the headers are gone. The observer is
   * called for every response including refusals, and must not throw; a
   * reporting failure may not break a working model call.
   */
      readonly onQuota: (signal: QuotaSignal) => void
      /**
       * Required whenever quota observation is enabled. Receives a stable,
       * content-free diagnostic if the observer throws.
       */
      readonly onObserverFailure: (
        failure: OAuthTransportObserverFailure,
      ) => void
    }
)

/**
 * Build the `{ fetch }` to spread into a loom provider constructor.
 *
 * Errors from the manager (`OAuthRefreshDeniedError`,
 * `OAuthReconnectRequiredError`, …) propagate out of the closure. The vendor
 * SDK surfaces them through the adapter's error translation, so the loop sees
 * a typed `ProviderError` rather than an unhandled rejection — proven by
 * loom's transport tests.
 */
export function makeOAuthTransport(args: MakeOAuthTransportArgs): ProviderTransportOptions {
  const {
    manager,
    context,
    authorize,
    fetchImpl,
    onQuota,
    onObserverFailure,
  } = args
  // `ProviderFetch`'s input is exactly what global `fetch` accepts, so this
  // needs no cast — and cortex's tsconfig has no DOM lib, so DOM-only alias
  // names like `RequestInfo` are not in scope here anyway.
  const doFetch: ProviderFetch = fetchImpl ?? ((input, init) => fetch(input, init))

  const transportFetch: ProviderFetch = async (input, init) => {
    // Ask per attempt — a token captured at stream start would be stale by
    // the time an SDK retry fires after backoff.
    const grant = await manager.getAccessToken(context())

    // Derive the init type from the Headers constructor rather than naming
    // `HeadersInit`, which is DOM-only and absent from this package's libs.
    const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0])
    // Remove whatever the SDK derived from the placeholder before installing
    // the real bearer. Header names are case-insensitive in `Headers`, so one
    // delete covers every casing the SDK might have used.
    headers.delete('authorization')
    headers.set('authorization', `Bearer ${grant.accessToken}`)

    const url = typeof input === 'string' ? input : input.toString()
    const shaped = authorize?.({
      url,
      headers,
      accessToken: grant.accessToken,
      accountId: grant.accountId,
    })

    const response = await doFetch(shaped?.url ?? url, { ...init, headers })

    if (onQuota !== undefined) {
      // Read the provider's statement while the headers still exist — once the
      // SDK has parsed the stream into chunks they are gone. Never let a
      // reporting failure break an otherwise-working model call.
      try {
        onQuota(readQuotaFromResponse({ status: response.status, headers: response.headers }))
      } catch {
        try {
          if (onObserverFailure === undefined) {
            throw new Error('quota observer diagnostic is missing')
          }
          onObserverFailure({
            code: 'quota_observer_failed',
            observer: 'quota',
          })
        } catch {
          // The answer still wins over telemetry, but two broken observers are
          // never silent. Keep this stable and content-free: callback/provider
          // error text could contain customer or credential material.
          console.error(
            'OAuth transport observer diagnostic failed (quota_observer_failed).',
          )
        }
      }
    }

    return response
  }

  return { fetch: transportFetch }
}
