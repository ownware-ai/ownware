/**
 * `open_pane` tool — runtime implementation (slice 3.3).
 *
 * The contract layer (slice 3.2c) shipped types + Zod schemas + the
 * `narrowPaneConfigSchema(allowedKinds)` builder. This file adds the
 * Loom `Tool` body the assembler injects per session: a factory
 * `createOpenPaneTool(...)` that closure-captures the gateway state +
 * the active workspace + the profile's pane policy, validates input
 * via the narrowed Zod schema, and persists the new pane through
 * `state.createWorkspacePane(...)`.
 *
 * Architectural rules:
 *   - The tool lives in cortex (not loom) — it touches the gateway
 *     pane state directly. Loom never knows about the pane substrate.
 *   - The tool's `inputSchema` (advertised to the model) is the JSON
 *     Schema Loom requires; Loom's `JsonSchema` is intentionally
 *     restricted (no `oneOf`/`anyOf`/discriminator), so we expose a
 *     flat shape with `kind` enum-filtered to the profile's
 *     `allowedKinds` and describe per-kind required fields in prose.
 *   - Rigorous shape enforcement happens at runtime via
 *     `narrowPaneConfigSchema(allowedKinds)` inside `execute()`. A bad
 *     payload returns a typed `OpenPaneToolError`; the model sees a
 *     tool-result, not a thrown exception.
 *   - Result content is a JSON-stringified `OpenPaneToolResponse`. The
 *     client's chat-stream tap (slice 3.4) parses it back to drive the
 *     pane-list query invalidation.
 *   - `createWorkspacePane` is idempotent on `(workspaceId, threadId)`
 *     for chat panes — the database handles dedup. The tool simply
 *     forwards the call; idempotent re-opens return the existing pane,
 *     which is correct behaviour.
 */

import { defineTool } from '@ownware/loom'
import type { Tool, ToolResult, JsonSchema } from '@ownware/loom'
import { narrowPaneConfigSchema } from './schema.js'
import {
  OPEN_PANE_TOOL_NAME,
  type OpenPaneToolError,
  type OpenPaneToolResponse,
  type OpenPaneToolResult,
} from './types.js'
import type { GatewayState } from '../../gateway/state.js'
import { isChatScopedKind } from '../../gateway/pane-kind-policy.js'
import type {
  PaneConfig,
  PaneKind,
  PaneMetadata,
  PanePlacement,
  PaneZone,
} from '../../gateway/types.js'

/**
 * Per-session dependencies the assembler captures. The `state`
 * reference is the gateway's in-memory facade; `workspaceId` names
 * the workspace the session is attached to (panes always land
 * inside that one workspace — the agent never targets a different
 * workspace).
 */
export interface CreateOpenPaneToolOptions {
  readonly state: GatewayState
  readonly workspaceId: string
  readonly allowedKinds: readonly PaneKind[]
  /**
   * Profile's `panes.defaultAgentPlacement`. Used when the agent
   * does not pass an explicit `placement` in its tool call.
   */
  readonly defaultPlacement: 'split' | 'new-tab'
  /**
   * Thread id this tool instance runs under. When set, every non-chat
   * pane opened by the agent is auto-scoped to the chat pane that
   * owns this thread (`metadata.scopedToChatId = <chatPaneId>`), so
   * the resulting viewer follows the conversation that produced it
   * across tab switches. Chat-kind panes are never auto-scoped — a
   * chat pane scoping to another chat is nonsensical and the user
   * explicitly opens chat tabs as standalone surfaces.
   *
   * The chat pane is resolved fresh at fire time via the gateway
   * state: `state.getWorkspacePanes(workspaceId).find(p =>
   * p.config.kind === 'chat' && p.config.threadId === activeThreadId)`.
   * The pane DB enforces 1:1 thread→chatPane uniqueness, so the
   * lookup is deterministic. If no chat pane exists for this thread
   * yet (rare — typically only at the very first tool call before the
   * client has created the chat tab), the new pane opens unscoped
   * (workspace-wide), which is the safe fallback.
   *
   * Omitted → tool opens unscoped panes. Wave 3a of the
   * workspace-tab-architecture work.
   */
  readonly activeThreadId?: string
}

