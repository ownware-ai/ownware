/**
 * ConnectionCompletionManager — source registry on top of the poller.
 *
 * One `ConnectionPoller` per gateway, but multiple listeners (one per
 * source). The manager routes `dispatch(source, connectionId)` calls
 * to the correct listener. This is the piece every future source
 * plugs into: `manager.registerListener(composioListener)` in 2b,
 * `manager.registerListener(pipedreamListener)` in M4, etc.
 *
 * Webhook-driven sources don't register a listener here; they write
 * terminal rows to the connections store directly from their HTTP
 * handler. The poller is irrelevant for them. Same store, same
 * status-bus, same client UI — different completion trigger.
 */

import type { ConnectorConnectionsStore } from '../connections/store.js'
import type { ConnectorStatusBus } from '../status-bus.js'
import { ConnectionPoller, type PollerConfig } from './poller.js'
import type { ConnectionCompletionListener } from './types.js'

export interface ConnectionCompletionManagerOptions {
  readonly pollerConfig?: Partial<PollerConfig>
}

export class ConnectionCompletionManager {
  private readonly listeners = new Map<string, ConnectionCompletionListener>()
  readonly poller: ConnectionPoller

  constructor(
    private readonly store: ConnectorConnectionsStore,
    statusBus: ConnectorStatusBus,
    opts: ConnectionCompletionManagerOptions = {},
  ) {
    this.poller = new ConnectionPoller(store, statusBus, opts.pollerConfig ?? {})
  }

  /**
   * Register a listener for a single source. Replacing an existing
   * listener is allowed (useful in tests + for live module reload);
   * already-active polls keep running with the OLD listener.
   */
  registerListener(listener: ConnectionCompletionListener): void {
    this.listeners.set(listener.source, listener)
  }

  /**
   * Remove the listener for the given source. Idempotent — no-op when
   * no listener is registered. Already-active polls keep running with
   * the listener they captured at `dispatch()` time; the unregister
   * only affects future dispatches. Used by the gateway when a source
   * is torn down at runtime (e.g. COMPOSIO_API_KEY cleared via Settings).
   */
  unregisterListener(source: string): void {
    this.listeners.delete(source)
  }

  /** True when a listener exists for the given source. */
  hasListener(source: string): boolean {
    return this.listeners.has(source)
  }

  /**
   * Start polling the given connection. Throws when no listener is
   * registered for the row's `source`.
   *
   * The row must already exist in `pending` — callers typically
   * `store.upsertPending()` + `dispatch()` atomically from an
   * HTTP handler or source adapter.
   */
  dispatch(connectionId: string): void {
    const row = this.store.findByConnectionId(connectionId)
    if (!row) {
      throw new Error(
        `ConnectionCompletionManager.dispatch: unknown connectionId "${connectionId}".`,
      )
    }
    const listener = this.listeners.get(row.source)
    if (!listener) {
      throw new Error(
        `ConnectionCompletionManager.dispatch: no listener registered for source "${row.source}". ` +
          `Known sources: ${[...this.listeners.keys()].join(', ') || '(none)'}.`,
      )
    }
    this.poller.register(connectionId, listener)
  }

  /** Cancel polling for a single connection. Idempotent. */
  cancel(connectionId: string): void {
    this.poller.cancel(connectionId)
  }

  /** Cancel every active poll. Called on gateway shutdown. */
  cancelAll(): void {
    this.poller.cancelAll()
  }
}
