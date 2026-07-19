/**
 * Gateway Types
 *
 * Request/response types for all HTTP endpoints.
 * These are the wire format — what clients send and receive.
 */

import type { CredentialPlacement } from '@ownware/loom'
import type { SafetyLevel } from '../schedules/safety.js'

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

export interface Thread {
  readonly id: string
  readonly profileId: string
  /** Workspace this thread belongs to (null for legacy threads). */
  readonly workspaceId: string | null
  title: string | null
  status: 'active' | 'completed' | 'error'
  messageCount: number
  totalTokens: number
  totalCost: number
  /**
   * Canonical model id last dispatched on this thread (e.g.
   * `claude-sonnet-4-6`). `null` means "no override yet, use the
   * profile's default" — the v1 starting state for new threads.
   *
   * Updated by the run handler on every dispatch so the client's model
   * picker can hydrate to the user's last choice on reload, even
   * after switching mid-conversation. The dropdown precedence is
   * `thread.model ?? profile.model`.
   */
  model: string | null
  readonly createdAt: string
  updatedAt: string
  /** Preview of the last message in this thread. */
  readonly lastMessagePreview: string | null
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export interface Workspace {
  readonly id: string
  readonly name: string
  /** Absolute path on disk. */
  readonly path: string
  readonly status: 'active' | 'archived'
  /** Last profile used (for quick resume). */
  readonly lastProfileId: string | null
  readonly pinned: boolean
  /** Number of currently open tabs in this workspace. */
  readonly tabCount: number
  /**
   * Products enabled in this workspace (product slug array). Drives
   * which surfaces the workspace can host (e.g. `'ownware'`,
   * `'ownware-design'`, `'ownware-marketing'`). Always non-empty;
   * legacy rows backfill to `['ownware']` via migration 032. Stored
   * as a JSON-encoded TEXT column in SQLite. Validated at the write
   * boundary (`UpdateWorkspaceRequestSchema`) against the canonical
   * product catalog (`src/product/manifest.ts`) — unknown slugs are
   * rejected, not persisted.
   */
  readonly activeProducts: readonly string[]
  readonly lastOpenedAt: string
  readonly createdAt: string
  readonly updatedAt: string
}

// ---------------------------------------------------------------------------
// (The product catalog was removed with the legacy desktop shell.)
// ---------------------------------------------------------------------------

export interface WorkspaceDetail extends Workspace {
  /** Profiles used in this workspace + their thread counts. */
  readonly profiles: readonly WorkspaceProfileEntry[]
  /** Active thread count. */
  readonly activeThreads: number
  /** Total thread count. */
  readonly totalThreads: number
}

export interface WorkspaceProfileEntry {
  readonly profileId: string
  readonly threadCount: number
  readonly lastUsedAt: string
}

export interface CreateWorkspaceRequest {
  /** Absolute path to the project folder. */
  readonly path: string
  /** Display name (auto-derived from folder name if omitted). */
  readonly name?: string
  /**
   * When true, the gateway mkdirs the path (recursive) if it doesn't
   * already exist. Default false preserves the strict "path must exist"
   * contract for human-driven workspace creation. Used by features that
   * derive a workspace path programmatically (e.g. Ownware Design's
   * per-design workspaces at `<parent>/.ownware/app/ownware-design/<slug>/`).
   */
  readonly create?: boolean
}

export interface UpdateWorkspaceRequest {
  readonly name?: string
  readonly pinned?: boolean
  readonly status?: 'active' | 'archived'
  /**
   * Replace the workspace's enabled products. Must be non-empty when
   * provided; passing `[]` is rejected. The client sends this when the
   * user enables or disables a product from the Workspace Overview.
   */
  readonly activeProducts?: readonly string[]
}

// ---------------------------------------------------------------------------
// MCP Server (global definition)
// ---------------------------------------------------------------------------

export interface MCPToolMetadata {
  readonly name: string
  readonly description: string
  readonly inputSchema?: Record<string, unknown>
  readonly annotations?: {
    readonly readOnlyHint?: boolean
    readonly destructiveHint?: boolean
    readonly openWorldHint?: boolean
    readonly title?: string
  }
}

export interface MCPServerRecord {
  readonly id: string
  readonly name: string
  readonly transport: 'stdio' | 'sse' | 'http' | 'websocket'
  readonly url: string | null
  readonly command: string | null
  readonly args: readonly string[]
  /**
   * Declared env-var NAMES (keys) with placeholder empty-string values.
   * Real values live in the credential vault. Used for stdio transport
   * — http/sse servers use `headers` instead. Pre-migration-026 rows
   * hydrate as `{}`.
   */
  readonly env: Record<string, string>
  readonly headers: Record<string, string>
  readonly registryId: string | null
  readonly toolCount: number | null
  readonly toolsMetadata: readonly MCPToolMetadata[] | null
  readonly status: 'configured' | 'connected' | 'error'
  readonly error: string | null
  readonly createdAt: string
  readonly updatedAt: string
  /** Profiles that use this server. */
  readonly profileIds?: readonly string[]
}

export interface CreateMCPServerRequest {
  readonly id: string
  readonly name: string
  readonly transport: 'stdio' | 'sse' | 'http' | 'websocket'
  readonly url?: string
  readonly command?: string
  readonly args?: readonly string[]
  /** Env-var NAMES (keys) with placeholder values — see MCPServerRecord. */
  readonly env?: Record<string, string>
  readonly headers?: Record<string, string>
  readonly registryId?: string
}

export interface AssignMCPServerRequest {
  readonly profileId: string
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface DashboardStats {
  readonly activeAgents: number
  readonly todayRuns: number
  readonly todayTokens: number
  readonly todayCost: number
  readonly weekCost: number
  readonly workspaceCount: number
  readonly byProfile: readonly DashboardProfileEntry[]
  readonly byWorkspace: readonly DashboardWorkspaceEntry[]
}

export interface DashboardProfileEntry {
  readonly profileId: string
  readonly runCount: number
  readonly runPercent: number
  readonly weekCost: number
}

export interface DashboardWorkspaceEntry {
  readonly workspaceId: string
  readonly workspaceName: string
  readonly threadCount: number
  readonly weekCost: number
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export interface ThreadMessage {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'tool_result' | 'system' | 'error'
  readonly content: string
  readonly tools?: ToolCallRecord[]
  readonly subAgents?: SubAgentRecord[]
  readonly permissions?: PermissionRecord[]
  /**
   * Credential HITL requests that were emitted during this turn. Same
   * lifecycle shape as permissions — each record may be 'pending'
   * (interrupted before the user responded), 'stored' (user provided a
   * value, `credentialId` points at the vault entry), or 'denied' (user
   * refused or the HITL was cancelled on abort).
   *
   * Values are NEVER persisted. The `credentialId` is the only pointer
   * the row carries; callers must go through the credentials runtime
   * with that id to resolve the actual secret.
   */
  readonly credentials?: CredentialRecord[]
  readonly attachments?: AttachmentMeta[]
  readonly thinking?: string
  /**
   * Token usage reported by the model for this turn.
   *
   * `cacheReadTokens` and `cacheCreationTokens` are persisted alongside
   * `inputTokens` / `outputTokens` (migration 027). They matter for
   * window-fill calculations because the model's context window is
   * consumed by ALL tokens it processes — cached prefix + new input —
   * not just the cache-miss portion. The OpenAI provider in loom
   * intentionally subtracts cached tokens from `inputTokens` for
   * billing correctness; clients that compute window-fill must add
   * them back via the cache fields.
   *
   * Both cache fields are optional for back-compat with pre-027 rows
   * (NULL → undefined → client treats as 0).
   */
  readonly usage?: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
  }
  /**
   * Canonical model id that produced this message (e.g.
   * `claude-sonnet-4-6`, `gpt-5.4`, `kimi-k-2.6`). Set at INSERT time
   * for assistant / system / error rows; `undefined` for user rows
   * (humans don't have a brain badge) and pre-migration-020 rows.
   *
   * Frozen — never UPDATEd. A regenerate creates a new row; the old
   * row's model is preserved as historical record. The renderer
   * reads this directly to draw the per-message model badge above
   * each assistant turn.
   */
  readonly model?: string
  readonly timestamp: string
  /**
   * Ordered turn timeline — what happened, in the order it happened.
   *
   * Live-streamed UIs see events in arrival order and render correctly.
   * The reducer historically flattened a turn into separate `tools[]`,
   * `subAgents[]`, `permissions[]` arrays plus one concatenated `content`
   * string, which destroyed the interleaving (text → tool → text → tool
   * collapsed to "text text" with two trailing tool cards). `parts`
   * preserves the original order so a hydrated transcript renders
   * identically to its live-streamed counterpart.
   *
   * Optional for back-compat: messages written before this field was
   * added load with `parts: undefined` and clients fall back to the
   * legacy "text + trailing tools" layout. New writes always populate
   * it.
   *
   * Cross-references are by stable ID (toolCallId, agentId, requestId)
   * not array index, so reordering or future deduping of the helper
   * arrays cannot break existing parts entries.
   */
  readonly parts?: ReadonlyArray<MessagePart>
}

/**
 * One ordered timeline entry inside a turn.
 *
 * `text` and `thinking` carry their content inline because text segments
 * have no other home. `tool`, `subagent`, and `permission` reference the
 * existing helper arrays by stable ID so the rich record is stored once.
 */
export type MessagePart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'thinking'; readonly text: string }
  | { readonly kind: 'tool'; readonly toolCallId: string }
  | { readonly kind: 'subagent'; readonly agentId: string }
  | { readonly kind: 'permission'; readonly requestId: string }
  | { readonly kind: 'credential'; readonly requestId: string }

/** Lightweight attachment metadata — stored in thread history (NO raw data). */
export interface AttachmentMeta {
  readonly filename: string
  readonly mimeType: string
  readonly sizeBytes?: number
  readonly category: 'image' | 'pdf' | 'notebook' | 'text' | 'binary'
}

export interface ToolCallRecord {
  /**
   * Stable identifier from the original Loom `tool.call.start` event.
   * Used by `MessagePart.kind === 'tool'` to reference this record from
   * the ordered `parts` timeline. Optional for back-compat with rows
   * written before this field was added.
   */
  readonly toolCallId?: string
  readonly name: string
  readonly input: unknown
  readonly output?: string
  readonly isError?: boolean
  readonly durationMs?: number
  readonly startedAt?: string
  /** Rich metadata from tool execution — images (base64), audio paths, URLs, etc.
   *  Not sent to the model, but available for UI rendering and logging. */
  readonly metadata?: Record<string, unknown>
}

export interface SubAgentRecord {
  readonly agentId: string
  readonly profileName: string
  /**
   * Resolved model id this helper ran on. Sourced from the enriched Loom
   * `agent.spawn` event (`event.model`). Lets a multi-agent UI (the fan-out
   * tree) badge each worker with its model — essential when `orchestrate`
   * runs a swarm of mixed models. Optional/back-compat.
   */
  readonly model?: string
  /**
   * Final token usage + cost from the enriched Loom `agent.complete` event.
   * Drives the per-worker token/cost readout. Optional/back-compat (absent
   * for in-flight or pre-enrichment rows).
   */
  readonly usage?: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly costUsd: number
  }
  /**
   * Short human label for the helper (input.name on `agent_spawn`, or the
   * enriched `agent.spawn` event's `task`/`name`). Captured so refresh-
   * hydrated modals can show the helper's title.
   */
  readonly task?: string
  /**
   * The prompt the parent agent sent to the helper (input.prompt on
   * `agent_spawn`). Persisted so the sub-agent modal can render the
   * initial user bubble after a page refresh — live runs parse this
   * from `tool.call.args_delta`, hydration reads it here.
   */
  readonly prompt?: string
  readonly status: 'running' | 'completed' | 'error'
  readonly result?: string
  readonly durationMs?: number
  readonly toolCount?: number
  readonly turnCount?: number
}