/**
 * Zone defaulting (rip-dockview Phase F).
 *
 * Post-rip, the client shell shows chat panes in the top tab strip
 * and EVERYTHING ELSE in a single-slot side panel — markdown briefs,
 * code snippets, images, URLs, terminals, file trees, task lists,
 * plans. So the only kind that defaults to the tab strip is `chat`;
 * the rest default to the side. The agent does not pick zones; the
 * kind picks for it.
 */
function zoneForKind(kind: PaneKind): PaneZone {
  return kind === 'chat' ? 'tabs' : 'side'
}

/**
 * Build the Loom `JsonSchema` advertised to the model. Loom's
 * `JsonSchema` doesn't support discriminated unions, so we surface a
 * flat object with the `kind` enum filtered to the profile's
 * `allowedKinds` and describe per-kind required fields in prose.
 * Shape correctness is enforced at runtime via Zod (see `execute`).
 */
function buildInputSchema(allowedKinds: readonly PaneKind[]): JsonSchema {
  return {
    type: 'object',
    properties: {
      config: {
        type: 'object',
        description:
          'The pane configuration, discriminated by `kind`. ' +
          'For content kinds (markdown, code, image, url, html, mermaid, pdf, video, audio, csv, txt, json, 3d, notebook), ' +
          'pass a `source` object: `{ origin: "inline", content: "..." }` to ship the body in the call, ' +
          '`{ origin: "url", url: "https://..." }` to fetch on render, or ' +
          '`{ origin: "path", path: "/abs/path" }` to read from disk (path support varies by kind). ' +
          'For `kind: "chat"`, pass `{ profileId, threadId }`. ' +
          'For `kind: "code"`, optional `language` and `filename` fields tune the highlighter and tab title. ' +
          'For `kind: "image"`, optional `alt` describes the image. ' +
          'For `kind: "diff"`, pass `{ before, after }` (each a source) and optional `language`. ' +
          'For `kind: "url"`, the source must be a `{ origin: "url", url }` (no inline/path). ' +
          'For `kind: "chrome"`, pass `{ url, devtools: boolean }`. ' +
          'For `kind: "scratchpad"`, pass `{ remoteUrl }`. ' +
          'For `kind: "terminal"`, optional `cwd` and `shell`. ' +
          'For `kind: "files"`, pass `{ rootPath }`. ' +
          'For `kind: "tasks"`, pass `{ workspaceId }`. ' +
          'For `kind: "plan"`, pass `{ planId }`.',
        properties: {
          kind: {
            type: 'string',
            enum: [...allowedKinds],
            description:
              'Which pane kind to open. MATCH BY FILE EXTENSION: ' +
              '.md → "markdown", .mmd / .mermaid → "mermaid" (NOT markdown), ' +
              '.json → "json", .txt / .log → "txt", ' +
              '.ts / .tsx / .js / .py / .go / .rs / .css / .html / .sh / .yaml → "code", ' +
              '.png / .jpg / .gif / .webp / .svg → "image", ' +
              'https:// URLs → "url". ' +
              'Only kinds the active profile permits appear in this enum.',
          },
          source: {
            type: 'object',
            description: 'Source descriptor for content kinds.',
            properties: {
              origin: {
                type: 'string',
                enum: ['inline', 'url', 'path'],
                description: 'Where the body comes from.',
              },
              content: {
                type: 'string',
                description: 'Body text when origin is "inline".',
              },
              url: {
                type: 'string',
                description: 'URL to fetch when origin is "url".',
              },
              path: {
                type: 'string',
                description: 'Absolute path when origin is "path".',
              },
            },
            required: ['origin'],
          },
          profileId: { type: 'string', description: 'Profile id (chat panes).' },
          threadId: { type: 'string', description: 'Thread id (chat panes).' },
          language: {
            type: 'string',
            description: 'Language hint for code or diff panes.',
          },
          filename: {
            type: 'string',
            description: 'Filename hint for code panes (drives the tab label).',
          },
          alt: {
            type: 'string',
            description: 'Alt text for image panes.',
          },
          before: {
            type: 'object',
            description: 'Pre-change source for diff panes (same shape as `source`).',
            properties: {
              origin: { type: 'string', enum: ['inline', 'url', 'path'] },
              content: { type: 'string' },
              url: { type: 'string' },
              path: { type: 'string' },
            },
            required: ['origin'],
          },
          after: {
            type: 'object',
            description: 'Post-change source for diff panes (same shape as `source`).',
            properties: {
              origin: { type: 'string', enum: ['inline', 'url', 'path'] },
              content: { type: 'string' },
              url: { type: 'string' },
              path: { type: 'string' },
            },
            required: ['origin'],
          },
          cwd: { type: 'string', description: 'Working directory for terminal panes.' },
          shell: { type: 'string', description: 'Shell binary for terminal panes.' },
          rootPath: { type: 'string', description: 'Root path for files panes.' },
          workspaceId: { type: 'string', description: 'Workspace id for tasks panes.' },
          planId: { type: 'string', description: 'Plan id for plan panes.' },
          devtools: {
            type: 'boolean',
            description: 'Open devtools alongside (chrome panes).',
          },
          remoteUrl: {
            type: 'string',
            description: 'Remote shared scratchpad endpoint (scratchpad panes).',
          },
        },
        required: ['kind'],
      },
      title: {
        type: 'string',
        description:
          'Override the kind-derived default title. Optional; usually the kind-default is fine.',
      },
      placement: {
        type: 'string',
        enum: ['split', 'new-tab'],
        description:
          'Layout hint: "split" opens beside the active group; "new-tab" adds a tab in the active group. ' +
          "Optional — falls back to the profile's default agent placement when omitted.",
      },
    },
    required: ['config'],
  }
}

