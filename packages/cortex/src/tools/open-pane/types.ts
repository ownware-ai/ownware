/**
 * Types for the `open_pane` cortex tool.
 *
 * The agent calls `open_pane(...)` to drop a typed pane into the
 * user's workspace — a markdown brief, a code snippet, a chrome embed,
 * a chat thread, anything in the pane catalog. Cortex registers the
 * tool per-session with a JSON-Schema `kind` enum narrowed to the
 * profile's `panes.allowedKinds` (slice 3.3 wires this up).
 *
 * This file is the CONTRACT layer (slice 3.2). The tool's
 * `defineTool(...)` body + execute() + per-session registration
 * land in slice 3.3 once the workspace route is fully cut over to
 * the pane substrate.
 *
 * Architecture: the tool lives in cortex (not loom) because it
 * touches the gateway's pane state directly. Loom never knows about
 * the pane substrate — it only sees a custom tool that cortex
 * injected into the session config.
 */

import type {
  PaneConfig,
  PanePlacement,
  PaneKind,
} from '../../gateway/types.js'

/** The agent-facing tool name. Stable; never renamed. */
export const OPEN_PANE_TOOL_NAME = 'open_pane' as const

/**
 * Input the agent passes when calling `open_pane`.
 *
 *   - `config` is required and discriminated by `kind`. The full
 *     `PaneConfig` discriminated union (22 variants) is the schema
 *     the tool advertises by default; per-session registration in
 *     slice 3.3 narrows the `kind` enum to `profile.panes.allowedKinds`.
 *   - `title` overrides the kind-derived default (e.g. "README.md"
 *     instead of "Markdown"). Optional.
 *   - `placement` lets the agent override the profile's default
 *     agent placement for this one call. Optional; usually unset
 *     so the profile's `defaultAgentPlacement` decides.
 *   - `workspaceId` is NOT in the input — the session knows which
 *     workspace it's in; the tool reads it from context. The agent
 *     never specifies a target workspace.
 */
export interface OpenPaneToolInput {
  readonly config: PaneConfig
  readonly title?: string
  readonly placement?: PanePlacement
}

/**
 * Successful result the tool returns to the model. The client's
 * chat-stream watches for this shape and dispatches to the pane
 * store (slice 3.4). The model uses these fields to decide what
 * to say next ("opened README.md, focusing it now").
 */
export interface OpenPaneToolResult {
  readonly status: 'opened'
  readonly paneId: string
  readonly kind: PaneKind
  readonly title: string
  readonly focused: boolean
  /**
   * Echoed placement hint so the client's chat-stream can drive the
   * Dockview layout update without re-deriving. Null when the pane
   * went to the side zone (placement is meaningless there).
   */
  readonly placement: PanePlacement | null
}

/**
 * Failure modes the tool surfaces. The model sees a typed error
 * and can decide to retry, ask the user, or carry on without the
 * pane. Discriminated by `code` so model-side reasoning stays clean.
 */
export type OpenPaneToolFailure =
  | {
      readonly code: 'kind_not_permitted'
      readonly kind: string
      readonly message: string
      readonly allowedKinds: readonly PaneKind[]
    }
  | {
      readonly code: 'invalid_input'
      readonly message: string
    }
  | {
      readonly code: 'workspace_unknown'
      readonly workspaceId: string
      readonly message: string
    }
  | {
      readonly code: 'persist_failed'
      readonly message: string
    }

export interface OpenPaneToolError {
  readonly status: 'failed'
  readonly reason: OpenPaneToolFailure
}

export type OpenPaneToolResponse = OpenPaneToolResult | OpenPaneToolError