export interface PermissionRecord {
  /**
   * Stable identifier from the original Loom `permission.request` event.
   * Used by `MessagePart.kind === 'permission'` to reference this record
   * from the ordered `parts` timeline. Optional for back-compat with
   * rows written before this field was added.
   */
  readonly requestId?: string
  readonly toolName: string
  /**
   * Legacy rows may contain model-authored input. New rows retain an empty
   * object only; callers should render inputSummary instead.
   */
  readonly input?: Record<string, unknown>
  /** Bounded, content-free display summary (for example, "2 input fields"). */
  readonly inputSummary?: string
  /** HMAC identity of the exact tool name + input for run-scoped decisions. */
  readonly operationHash?: string
  readonly reason: string
  readonly decision: 'approved' | 'denied' | 'pending'
  /** Zone level (0-6) if zone system is active */
  readonly zoneLevel?: number
  /** Zone name (safe, workspace, build, network, external, machine, never) */
  readonly zoneName?: string
  /** Human-readable explanation from zone explainer */
  readonly explanation?: string
  /**
   * UI severity tag from the classifier (S3). Drives the permission
   * card's visual styling (info / warn / critical) independent of
   * the zone level. Optional — falls back to deriving severity from
   * the zone name when absent.
   */
  readonly severityTag?: 'info' | 'warn' | 'critical'
  /** Human-readable detail for the severity tag, if present. */
  readonly severityReason?: string
}