/**
 * Build the human-readable description shown to the model. Lists the
 * kinds the active profile permits so the model knows what's on
 * offer without having to read the JSON Schema enum.
 */
function buildDescription(allowedKinds: readonly PaneKind[]): string {
  const kindList = allowedKinds.join(', ')
  return (
    'Open a pane in the user\'s workspace — a typed surface for content the model wants the user to see ' +
    '(a markdown brief, a code snippet, a diff, an image, an embedded webpage, a chat thread, etc.). ' +
    'The pane appears alongside the chat as a tab the user can interact with. ' +
    'Use this when the answer is better SHOWN than told — long documents, code, side-by-side comparisons, ' +
    'reference URLs, anything the user benefits from having parked next to the conversation.\n\n' +
    `Permitted kinds for this profile: ${kindList}.\n\n` +
    'CHOOSING THE RIGHT KIND FROM A FILE EXTENSION:\n' +
    '  - `.md` / `.markdown` / `.mdx` → kind: "markdown"\n' +
    '  - `.mmd` / `.mermaid`          → kind: "mermaid"  (Mermaid diagrams; NOT markdown)\n' +
    '  - `.json` / `.json5`           → kind: "json"\n' +
    '  - `.txt` / `.log` / `.text`    → kind: "txt"\n' +
    '  - `.ts` / `.tsx` / `.js` / `.jsx` / `.py` / `.go` / `.rs` / `.java` /\n' +
    '    `.c` / `.cpp` / `.css` / `.html` / `.sh` / `.yaml` / …\n' +
    '                                  → kind: "code"\n' +
    '  - `.png` / `.jpg` / `.gif` / `.webp` / `.svg`\n' +
    '                                  → kind: "image"\n' +
    '  - any `https://` URL the user should browse → kind: "url"\n' +
    'Pick the most specific kind. A `.mmd` file is NEVER kind:"markdown" —\n' +
    'the user sees raw text instead of the rendered diagram.\n\n' +
    'The tool returns the new pane id and metadata; the user sees the pane immediately.'
  )
}

/**
 * Wrap an `OpenPaneToolResponse` in the shape Loom expects from
 * `execute()` — JSON-stringified into `content`, with `isError` set
 * for failures so the run loop and downstream telemetry can branch
 * on it cleanly. `metadata` carries the structured response so
 * client-side parsing has a non-text channel too.
 */
function asToolResult(response: OpenPaneToolResponse): ToolResult {
  return {
    content: JSON.stringify(response),
    isError: response.status === 'failed',
    metadata: { openPane: response },
  }
}

