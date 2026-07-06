/**
 * Stub Tool Factory
 *
 * When a profile references a connector that is not ready, the assembler
 * injects a stub Tool into the agent's tool list instead of skipping the
 * tool entirely. The stub:
 *
 *   - Has the same name and JSON Schema as the real tool (when known).
 *     For MCP servers whose tools have not been discovered yet, a
 *     permissive `{}` schema is used and the description is prefixed with
 *     a `[NOT CONNECTED]` marker.
 *   - Reports `isReadOnly: true` so the permission evaluator doesn't
 *     prompt the user before it runs (stubs never touch the outside world).
 *   - On `execute()`, returns a `ToolResult` with `isError: true` and
 *     `metadata` populated with a `ConnectorNotReadyError` payload. The
 *     agent loop surfaces this to the gateway/UI, which uses the
 *     `metadata.kind === 'connector_not_ready'` discriminator to render
 *     an inline "Connect …" card (future client-side work).
 */

import type { Tool, ToolResult } from '@ownware/loom'
import type { JsonSchema } from '@ownware/loom'
import type {
  AuthMode,
  ConnectorNotReadyError,
  ConnectorProviderSummary,
  ConnectorSource,
} from './schema.js'

export interface StubToolSpec {
  /** Tool name the agent invokes. */
  readonly toolName: string
  /** Original tool description, if known. */
  readonly description?: string
  /** Original JSON Schema, if known. Falls back to permissive `{}` schema. */
  readonly inputSchema?: JsonSchema
  /** Connector metadata for the not-ready error payload. */
  readonly connectorId: string
  readonly connectorName: string
  readonly source: ConnectorSource
  readonly authMode: AuthMode
  /** Human-readable reason (e.g. "Credentials not configured"). */
  readonly reason: string
  /**
   * Pluggable-connector extensions. When the underlying connector is
   * backed by one of several providers (e.g. `web_search`), include the
   * active provider metadata and the full available-provider list so
   * the client can render a "Connect or switch provider" card. Omit entirely
   * for non-pluggable connectors — the emitted metadata shape stays
   * byte-for-byte identical to the M1 contract in that case.
   */
  readonly providerId?: string
  readonly providerName?: string
  readonly availableProviders?: readonly ConnectorProviderSummary[]
}

const EMPTY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: true,
}

/**
 * Build a stub Tool for a not-ready connector.
 */
export function createStubTool(spec: StubToolSpec): Tool {
  const description = spec.description
    ? `[NOT CONNECTED] ${spec.description}`
    : `[NOT CONNECTED] ${spec.connectorName} is not yet connected.`

  return {
    name: spec.toolName,
    description,
    inputSchema: spec.inputSchema ?? EMPTY_SCHEMA,
    isReadOnly: true,
    requiresPermission: false,
    category: 'custom',
    async execute(): Promise<ToolResult> {
      const payload: ConnectorNotReadyError = {
        kind: 'connector_not_ready',
        connectorId: spec.connectorId,
        connectorName: spec.connectorName,
        source: spec.source,
        authMode: spec.authMode,
        reason: spec.reason,
        at: new Date().toISOString(),
        ...(spec.providerId !== undefined ? { providerId: spec.providerId } : {}),
        ...(spec.providerName !== undefined ? { providerName: spec.providerName } : {}),
        ...(spec.availableProviders !== undefined
          ? { availableProviders: [...spec.availableProviders] }
          : {}),
      }
      return {
        content: `${spec.connectorName} is not connected: ${spec.reason}`,
        isError: true,
        metadata: payload as unknown as Record<string, unknown>,
      }
    },
  }
}