/**
 * One credential HITL exchange from a turn, flattened for persistence.
 *
 * Sibling to `PermissionRecord`. The wire contract matches the live
 * `credential.request` / `credential.response` events so the client renders
 * the same `CredentialChatItem` from a hydrated row as it does from live SSE.
 *
 * Security: this record never carries the secret value. The client posts the
 * value straight to the gateway vault and it's discarded client-side.
 * `credentialId` is a vault pointer (e.g. `runtime.<thread>.<VAR>`) — safe
 * to persist and replay. `denied` / `pending` rows have no credentialId.
 *
 * `requestId` is required (unlike `PermissionRecord.requestId?`). The
 * credential flow predates the pre-migration-012 back-compat carveout so
 * every credential record on disk has a stable id; the optionality that
 * permissions needed is noise here.
 */
export interface CredentialRecord {
  readonly requestId: string
  /** Short human name shown on the card ("Admin JWT"). */
  readonly label: string
  /** Where the user can find the value ("DevTools > localStorage > token"). */
  readonly hint: string
  /** What the agent will do with the value. */
  readonly usage: string
  /** How the credential is injected at use time (env / bearer / header / …). */
  readonly placement: CredentialPlacement
  /** True when the tool cannot proceed without a value. */
  readonly isRequired: boolean
  /**
   * `'pending'` — request was emitted but no response arrived before the
   *   turn ended (only happens on flushPartialTurn paths: abort, error,
   *   timeout, shutdown).
   * `'stored'` — user provided a value and the gateway placed it in the
   *   vault; `credentialId` is the pointer.
   * `'denied'` — user refused, skipped, or the HITL was cancelled
   *   (e.g. by the abort handler's `denyAll()`).
   */
  readonly decision: 'pending' | 'stored' | 'denied'
  /** Vault pointer iff `decision === 'stored'`. Never contains the value. */
  readonly credentialId?: string
}


// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/**
 * Rich avatar identity — the single source of truth for how an agent
 * renders anywhere in the UI. Projected straight through from
 * `agent.json` → metadata.avatar. When null, consumers fall back to the
 * legacy icon+color glyph. `bg` may be the literal "brand-gradient" to
 * opt into the Cortex brand treatment.
 */
export interface ProfileAvatarWire {
  readonly bg: string
  readonly fg: string
  readonly accent: string
  readonly symbol: string
}

/** Pixel-character identity config (character editor output). */
export interface ProfilePixelAvatarWire {
  readonly hair: string
  readonly hi: number
  readonly si: number
  readonly ti: number
  readonly face: string
  readonly expr: string
  readonly glasses: string
  readonly facial: string
  readonly headwear: string
  readonly earrings: boolean
  readonly headset: boolean
  readonly blush: boolean
}

/**
 * Where a profile lives on disk.
 *   `builtin` — ships with the app, read-only catalog.
 *   `user`    — the user owns it (created or forked into ~/.ownware/profiles).
 *
 * The client uses this to decide whether to show a "Built-in" pill,
 * disable destructive controls, or surface the "Fork to edit" CTA.
 */
export type ProfileSourceWire = 'builtin' | 'user'