function failure(reason: OpenPaneToolError['reason']): OpenPaneToolError {
  return { status: 'failed', reason }
}

/**
 * Coerce flat-shape inputs into the canonical wrapped shape.
 *
 * The tool's schema wants `{ config: { kind, source, … }, title?, placement? }`,
 * but smaller models (notably GPT-5.4-mini) frequently flatten the
 * nested object and send `{ kind, source, …, title?, placement? }`
 * directly. Rather than fail strict parsing and leave the user staring
 * at a `Required` Zod error, we detect the flat shape and lift every
 * field except `title` and `placement` into `config` before parsing.
 *
 * Inputs that already have a `config` key pass through unchanged.
 * Inputs that are neither flat nor wrapped (e.g. `null`, primitives,
 * arrays, or objects without a string `kind`) also pass through so
 * Zod surfaces a clean error.
 */
function coerceOpenPaneInput(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
  const obj = raw as Record<string, unknown>
  if ('config' in obj) return raw
  if (typeof obj['kind'] !== 'string') return raw

  const { title, placement, ...rest } = obj
  const wrapped: Record<string, unknown> = { config: rest }
  if (title !== undefined) wrapped['title'] = title
  if (placement !== undefined) wrapped['placement'] = placement
  return wrapped
}

/**
 * Create a per-session `open_pane` Tool bound to (state, workspaceId,
 * allowedKinds, defaultPlacement). The assembler calls this once per
 * `assembleAgent()` and pushes the result into the session's tool
 * list. Each session gets its own tool instance — the closure-
 * captured workspaceId + allowedKinds prevents cross-session bleed.
 */
