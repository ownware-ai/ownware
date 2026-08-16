import { isIP } from 'node:net'
import { randomUUID } from 'node:crypto'
import {
  EgressBlockedError,
  type EgressControl,
  type EgressDispatchRequest,
  type EgressDispatchToken,
  type EgressMode,
  type EgressUnknownRoute,
} from '@ownware/loom'
import {
  canonicalEgressOrigin,
  type EgressReceiptRepository,
  type ObserveEgressInput,
} from './egress-receipt-store.js'

interface ActiveDispatch extends Omit<
  ObserveEgressInput,
  'observationKey' | 'destinationOrigin' | 'phase' | 'reasonCode'
> {
  readonly requestedOrigin: string
}

function isLiteralLoopback(origin: string): boolean {
  const url = new URL(origin)
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const family = isIP(hostname)
  if (family === 4) return hostname.split('.')[0] === '127'
  return family === 6 && hostname === '::1'
}

function transportForOrigin(origin: string): 'http' | 'https' | 'ws' | 'wss' | 'tcp' | 'tls' {
  const protocol = new URL(origin).protocol
  switch (protocol) {
    case 'http:': return 'http'
    case 'https:': return 'https'
    case 'ws:': return 'ws'
    case 'wss:': return 'wss'
    case 'tcp:': return 'tcp'
    case 'tls:': return 'tls'
    default: throw new Error('Egress transport is unavailable.')
  }
}

/**
 * Per-run Cortex authority for outbound policy and durable receipts.
 *
 * Local-only is deliberately narrow: only platform-owned Fetch mediation to
 * a literal loopback IP is admitted. DNS names (including `localhost`),
 * custom fetch functions and uncontained routes are rejected before the
 * underlying dispatcher is called.
 */
export class RunEgressControl implements EgressControl {
  private readonly active = new Map<string, ActiveDispatch>()

  constructor(
    readonly mode: EgressMode,
    private readonly runId: string,
    private readonly receipts: EgressReceiptRepository,
  ) {}

  async beforeDispatch(request: EgressDispatchRequest): Promise<EgressDispatchToken> {
    const dispatchId = randomUUID()
    const requestedOrigin = canonicalEgressOrigin(
      request.destinationOrigin,
      request.transport,
    )
    const identity: ActiveDispatch = {
      dispatchId,
      runId: this.runId,
      mode: this.mode,
      sourceKind: request.sourceKind,
      sourceRef: request.sourceRef,
      transport: request.transport,
      mediation: request.mediation,
      requestedOrigin,
    }
    if (this.mode === 'local-only' && request.mediation !== 'platform_fetch') {
      await this.observe(identity, {
        observationKey: 'dispatch_blocked',
        destinationOrigin: requestedOrigin,
        phase: 'dispatch_blocked',
        reasonCode: 'local_only_custom_transport',
      })
      throw new EgressBlockedError('local_only_custom_transport')
    }
    if (this.mode === 'local-only' && !isLiteralLoopback(requestedOrigin)) {
      await this.observe(identity, {
        observationKey: 'dispatch_blocked',
        destinationOrigin: requestedOrigin,
        phase: 'dispatch_blocked',
        reasonCode: 'local_only_remote_destination',
      })
      throw new EgressBlockedError('local_only_remote_destination')
    }
    await this.observe(identity, {
      observationKey: 'dispatch_started',
      destinationOrigin: requestedOrigin,
      phase: 'dispatch_started',
      reasonCode: null,
    })
    this.active.set(dispatchId, identity)
    return { dispatchId }
  }

  async responseObserved(
    token: EgressDispatchToken,
    destinationOrigin: string,
  ): Promise<void> {
    const identity = this.requireActive(token)
    const normalized = canonicalEgressOrigin(destinationOrigin)
    if (this.mode === 'local-only' && !isLiteralLoopback(normalized)) {
      await this.observe(identity, {
        observationKey: 'response_remote_blocked',
        destinationOrigin: normalized,
        phase: 'dispatch_blocked',
        reasonCode: 'local_only_remote_destination',
      })
      throw new EgressBlockedError('local_only_remote_destination')
    }
    await this.observe(identity, {
      observationKey: 'response_observed',
      destinationOrigin: normalized,
      phase: 'response_observed',
      reasonCode: null,
    })
    this.active.delete(token.dispatchId)
  }

  async redirectBlocked(
    token: EgressDispatchToken,
    destinationOrigin: string,
  ): Promise<void> {
    const identity = this.requireActive(token)
    const targetOrigin = canonicalEgressOrigin(destinationOrigin)
    const blockedIdentity: ActiveDispatch = {
      ...identity,
      dispatchId: randomUUID(),
      transport: transportForOrigin(targetOrigin),
      requestedOrigin: targetOrigin,
    }
    await this.observe(blockedIdentity, {
      observationKey: 'redirect_blocked',
      destinationOrigin: targetOrigin,
      phase: 'dispatch_blocked',
      reasonCode: 'local_only_redirect',
    })
  }

  async dispatchFailed(token: EgressDispatchToken): Promise<void> {
    const identity = this.requireActive(token)
    await this.observe(identity, {
      observationKey: 'dispatch_failed',
      destinationOrigin: identity.requestedOrigin,
      phase: 'dispatch_failed',
      reasonCode: null,
    })
    this.active.delete(token.dispatchId)
  }

  async routeUnavailable(route: EgressUnknownRoute): Promise<void> {
    const identity: ActiveDispatch = {
      dispatchId: randomUUID(),
      runId: this.runId,
      mode: this.mode,
      sourceKind: route.sourceKind,
      sourceRef: route.sourceRef,
      transport: 'unknown',
      mediation: route.mediation,
      requestedOrigin: '',
    }
    if (this.mode === 'local-only') {
      await this.observe(identity, {
        observationKey: 'dispatch_blocked',
        destinationOrigin: null,
        phase: 'dispatch_blocked',
        reasonCode: 'local_only_route_unavailable',
      })
      throw new EgressBlockedError('local_only_route_unavailable')
    }
    await this.observe(identity, {
      observationKey: 'route_unavailable',
      destinationOrigin: null,
      phase: 'route_unavailable',
      reasonCode: 'route_unavailable',
    })
  }

  private requireActive(token: EgressDispatchToken): ActiveDispatch {
    const identity = this.active.get(token.dispatchId)
    if (identity === undefined) throw new Error('Egress dispatch identity is unavailable.')
    return identity
  }

  private async observe(
    identity: ActiveDispatch,
    observation: Pick<
      ObserveEgressInput,
      'observationKey' | 'destinationOrigin' | 'phase' | 'reasonCode'
    >,
  ): Promise<void> {
    await this.receipts.observe({
      dispatchId: identity.dispatchId,
      runId: identity.runId,
      mode: identity.mode,
      sourceKind: identity.sourceKind,
      sourceRef: identity.sourceRef,
      transport: identity.transport,
      mediation: identity.mediation,
      ...observation,
    })
  }
}