export interface ProfileSummary {
  readonly id: string
  /** Stable slug / key (registry lookup, fork ref, thread binding). */
  readonly name: string
  /**
   * Friendly, human-facing name (e.g. "Alice"). `null` when the profile
   * has no `displayName`; clients fall back to a prettified `name`.
   * Purely additive.
   */
  readonly displayName: string | null
  readonly description: string
  /**
   * Which Ownware product UI hosts this profile.
   * - `'ownware'` (default) — the file/terminal/diff/chat surface; hosts
   *   the 7 Ownware prebuilt profiles + user-authored customs.
   * - `'ownware-design'` / `'ownware-marketing'` / future Ownware-X slugs
   *   — bespoke-surface products with a fixed profile each.
   * The client filters its product-scoped pickers by this field.
   */
  readonly productId: string
  /**
   * True when this profile belongs to a locked first-party vertical
   * (Ownware Coder / Design / Marketing): hidden from the general Profiles
   * library, not forkable or editable. The general Ownware home and all
   * user-authored profiles are `false`. Defaults `false` for every existing
   * profile, so this field is purely additive.
   */
  readonly locked: boolean
  readonly model: string
  readonly tags: string[]
  readonly toolCount: number
  readonly hasSkills: boolean
  readonly hasMcp: boolean
  readonly icon: string | null
  readonly color: string | null
  readonly category: string | null
  /**
   * One-line role / title (e.g. "Data Analyst"). `null` when unset;
   * clients fall back to `category`. Purely additive, display-only.
   */
  readonly role: string | null
  /**
   * Connected-tool slugs from `tools.composio.toolkits` (e.g.
   * `['gmail','slack','hubspot']`), for the "Works with" row. Empty array
   * when none. Purely additive.
   */
  readonly composioToolkits: string[]
  readonly avatar: ProfileAvatarWire | null
  /** Pixel-character config; `null` when none authored (clients derive
   *  one from the name). Purely additive. */
  readonly pixelAvatar: ProfilePixelAvatarWire | null
  /** The agent's grounded "first-hello" — one true line about the user it
   *  read, shown at Meet before they type. `null` on the describe path
   *  (nothing measured to say). Purely additive, display-only. */
  readonly firstHello: string | null
  /** Grounded sample prompts shown as tappable starters in the agent's chat
   *  empty-state (no blank box). Omitted/empty when none. Purely additive. */
  readonly starters?: readonly string[]
  readonly useCount: number
  readonly totalCost: number
  readonly lastUsedAt: string | null
  readonly helperCount: number
  readonly isLive: boolean
  /**
   * Profile role: `agent` (runnable directly, shown in main lobby),
   * `helper` (only invokable as a sub-agent of another profile, hidden
   * from the main lobby by default), or `both`.
   */
  readonly kind: 'agent' | 'helper' | 'both'
  /** Where the profile lives on disk — drives readOnly + delete UX. */
  readonly source: ProfileSourceWire
  /** True when the profile is built-in (cannot be edited or deleted in place). */
  readonly readOnly: boolean
  /**
   * Name of the built-in this profile was forked from, or null if the
   * profile is not a fork (built-in itself, or user-created from scratch).
   */
  readonly forkedFrom: string | null
  /**
   * True iff this is a user fork AND the upstream built-in's content has
   * changed since the fork was taken. Drives the "Update available" badge
   * and "Reset to latest built-in" affordance.
   */
  readonly hasUpdate: boolean
}

/**
 * A helper (sub-agent) attached to a parent profile, with cross-profile
 * fields fully resolved by the gateway. The client renders this without
 * any fakery — icon, color, avatar, model, and abilityCount are real.
 *
 * - `profileRef` set → `inline: false`. Backed by a standalone profile;
 *   clicking the card opens that profile. Subagent-level overrides
 *   (name/description/model) win over the helper profile's defaults.
 * - `profileRef` unset → `inline: true`. The subagent is defined directly
 *   on the parent and has no shared page; values come from the subagent
 *   spec. Tool count is unknown for inline subagents (returned as null).
 */
export interface ProfileHelperResolved {
  readonly profileRef: string | null
  readonly name: string
  readonly description: string
  readonly model: string
  readonly icon: string | null
  readonly color: string | null
  readonly avatar: ProfileAvatarWire | null
  readonly abilityCount: number | null
  readonly accessLevel: string
  readonly inline: boolean
}