export function createOpenPaneTool(opts: CreateOpenPaneToolOptions): Tool {
  if (opts.allowedKinds.length === 0) {
    throw new Error(
      'createOpenPaneTool: allowedKinds is empty — a profile must permit at least one pane kind to register the tool',
    )
  }

  const { state, workspaceId, allowedKinds, defaultPlacement, activeThreadId } = opts
  const inputSchema = buildInputSchema(allowedKinds)
  const description = buildDescription(allowedKinds)

  // Build the narrowed Zod schema once per tool (per session). Re-
  // building per call is wasted work — the allowed kinds don't change
  // mid-session.
  const narrowedSchema = narrowPaneConfigSchema(allowedKinds)
  const allowedSet: ReadonlySet<PaneKind> = new Set(allowedKinds)

  return defineTool({
    name: OPEN_PANE_TOOL_NAME,
    description,
    category: 'custom',
    isReadOnly: false,
    requiresPermission: false,
    uiDescriptor: {
      kind: 'external-action',
      summary: { verb: 'Opened pane' },
    },
    inputSchema,
    async execute(rawInput): Promise<ToolResult> {
      // 0. Forgiveness pass: smaller models sometimes flatten the
      //    `config` wrapper and pass `{ kind, source, … }` at the root.
      //    Coerce that into the canonical wrapped shape before any
      //    other logic so kind extraction + schema validation both see
      //    the same canonical input.
      const canonical = coerceOpenPaneInput(rawInput)

      // 1. Surface kind_not_permitted explicitly. Doing this BEFORE
      //    schema parsing gives the model a more useful error than a
      //    Zod "invalid discriminator value" message — and matches
      //    the typed `kind_not_permitted` failure variant.
      const kindCandidate =
        typeof canonical === 'object' &&
        canonical !== null &&
        'config' in canonical &&
        typeof (canonical as { config?: unknown }).config === 'object' &&
        (canonical as { config?: { kind?: unknown } }).config !== null
          ? (canonical as { config: { kind?: unknown } }).config.kind
          : undefined
      if (
        typeof kindCandidate === 'string' &&
        !allowedSet.has(kindCandidate as PaneKind)
      ) {
        return asToolResult(
          failure({
            code: 'kind_not_permitted',
            kind: kindCandidate,
            message: `Pane kind '${kindCandidate}' is not permitted for this profile.`,
            allowedKinds,
          }),
        )
      }

      // 2. Validate input via the narrowed Zod schema. This enforces
      //    per-kind shape (e.g. chat needs profileId+threadId, code
      //    needs source, url's source must be origin: 'url', etc.).
      const parsed = narrowedSchema.safeParse(canonical)
      if (!parsed.success) {
        const message = parsed.error.issues
          .map(
            (iss: { path: PropertyKey[]; message: string }) =>
              `${iss.path.join('.') || '(root)'}: ${iss.message}`,
          )
          .join('; ')
        return asToolResult(
          failure({
            code: 'invalid_input',
            message: message.length > 0 ? message : 'Input did not match the open_pane schema.',
          }),
        )
      }

      const input = parsed.data as {
        readonly config: PaneConfig
        readonly title?: string
        readonly placement?: PanePlacement
      }

      // 3. Resolve the workspace.
      const workspace = state.getWorkspace(workspaceId)
      if (!workspace) {
        return asToolResult(
          failure({
            code: 'workspace_unknown',
            workspaceId,
            message: `Workspace '${workspaceId}' is not registered with the gateway.`,
          }),
        )
      }

      // 4. Build pane metadata. The agent always opens panes — never
      //    pinned, always closeable; metadata carries openedBy='agent'
      //    so the UI badges them as agent-opened.
      //
      //    Auto-scope per the kind policy. Kinds declared as
      //    'chat-scoped' in `pane-kind-policy.ts` get their
      //    `metadata.scopedToChatId` set to the chat pane that owns the
      //    running thread; kinds declared as 'workspace-wide' (terminal,
      //    files, chat itself) open unscoped. The policy module is the
      //    single source of truth — when a new pane kind ships, its
      //    scoping is decided in ONE file (the policy), not scattered
      //    across the open_pane tool and the client's Tools dropdown.
      //
      //    Skip when no chat pane exists yet for this thread (very first
      //    tool call before the client created the tab): we'd have no anchor
      //    to scope to, so the pane opens unscoped — the safe fallback,
      //    not an error.
      let scopedToChatId: string | undefined
      if (activeThreadId !== undefined && isChatScopedKind(input.config.kind)) {
        const chatPane = state.getWorkspacePanes(workspaceId).find(
          (p) => p.config.kind === 'chat' && p.config.threadId === activeThreadId,
        )
        if (chatPane !== undefined) {
          scopedToChatId = chatPane.id
        }
      }
      const metadata: PaneMetadata = {
        openedBy: 'agent',
        pinned: false,
        closeable: true,
        ...(scopedToChatId !== undefined ? { scopedToChatId } : {}),
      }

      // 5. Pick the zone from the kind. tabs for content; side for
      //    terminal/files/tasks/plan.
      const zone = zoneForKind(input.config.kind)

      // 6. Persist via the gateway state. Wrapped in a try/catch so an
      //    unexpected DB error becomes a typed persist_failed instead
      //    of an uncaught throw the loop has to coerce into a generic
      //    tool error.
      let pane
      try {
        pane = state.createWorkspacePane(workspaceId, {
          config: input.config,
          metadata,
          zone,
          ...(input.title !== undefined ? { title: input.title } : {}),
          // Always focus the new pane in its zone (rip-dockview Phase F).
          // Tab-strip chat panes obviously auto-focus on open; side-zone
          // panes ALSO auto-focus so the agent's "open this for the
          // user" intent translates into "the user sees it now"
          // immediately. The client's side panel is single-slot and
          // server-state-driven — it displays whatever pane has
          // `focused: true` in its zone — so flipping this here makes
          // multi-pane workflows still work (the previous focused pane
          // becomes one row in the side-panel dropdown for switching
          // back) without any client-side bookkeeping.
          focused: true,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return asToolResult(
          failure({
            code: 'persist_failed',
            message: `Could not persist the pane: ${msg}`,
          }),
        )
      }

      // 7. Echo placement back so the client's chat-stream tap can drive
      //    Dockview's layout decision without re-deriving. Side-zone
      //    panes don't honour placement — return null there.
      const placement: PanePlacement | null =
        zone === 'side' ? null : (input.placement ?? defaultPlacement)

      const result: OpenPaneToolResult = {
        status: 'opened',
        paneId: pane.id,
        kind: pane.kind,
        title: pane.title,
        focused: pane.focused,
        placement,
      }
      return asToolResult(result)
    },
  })
}
