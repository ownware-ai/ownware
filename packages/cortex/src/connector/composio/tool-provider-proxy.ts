/**
 * ComposioToolProviderProxy — stable connector-tool provider whose
 * inner delegate can be swapped at runtime.
 *
 * Companion to `ComposioSourceProxy`. The `toolProviders` array
 * passed to the session-runner is frozen at gateway boot; to support
 * mid-life credential changes (user adds/clears COMPOSIO_API_KEY via
 * Settings) without restarting, this proxy is registered once and
 * the gateway swaps the inner via `setInner()` whenever the runtime
 * is rebuilt.
 *
 * Inner == null (no COMPOSIO_API_KEY):
 *   - Profiles that declare no Composio toolkits get an empty result.
 *   - Profiles that DO declare toolkits get one stub tool per toolkit
 *     whose description + not-ready payload say exactly what's
 *     missing. Without this, declared toolkits vanished silently —
 *     no boot warning, no assembly trace — which reads as "Composio
 *     is broken" to a first-run user.
 */

import type {
  ConnectorToolProvider,
  ConnectorToolProviderContext,
  ConnectorToolProviderResult,
} from '../providers/types.js'
import type { LoadedProfile } from '../../profile/loader.js'
import { createStubTool } from '../stub-tool.js'
import { buildToolName } from './tool-adapter.js'

export class ComposioToolProviderProxy implements ConnectorToolProvider {
  readonly source = 'composio'
  private inner: ConnectorToolProvider | null = null

  /** Swap the inner provider. Pass `null` to disable. */
  setInner(provider: ConnectorToolProvider | null): void {
    this.inner = provider
  }

  /** Whether a concrete inner is wired right now. */
  hasInner(): boolean {
    return this.inner !== null
  }

  async getToolsForProfile(
    profile: LoadedProfile,
    ctx: ConnectorToolProviderContext,
  ): Promise<ConnectorToolProviderResult> {
    const inner = this.inner
    if (inner === null) {
      const declared = profile.config.tools.composio?.toolkits ?? []
      if (declared.length === 0) return { tools: [], stubs: [] }
      const stubs = declared.map((slug) =>
        createStubTool({
          toolName: buildToolName(slug, 'unavailable'),
          description:
            `${slug} tools via Composio — disabled because COMPOSIO_API_KEY is not set.`,
          connectorId: slug,
          connectorName: slug,
          source: 'composio',
          authMode: {
            mode: 'api_key',
            envVars: [{
              name: 'COMPOSIO_API_KEY',
              description: 'Composio API key (create one at composio.dev)',
              isRequired: true,
              isSecret: true,
            }],
          },
          reason:
            `COMPOSIO_API_KEY is not set. Set it (create a key at composio.dev), ` +
            `then restart — the '${slug}' toolkit will load automatically.`,
        }),
      )
      return { tools: [], stubs }
    }
    return inner.getToolsForProfile(profile, ctx)
  }
}