export interface ProfileDetail extends ProfileSummary {
  readonly config: unknown  // ProfileConfig (avoid import cycle in wire format)
  readonly soulMd: string | null
  readonly agentsMd: string | null
  readonly skills: Array<{
    name: string
    description: string
    content: string
    /** Whether the skill is loaded into the runtime catalog. */
    active: boolean
  }>
  readonly path: string
  /** Resolved helpers — see ProfileHelperResolved. Always present (may be empty). */
  readonly helpers: ReadonlyArray<ProfileHelperResolved>
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface RunRequest {
  readonly prompt: string
  readonly profileId?: string
  readonly threadId?: string
  readonly workspaceId?: string
  readonly model?: string
  /** File attachments from the client (images, PDFs, notebooks, text files). */
  readonly attachments?: readonly FileAttachmentInput[]
  /**
   * Active context picked from the composer's chips (Slice A5b).
   *
   * - `skills` — skill IDs the user wants the agent to actively follow
   *   for THIS turn. Cortex looks up each skill's body (`profile.skills
   *   [i].content`) and inlines it under an `<active-skills>` block in
   *   the system prompt.
   * - `designSystems` — design-system summaries the user picked. Inlined
   *   verbatim as compact metadata; the agent can still call
   *   `apply_design_system` to load the full tokens if it needs them.
   * - `selection` — most recent click in the prototype iframe's
   *   element-selection bridge (Slice B2.5). Inlined verbatim so the
   *   agent has the selector + outerHTML as an anchor for its next
   *   edit.
   *
   * Rebuilt per-turn — the assembler runs every `/run`, so changing
   * the chip selection between turns takes effect immediately.
   * Purely additive: omitted on legacy callers, no behavior change.
   */
  readonly activeContext?: ActiveContextInput
  /**
   * Per-turn vertical-owned system-prompt extension (Slice B10).
   *
   * Cortex is a passthrough — this string is concatenated into the
   * assembled system prompt without parsing. The Design vertical
   * (client-side) builds its `<design-metadata>` + `<design-brief>`
   * blocks here so cortex stays product-agnostic (Principle 22 — no
   * per-product block names in shared code). Marketing / Coder /
   * future verticals attach their own shapes the same way.
   *
   * Length-capped at the gateway boundary (8 KB) to defend against
   * accidental megabytes. Omitted / empty means "no vertical context
   * this turn."
   */
  readonly systemPromptAppend?: string
  /**
   * Per-run tool safety envelope for an UNATTENDED (scheduled) run. When set,
   * the assembled tool list is filtered to this level and the Session runs
   * with `permissionMode: 'auto'` (headless — no human to answer an `ask`;
   * configured zone policy still applies, and capability is also bounded by
   * the tool filter, mirroring team members). Omitted on
   * interactive / HTTP runs → no behavior change.
   */
  readonly safetyLevel?: SafetyLevel
  /**
   * Scheduling identity for a draft-for-approval run (Slice 8d). When set, each
   * held write/send tool call is parked as an approval tied to this schedule +
   * schedule_run. Omitted on interactive runs.
   */
  readonly approvalScheduleId?: string
  readonly approvalRunId?: string
}

/** Per-turn active context shape. Skills the composer pinned for this
 *  turn. (Design-system + canvas-selection inputs were removed with the
 *  legacy desktop design vertical.) */
export interface ActiveContextInput {
  readonly skills?: readonly ActiveSkillRef[]
}

/** Skill the composer pinned for this turn. Cortex resolves content
 *  from the loaded profile by `id` (which matches `SkillSummary.name`). */
export interface ActiveSkillRef {
  readonly id: string
  readonly name: string
}

/** A file attachment sent by the client. */
export interface FileAttachmentInput {
  /** Original filename (e.g., "screenshot.png", "report.pdf"). */
  readonly filename: string
  /** Base64-encoded file data. */
  readonly data: string
  /** MIME type (e.g., "image/png", "application/pdf"). */
  readonly mimeType: string
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

/**
 * How long an `action: 'always'` grant lasts.
 *
 * - `session` — in-memory expansion only; dies with the session, no disk
 *   write. Equivalent to "remember for the rest of this conversation."
 * - `tool` — persisted to ~/.ownware/permissions/<profile>.json keyed by
 *   the exact tool name. Survives restarts. Equivalent to "always allow
 *   this specific tool from this profile."
 * - `profile` — persisted with toolPattern '*'. Auto-allows any tool at
 *   the granted zone level for this profile. Equivalent to "trust this
 *   profile at this zone level forever."
 *
 * Omitted scope on `action: 'always'` defaults to `tool` — the safest
 * persistent choice (narrow blast radius, survives restart).
 */
export type GrantScope = 'session' | 'tool' | 'profile'

export interface ResumeRequest {
  readonly action: 'approve' | 'deny' | 'always' | 'answer' | 'allow_folder_session'
  readonly answer?: string
  /** Optional: specific request ID (if multiple pending) */
  readonly requestId?: string
  /**
   * Absolute path the user is granting access to for the rest of the
   * session. REQUIRED when `action === 'allow_folder_session'`. The
   * gateway canonicalizes the path (resolves symlinks, dedupes against
   * the workspace + existing grants) and appends it to the session's
   * `additionalWorkspaceRoots`. Future filesystem calls under this
   * directory bypass the boundary check without re-prompting.
   */
  readonly grantPath?: string
  /**
   * How long an `action: 'always'` grant lasts. Ignored for other
   * actions. Defaults to `tool` when `action === 'always'` and scope
   * is omitted.
   */
  readonly scope?: GrantScope
}

// ---------------------------------------------------------------------------
// Tool info
// ---------------------------------------------------------------------------

export interface ToolInfo {
  readonly name: string
  readonly description: string
  readonly category: string
  readonly isReadOnly: boolean
  readonly requiresPermission: boolean
}

// ---------------------------------------------------------------------------
// Model info
// ---------------------------------------------------------------------------

/**
 * Model capability flag. Drives the capability icons in the model picker
 * and advanced routing decisions.
 */
export type ModelCapability =
  | 'vision'       // image input
  | 'pdf'          // PDF input
  | 'tools'        // function/tool calling
  | 'thinking'     // extended thinking / reasoning mode
  | 'streaming'    // token streaming
  | 'cache'        // prompt caching (cost savings on repeat input)
  | 'structured'   // structured JSON output / JSON schema mode
  | 'code_exec'    // native code execution tool
  | 'citations'    // source citations (e.g. Anthropic citations)

/**
 * Marketing/UX tier. A curated signal for "how to recommend this model".
 * `flagship`  — smartest, most expensive, slowest
 * `balanced`  — the default recommendation for most users
 * `fast`      — cheapest + lowest latency
 * `legacy`    — still supported, but a newer version exists
 * `preview`   — pre-release, behavior may change
 */
export type ModelTier = 'flagship' | 'balanced' | 'fast' | 'legacy' | 'preview'

/**
 * Canonical info for a single AI model exposed by the Cortex gateway.
 *
 * The objective facts — `contextWindow`, `maxOutputTokens`,
 * `costPer1kInput`, `costPer1kOutput` — are NOT hand-authored truth. They
 * come from the live snapshots Loom ships (models.dev / OpenRouter) and are
 * merged in by `enrichModel` at serve time. Catalog entries therefore leave
 * them out for any model the snapshot already covers; they are only
 * hand-typed as a fallback for a model the snapshot doesn't know yet.
 *
 * Because of that, all four are OPTIONAL on the wire: absent (or `null` for
 * pricing) means "not known for this model" — the UI renders "—", never "$0"
 * or a fake context size. Pricing is per 1K tokens (input / output).
 */
export interface ModelInfo {
  /** Canonical Loom model ID, e.g. `anthropic:claude-sonnet-4-6`. */
  readonly id: string
  /** Short display name, e.g. `Claude Sonnet 4.6`. */
  readonly name: string
  /** Provider slug: `anthropic` | `openai` | `google`. */
  readonly provider: string
  /** Curated tier — drives the model picker grouping + recommendations. */
  readonly tier: ModelTier
  /** One-line marketing description. Shown under the name in the picker. */
  readonly description: string
  /** Max input tokens. Absent = unknown (no snapshot, no fallback). */
  readonly contextWindow?: number
  /** Max output/completion tokens. Absent = unknown. */
  readonly maxOutputTokens?: number
  /** Input cost per 1K tokens in USD. Absent/`null` = pricing unknown. */
  readonly costPer1kInput?: number | null
  /** Output cost per 1K tokens in USD. Absent/`null` = pricing unknown. */
  readonly costPer1kOutput?: number | null
  /** Capabilities — drives capability icons in the UI. */
  readonly capabilities: readonly ModelCapability[]
  /** Alias strings Loom's router accepts for this model (e.g. `sonnet`). */
  readonly aliases: readonly string[]
  /** Release date (ISO 8601). Used to sort newest first. */
  readonly releaseDate: string
  /** True if this is the default recommendation for its provider. */
  readonly default?: boolean
  /** True if deprecated — UI fades the entry. */
  readonly deprecated?: boolean
  /** Live credential check: does the gateway have a key for this provider? */
  readonly hasCredentials?: boolean
  /**
   * OpenRouter slug (e.g. `deepseek/deepseek-v4-pro`) — the join key into the
   * OpenRouter facts snapshot. Only set on `provider: 'openrouter'` entries;
   * it's how the catalog merge pulls live context/pricing for a model whose
   * canonical id (`openrouter:deepseek-v4-pro`) doesn't match the vendor slug.
   */
  readonly orSlug?: string
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

export interface MCPServerInfo {
  readonly id: string
  readonly name: string
  readonly transport: string
  readonly status: 'configured' | 'connected' | 'error'
  readonly command?: string
  readonly url?: string
  readonly toolCount: number | null
}

// ---------------------------------------------------------------------------
// MCP Marketplace
// ---------------------------------------------------------------------------

export type MCPAuthType = 'none' | 'api-key' | 'oauth2' | 'runtime-setup'

export interface MCPMarketplaceEntry {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly icon: string | null
  readonly category: string
  readonly transport: string
  readonly package: string | null
  readonly runtime: string | null
  readonly remoteUrl: string | null
  readonly repository: string | null
  readonly version: string
  readonly requiredEnv: readonly MCPMarketplaceEnvVar[]
  readonly optionalEnv: readonly MCPMarketplaceEnvVar[]
  /** Whether all required env vars are set (credentials ready) */
  readonly isReady: boolean
  /** How the user authenticates with this server. */
  readonly authType: MCPAuthType
  /**
   * Optional one-line hint shown in the tool detail dialog when the connector
   * has runtime setup beyond credential entry (LinkedIn opens a browser on
   * first tool call; Obsidian needs a running app + REST plugin). Distinct
   * from `description` (what it does) and credential `helpUrl` (where to
   * find a token).
   */
  readonly setupHint?: string | undefined
}

// ---------------------------------------------------------------------------
// MCP OAuth flow
// ---------------------------------------------------------------------------

export interface OAuthStartRequest {
  /** OAuth client ID. Optional when a server preset is configured. */
  readonly clientId?: string
  /** OAuth client secret. Only for confidential clients. */
  readonly clientSecret?: string
  /** Override the default scopes from the preset. */
  readonly scopes?: readonly string[]
}

export interface OAuthStartResponse {
  readonly serverId: string
  /** Full authorize URL — opened automatically; included for manual fallback. */
  readonly authUrl: string
  /** CSRF state token (verified on callback). */
  readonly state: string
  /** Localhost port the callback server bound to. */
  readonly callbackPort: number
  readonly message: string
}

export interface OAuthWaitResponse {
  readonly serverId: string
  readonly status: 'authenticated'
  readonly expiresAt: number
  readonly scope: string | null
  readonly message: string
}

export type OAuthStatus = 'none' | 'pending' | 'authenticated' | 'expired'

export interface OAuthStatusResponse {
  readonly serverId: string
  readonly status: OAuthStatus
  readonly expiresAt?: number
  readonly scope?: string | null
}

export interface MCPMarketplaceEnvVar {
  readonly name: string
  readonly description: string
  readonly isRequired: boolean
  readonly isSecret: boolean
  readonly isSet: boolean
  /**
   * Optional URL where the user can obtain this credential. Rendered as a
   * "Get your {label} →" link below the input.
   */
  readonly helpUrl?: string | undefined
  /**
   * Optional transform hint — when set, clients render a friendlier UI
   * (not the raw env var name) and wrap the user's input before it is
   * submitted. Currently supported: `'notion-headers'`.
   */
  readonly transform?: 'notion-headers' | undefined
}

export interface SaveCredentialsRequest {
  readonly env: Record<string, string>
}

export interface AddMCPToProfileRequest {
  /** Registry server ID (e.g., "io.github.user/weather") */
  readonly serverId: string
}

export interface ProfileMCPStatus {
  readonly serverId: string
  readonly name: string
  readonly transport: string
  readonly status: 'ready' | 'missing_credentials' | 'connected' | 'error'
  readonly toolCount: number | null
  readonly envStatus: readonly MCPMarketplaceEnvVar[]
  readonly isRegistry: boolean
  readonly error?: string
}

// ---------------------------------------------------------------------------
// Profile creation
// ---------------------------------------------------------------------------

export interface CreateProfileRequest {
  readonly name: string
  /**
   * Required since slice-08 of product-base-shift Phase 2 — every
   * profile lives inside a Ownware product, and the client's product
   * registry gates which slugs are user-facing.
   * The cortex schema validates the slug
   * shape (`^[a-z][a-z0-9-]*$`); the client's registry validates
   * membership on read. See [D-36] (cortex doesn't validate slug
   * contents against a closed enum).
   */
  readonly productId: string
  readonly description?: string
  readonly model?: string
  readonly soulMd?: string
  readonly tools?: {
    preset?: string
    deny?: string[]
  }
  readonly security?: {
    level?: string
    permissionMode?: string
  }
}

/**
 * Optional override body on `POST /api/v1/profiles/:id/duplicate`
 * (slice-08). The wire endpoint stays named "duplicate"; the
 * UI surface presents it as "Fork." Two reasons:
 *
 *   • Renaming the route would ripple through every test + consumer
 *     for an identical operation (Principle 4 — one canonical home
 *     per concept).
 *   • The user-facing intent ("fork to customize") is a UX concern,
 *     not a wire concern.
 *
 * When the body is omitted, the endpoint behaves as it did before:
 * auto-name `<id>-copy[-N]`, copy verbatim. When provided, the
 * fields override the new profile's defaults.
 */
export interface DuplicateProfileRequest {
  /**
   * Desired slug for the new profile. Validated for slug grammar
   * and conflict-checked — on conflict the server appends `-2`,
   * `-3`, etc and returns the chosen slug in the response.
   */
  readonly name?: string
  /** New SOUL.md content. When omitted, the source SOUL.md is copied verbatim. */
  readonly soulMd?: string
  /** New description in agent.json. When omitted, the source description is preserved. */
  readonly description?: string
}

export interface UpdateProfileRequest {
  readonly config?: Record<string, unknown>
  readonly soulMd?: string
  readonly agentsMd?: string
}

export interface GenerateProfileRequest {
  readonly purpose: string
  readonly model?: string
}

export interface ProfileFileRequest {
  readonly type: 'soul_md' | 'agents_md' | 'skill'
  readonly content: string
  readonly skillName?: string
}

// ---------------------------------------------------------------------------
// API Error
// ---------------------------------------------------------------------------

export interface ApiError {
  readonly error: string
  readonly message: string
  readonly details?: unknown
}

// ---------------------------------------------------------------------------
// Client Foundation Types
// ---------------------------------------------------------------------------

/** Activity feed entry — recent agent runs, completions, errors. */
export interface ActivityRecord {
  readonly id: string
  readonly profileId: string
  readonly threadId: string | null
  readonly action: string
  readonly summary: string
  readonly timestamp: string
}

/** Universal search result. */
export interface SearchResult {
  readonly type: 'thread' | 'profile' | 'workspace' | 'message'
  readonly id: string
  readonly title: string
  readonly subtitle: string | null
  readonly score: number
}

/** Single KPI card for the dashboard. */
export interface KpiCard {
  readonly label: string
  readonly value: number
  readonly unit: string
  readonly trend: number | null
}

/** Response for GET /api/v1/dashboard/kpis. */
export interface KpiResponse {
  readonly cards: readonly KpiCard[]
}

/** A single time bucket for usage charts. */
export interface UsageBucket {
  readonly date: string
  readonly tokens: number
  readonly cost: number
  readonly runs: number
}

/** Response for GET /api/v1/usage/chart. */
export interface UsageChartResponse {
  readonly buckets: readonly UsageBucket[]
  readonly totalTokens: number
  readonly totalCost: number
}

/** Profile breakdown entry for usage analytics. */
export interface ProfileBreakdownEntry {
  readonly profileId: string
  readonly profileName: string
  readonly runs: number
  readonly tokens: number
  readonly cost: number
  readonly percent: number
}

/** Recent activity entry for dashboard. */
export interface RecentActivityEntry {
  readonly id: string
  readonly profileId: string
  readonly action: string
  readonly summary: string
  readonly timestamp: string
}

// (The desktop pane substrate + workspace-history wire types were removed
// with the legacy desktop shell.)


/** File tree node for workspace browser. */
export interface FileTreeNode {
  readonly name: string
  readonly path: string
  readonly type: 'file' | 'directory'
  readonly children?: readonly FileTreeNode[]
}

/** Provider info for settings page. */
export interface ProviderInfo {
  readonly id: string
  readonly name: string
  readonly hasKey: boolean
  readonly models: readonly string[]
}

/** Full settings response. */
export interface SettingsResponse {
  readonly displayName: string | null
  readonly theme: string
  readonly fontSize: number
  readonly providers: readonly ProviderInfo[]
}

/** Connectivity check result. */
export interface ConnectivityStatus {
  readonly provider: string
  readonly reachable: boolean
  readonly latencyMs: number | null
  readonly error: string | null
}

/** App version info. */
export interface AppVersion {
  readonly version: string
  readonly commit: string | null
  readonly buildDate: string | null
}

/** Local storage stats. */
export interface StorageStats {
  readonly dbSizeBytes: number
  readonly threadCount: number
  readonly messageCount: number
  readonly usageRecordCount: number
}

/** Paginated response wrapper. */
export interface PaginatedResult<T> {
  readonly items: readonly T[]
  readonly total: number
  readonly offset: number
  readonly limit: number
}

/** Local profile — onboarding/display name, NOT login. */
export interface LocalProfile {
  readonly id: string
  readonly displayName: string
  readonly avatarUrl: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** User settings (theme, font size, etc). */
export interface UserSettings {
  readonly id: string
  readonly key: string
  readonly value: string
  readonly updatedAt: string
}

/** Profile metadata (icon, color, category, usage stats). */
export interface ProfileMetadata {
  readonly profileId: string
  readonly icon: string | null
  readonly color: string | null
  readonly category: string | null
  readonly useCount: number
  readonly totalCost: number
  readonly lastUsedAt: string | null
  readonly updatedAt: string
}

// ---------------------------------------------------------------------------
// Dashboard analytics (time-series + KPIs + breakdown)
// ---------------------------------------------------------------------------

/** Time range for dashboard queries. */
export type DashboardRange = '24h' | '7d' | '30d' | '90d'

/** Single KPI card with delta and sparkline for dashboard. */
export interface DashboardKPICard {
  readonly label: string
  readonly value: number
  readonly unit: string
  /** Percentage change vs the previous equivalent period (null if no prior data). */
  readonly delta: number | null
  /** 12 data points for the mini sparkline chart (oldest → newest). */
  readonly sparkline: readonly number[]
}

/** Response for getKPIs. */
export interface DashboardKPIs {
  readonly range: DashboardRange
  readonly cards: readonly DashboardKPICard[]
}

/** Per-profile breakdown row for analytics. */
export interface ProfileBreakdownRow {
  readonly profileId: string
  readonly runs: number
  readonly tokens: number
  readonly cost: number
  readonly avgDurationMs: number | null
  /** Success rate as 0–1 fraction. */
  readonly successRate: number
}

/** Recent completed run entry for dashboard activity feed. */
export interface RecentActivityRow {
  readonly id: string
  readonly profileId: string
  readonly threadId: string | null
  readonly model: string
  readonly totalTokens: number
  readonly costUsd: number
  readonly durationMs: number | null
  readonly success: boolean
  readonly createdAt: string
}

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

/** Activity feed entry — running + recently completed agent threads. */
export interface ActivityEntry {
  readonly id: string
  readonly profileId: string
  readonly threadId: string | null
  readonly workspaceId: string | null
  readonly status: 'running' | 'completed' | 'error' | 'idle'
  readonly title: string | null
  readonly elapsedMs: number | null
  readonly tokens: number
  readonly cost: number
  readonly updatedAt: string
}

/** Response for GET /api/v1/activity. */
export interface ActivityFeedResponse {
  readonly data: readonly ActivityEntry[]
  readonly total: number
  readonly running: number
  readonly idle: number
}

// ---------------------------------------------------------------------------
// Storage + Data export
// ---------------------------------------------------------------------------

/** Response for GET /api/v1/storage/stats. */
export interface StorageStatsResponse {
  readonly dbSizeBytes: number
  readonly threadCount: number
  readonly messageCount: number
  readonly usageRecordCount: number
  readonly eventLogEntries: number
}

/** Response for POST /api/v1/storage/clear-cache. */
export interface ClearCacheResponse {
  readonly cleared: {
    readonly eventLogs: number
    readonly oldUsage: number
  }
}

/** Response for POST /api/v1/data/export. */
export interface DataExportResponse {
  readonly threads: readonly Thread[]
  readonly messages: Record<string, readonly ThreadMessage[]>
  readonly workspaces: readonly Workspace[]
  readonly settings: readonly UserSettings[]
  readonly usage: {
    readonly totalTokens: number
    readonly totalCost: number
    readonly recordCount: number
  }
  readonly exportedAt: string
}

/** Response for GET /api/v1/dashboard/usage-chart. */
export interface UsageChartFullResponse {
  readonly buckets: readonly UsageBucket[]
  readonly peak: {
    readonly tokens: number
    readonly cost: number
    readonly runs: number
  }
  readonly total: {
    readonly tokens: number
    readonly cost: number
    readonly runs: number
  }
}

/** App-level key-value state. */
export interface AppState {
  readonly key: string
  readonly value: string
  readonly updatedAt: string
}

/** Audit log entry. */
export interface AuditLogEntry {
  readonly id: string
  readonly action: string
  readonly entityType: string
  readonly entityId: string | null
  readonly detail: string | null
  readonly ipAddress: string | null
  readonly createdAt: string
}

// ---------------------------------------------------------------------------
// Agent Teams (the team vertical) — wire types re-exported so a client's
// types barrel can reach them through the same gateway-types door
// every other wire shape uses. Source of truth: ../team/schema.ts.
// ---------------------------------------------------------------------------

export type {
  Team,
  TeamFragments,
  TeamMember,
  TeamRun,
  TeamRunReceipt,
  TeamRunStatus,
  TeamSummary,
  TeamTask,
  TeamTaskKind,
  TeamTaskStatus,
  BoardView,
} from '../team/schema.js'
