/**
 * ConnectorsToolProvider — injects the `connectors()` agent tool into
 * a profile's session.
 *
 * The tool exposes two actions: `list_attached` (what does this
 * profile have right now?) and `status` (is X connected?). The
 * `search` action retired 2026-05-12; users add connectors via the
 * chat AbilityRail's +Add or via Profile abilities.
 *
 * Per-session deps:
 *   - `registry`: the kernel's `ConnectorRegistry`. The provider
 *     calls `registry.listForProfile(profile.name)` inside the tool
 *     so each `connectors()` invocation sees the current state.
 *
 * Per architecture doc: the agent has ONE connector-related tool. No
 * `connector_connect`, no `connector_disconnect`. Setup happens in
 * the UI; success comes back to the agent's context as a system
 * message.
 */

import type {
  ConnectorToolProvider,
  ConnectorToolProviderContext,
  ConnectorToolProviderResult,
} from './types.js'
import type { LoadedProfile } from '../../profile/loader.js'
import type { ConnectorRegistry } from '../registry.js'
import { createConnectorsTool } from '../agent-tool.js'

export interface ConnectorsToolProviderOptions {
  readonly registry: ConnectorRegistry
}

export class ConnectorsToolProvider implements ConnectorToolProvider {
  readonly source = 'connectors'

  constructor(private readonly options: ConnectorsToolProviderOptions) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async getToolsForProfile(
    profile: LoadedProfile,
    _ctx: ConnectorToolProviderContext,
  ): Promise<ConnectorToolProviderResult> {
    // Honor the profile's deny list. The `connectors` tool is injected
    // by this provider AFTER the assembler's allow/deny pass runs on
    // built-ins, so without this short-circuit a profile that says
    // `deny: ['connectors']` would still get the tool. Design opts out
    // here — Design is purely local artifact work, no third-party
    // service connections needed in-chat. Other profiles (Ownware /
    // Coder / Marketing) keep the default behaviour.
    if (profile.config.tools.deny.includes('connectors')) {
      return { tools: [], stubs: [] }
    }

    const tool = createConnectorsTool({
      registry: this.options.registry,
      profileId: profile.config.name,
    })

    // The provider contract types `tools` as `readonly Tool[]` where
    // `Tool` defaults to `Tool<Record<string, unknown>>`. Our tool
    // is `Tool<ConnectorsToolInput>` — structurally compatible at
    // runtime (the Loom executor parses inputs from JSON and hands
    // them to the tool's execute) but TS variance treats parameter
    // types as invariant. Cast at the boundary; the tool's own
    // validation guards against malformed input at runtime.
    return {
      tools: [tool as unknown as ConnectorToolProviderResult['tools'][number]],
      stubs: [],
    }
  }
}
