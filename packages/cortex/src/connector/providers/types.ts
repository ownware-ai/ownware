/**
 * ConnectorToolProvider — vendor-agnostic seam for injecting tools into
 * an assembled agent.
 *
 * Phase 2a generalizes the M1.5 `AssembleOptions.webSearchService`
 * pattern: instead of the assembler knowing about every new source
 * (webSearchService, composioService, imageGenService, ttsService,
 * pipedreamService, ...), it iterates a single list of
 * `ConnectorToolProvider`s. Every future source ships one.
 *
 * Contract:
 *   - `source` is the string that identifies this provider (must match
 *     a `ConnectorSource` enum value when the provider contributes
 *     connectors discoverable via `GET /connectors`; otherwise
 *     arbitrary).
 *   - `getToolsForProfile()` returns the real tools the provider
 *     contributes AND/OR stubs for tools whose connectors are not
 *     ready. Stubs carry `ConnectorNotReadyError` metadata exactly as
 *     M1 specified.
 *   - A provider that THROWS is caught by the assembler; it's logged
 *     and the profile assembles without that provider's tools. One
 *     misbehaving vendor integration must not brick agent assembly.
 *
 * Backward compatibility:
 *   - `AssembleOptions.webSearchService` continues to work. Internally
 *     the assembler wraps it in a `WebSearchToolProvider` and appends
 *     it to the `toolProviders` list. Output is byte-identical to
 *     M1.5 — same tools, same stub metadata, same config.webSearchStrategy.
 */

import type { Tool } from '@ownware/loom'
import type { LoadedProfile } from '../../profile/loader.js'

/**
 * Per-assembly context a provider may use. Deliberately small —
 * providers that need more context (permission store, credential vault)
 * inject those dependencies via their constructor, not through here.
 */
export interface ConnectorToolProviderContext {
  /** Every tool already added to the assembly by earlier steps (presets,
   * allow/deny, custom, MCP, earlier providers). Providers should avoid
   * contributing duplicate names — the assembler dedupes but will throw
   * on hard collisions between two non-stub tools. */
  readonly existingTools: readonly Tool[]
}

export interface ConnectorToolProviderResult {
  /** Real tools the provider contributes (may be empty). */
  readonly tools: readonly Tool[]
  /** Stub tools for provider-connectors that are not ready. Merged after
   * real tools; a real tool with the same name wins. */
  readonly stubs: readonly Tool[]
  /** Optional LoomConfig overlay. Used by web-search to inject
   * `webSearchStrategy`. Applied via Object.assign; keys not understood
   * by Loom's LoomConfig type are tolerated (same pattern as
   * `agentSpawner`/`subagentDefs`). */
  readonly configOverlay?: Readonly<Record<string, unknown>>
  /**
   * If set, replace any existing tool whose name is in this set with
   * the provider's version. Used by web-search to swap the built-in
   * `web_search` tool for a provider-backed implementation (or a stub
   * when not ready). Otherwise, providers MUST NOT shadow existing
   * tool names.
   */
  readonly replaceToolNames?: ReadonlySet<string>
}

export interface ConnectorToolProvider {
  readonly source: string
  getToolsForProfile(
    profile: LoadedProfile,
    ctx: ConnectorToolProviderContext,
  ): Promise<ConnectorToolProviderResult>
}
