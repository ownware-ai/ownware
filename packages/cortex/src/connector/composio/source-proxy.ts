/**
 * ComposioSourceProxy — stable connector-source provider whose inner
 * delegate can be swapped at runtime.
 *
 * The connector registry's source list is built once at gateway boot
 * (`createConnectorHandlers({ additionalSources })`). To support
 * "user adds COMPOSIO_API_KEY via Settings without restarting the
 * gateway," we register this proxy at boot regardless of whether
 * Composio is configured. The gateway swaps the inner provider via
 * `setInner()` whenever the credential value changes.
 *
 * Inner == null → both list methods return `[]`. The registry sees an
 * always-present source that contributes zero rows until credentials
 * land. No `removeSource()` API on the registry is needed.
 *
 * No state of its own beyond the inner reference. Swaps are atomic
 * (single property assignment) — concurrent `listGlobal()` /
 * `listForProfile()` calls in-flight against the previous inner
 * resolve normally; the next call after `setInner(new)` sees the new
 * delegate.
 */

import type { Connector } from '../schema.js'
import type { ConnectorPage, PaginatedConnectorSource } from './source.js'

export class ComposioSourceProxy implements PaginatedConnectorSource {
  readonly name = 'composio'
  private inner: PaginatedConnectorSource | null = null

  /** Swap the inner provider. Pass `null` to disable Composio in this gateway. */
  setInner(provider: PaginatedConnectorSource | null): void {
    this.inner = provider
  }

  /** Whether a concrete inner is wired right now. */
  hasInner(): boolean {
    return this.inner !== null
  }

  async listGlobal(): Promise<Connector[]> {
    const inner = this.inner
    return inner === null ? [] : inner.listGlobal()
  }

  async listForProfile(profileId: string): Promise<Connector[]> {
    const inner = this.inner
    return inner === null ? [] : inner.listForProfile(profileId)
  }

  /**
   * Paginated read. Returns an empty page when no inner is wired —
   * matches the "no Composio key configured" branch's behaviour for
   * `listGlobal()` so the modal renders cleanly in the
   * pre-configuration state.
   */
  async listPage(params?: {
    readonly search?: string
    readonly cursor?: string
    readonly limit?: number
  }): Promise<ConnectorPage> {
    const inner = this.inner
    if (inner === null) return { items: [], nextCursor: null }
    return inner.listPage(params)
  }
}
