/**
 * Engine-facing outbound-dispatch contract.
 *
 * Loom does not persist receipts or decide what a host calls "local". It
 * exposes the exact dispatch seam and requires the host to authorize it before
 * the underlying transport is invoked. Cortex owns policy, durability and the
 * public receipt projection.
 */

export type EgressMode = 'unrestricted' | 'local-only'

export type EgressSourceKind =
  | 'provider'
  | 'tool'
  | 'connector'
  | 'browser'
  | 'process'
  | 'runtime'

export type EgressTransport =
  | 'http'
  | 'https'
  | 'ws'
  | 'wss'
  | 'tcp'
  | 'tls'
  | 'unknown'

export type EgressMediation =
  | 'platform_fetch'
  | 'custom_fetch'
  | 'uncontained'
  | 'unknown'

export interface EgressDispatchRequest {
  readonly sourceKind: EgressSourceKind
  /** Bounded structural identity such as `ollama` or `web_fetch`. */
  readonly sourceRef: string
  readonly transport: EgressTransport
  /** Normalized origin only. Paths, queries, fragments and credentials fail validation. */
  readonly destinationOrigin: string
  readonly mediation: EgressMediation
}

/** Opaque identity returned only after the durable pre-dispatch receipt exists. */
export interface EgressDispatchToken {
  readonly dispatchId: string
}

export interface EgressUnknownRoute {
  readonly sourceKind: EgressSourceKind
  readonly sourceRef: string
  readonly mediation: Extract<EgressMediation, 'uncontained' | 'unknown'>
}

/**
 * Host-owned enforcement boundary.
 *
 * `beforeDispatch` MUST finish before transport invocation. Throwing blocks the
 * dispatch. A token proves only that policy admitted the named origin and that
 * the attempt receipt is durable; it does not prove bytes left the process.
 */
export interface EgressControl {
  readonly mode: EgressMode
  beforeDispatch(request: EgressDispatchRequest): Promise<EgressDispatchToken>
  responseObserved(token: EgressDispatchToken, destinationOrigin: string): Promise<void>
  redirectBlocked(token: EgressDispatchToken, destinationOrigin: string): Promise<void>
  dispatchFailed(token: EgressDispatchToken): Promise<void>
  routeUnavailable(route: EgressUnknownRoute): Promise<void>
}

export class EgressBlockedError extends Error {
  override readonly name = 'EgressBlockedError'

  constructor(
    readonly code:
      | 'local_only_remote_destination'
      | 'local_only_custom_transport'
      | 'local_only_route_unavailable'
      | 'local_only_redirect',
  ) {
    super(`Outbound dispatch blocked (${code}).`)
  }
}
