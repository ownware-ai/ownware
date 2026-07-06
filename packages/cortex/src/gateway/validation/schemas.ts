/**
 * Zod validation schemas for all gateway request bodies.
 *
 * Every POST/PUT endpoint validates its body through these schemas.
 * Schemas are strict — unknown keys are rejected.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export const CreateThreadSchema = z.object({
  profileId: z.string().min(1),
  title: z.string().optional(),
  workspaceId: z.string().optional(),
}).strict()

export const UpdateThreadSchema = z.object({
  title: z.string().nullable().optional(),
  status: z.enum(['active', 'completed', 'error']).optional(),
  /**
   * Canonical model id for this thread. Persisted by the model picker
   * onChange — fires immediately, not waiting for the next /run, so a
   * pick survives a refresh even without sending a message. Empty
   * string is rejected; pass `null` to clear back to "use profile
   * default" semantics. Run handler still does its own setThreadModel
   * on dispatch — both writers converge on the same column, idempotent.
   */
  model: z.string().min(1).nullable().optional(),
}).strict()

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export const CreateWorkspaceSchema = z.object({
  path: z.string().min(1),
  name: z.string().optional(),
}).strict()

export const UpdateWorkspaceSchema = z.object({
  name: z.string().optional(),
  pinned: z.boolean().optional(),
  status: z.enum(['active', 'archived']).optional(),
}).strict()

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export const RunRequestSchema = z.object({
  prompt: z.string().min(1),
  profileId: z.string().optional(),
  threadId: z.string().optional(),
  workspaceId: z.string().optional(),
  model: z.string().optional(),
  attachments: z.array(z.object({
    filename: z.string().min(1),
    data: z.string().min(1),
    mimeType: z.string().min(1),
  })).optional(),
}).strict()

export const ResumeRequestSchema = z.object({
  action: z.enum(['approve', 'deny', 'always', 'answer']),
  answer: z.string().optional(),
  requestId: z.string().optional(),
}).strict()

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export const CreateProfileSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  model: z.string().optional(),
  soulMd: z.string().optional(),
  tools: z.object({
    preset: z.string().optional(),
    deny: z.array(z.string()).optional(),
  }).optional(),
  security: z.object({
    level: z.string().optional(),
    permissionMode: z.string().optional(),
  }).optional(),
}).strict()

export const UpdateProfileSchema = z.object({
  config: z.record(z.unknown()).optional(),
  soulMd: z.string().optional(),
  agentsMd: z.string().optional(),
}).strict()

export const GenerateProfileSchema = z.object({
  purpose: z.string().min(1),
  model: z.string().optional(),
}).strict()

export const ProfileFileSchema = z.object({
  type: z.enum(['soul_md', 'agents_md', 'skill']),
  content: z.string().min(1),
  skillName: z.string().optional(),
}).strict()

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

export const CreateMCPServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  transport: z.enum(['stdio', 'sse', 'http', 'websocket']),
  url: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  headers: z.record(z.string()).optional(),
  registryId: z.string().optional(),
}).strict()

export const SaveCredentialsSchema = z.object({
  env: z.record(z.string()),
}).strict()

export const AddMCPToProfileSchema = z.object({
  serverId: z.string().min(1),
}).strict()

// ---------------------------------------------------------------------------
// Local Profile
// ---------------------------------------------------------------------------

export const CreateLocalProfileSchema = z.object({
  displayName: z.string().min(1).max(100),
  avatarUrl: z.string().url().optional(),
}).strict()

export const UpdateLocalProfileSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  avatarUrl: z.string().url().nullable().optional(),
}).strict()

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const SetSettingSchema = z.object({
  key: z.string().min(1).max(100),
  value: z.string(),
}).strict()

// ---------------------------------------------------------------------------
// Provider Keys
// ---------------------------------------------------------------------------

export const SetProviderKeySchema = z.object({
  providerId: z.string().min(1),
  apiKey: z.string().min(1),
}).strict()

// ---------------------------------------------------------------------------
// Profile Metadata
// ---------------------------------------------------------------------------

export const SetProfileMetadataSchema = z.object({
  icon: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
}).strict()

// (CreateWorkspaceTabSchema / UpdateWorkspaceTabSchema removed in
//  slice 1b.9 — workspace_tabs was dropped in migration 025; the
//  canonical pane store schemas live in the Workspace Panes section
//  below.)

// ---------------------------------------------------------------------------
// Workspace Panes
// ---------------------------------------------------------------------------
//
// Discriminated `PaneConfig` union mirrors the TypeScript types in
// `gateway/types.ts`. Both files stay in sync — the type IS the
// schema's shape. Adding a kind = add a TS variant + a Zod entry here.
//
// The pane substrate supersedes `workspace_tabs`. See gateway/types.ts
// for the full architectural story.

/**
 * Canonical list of every `PaneKind` the substrate persists. The
 * `PaneConfigSchema` discriminated union below MUST stay in sync with
 * this list — adding a kind = add the entry here AND a variant below.
 *
 * Exposed as a const tuple so consumers (e.g. `ProfilePanePolicy`'s
 * `allowedKinds` schema in `profile/schema.ts`) can reference the
 * single source of truth for valid kind names.
 */
export const PANE_KINDS = [
  'chat',
  'markdown',
  'code',
  'image',
  'url',
  'html',
  'mermaid',
  'pdf',
  'video',
  'audio',
  'csv',
  'diff',
  'txt',
  'json',
  'terminal',
  'files',
  'tasks',
  'plan',
  'chrome',
  '3d',
  'notebook',
  'scratchpad',
] as const

export const PaneKindSchema = z.enum(PANE_KINDS)

const PaneSourceSchema = z.discriminatedUnion('origin', [
  z.object({ origin: z.literal('path'), path: z.string().min(1) }).strict(),
  z.object({ origin: z.literal('url'), url: z.string().url() }).strict(),
  z.object({ origin: z.literal('inline'), content: z.string() }).strict(),
])

const PaneSourceUrlSchema = z.object({
  origin: z.literal('url'),
  url: z.string().url(),
}).strict()

/**
 * The discriminated `PaneConfig` union. New kinds extend this list and
 * the matching TS union in `types.ts`. The client's pane registry decides
 * whether to render a kind; the gateway always stores it.
 */
export const PaneConfigSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('chat'),
    profileId: z.string().min(1),
    threadId: z.string().min(1),
  }).strict(),
  z.object({ kind: z.literal('markdown'), source: PaneSourceSchema }).strict(),
  z.object({
    kind: z.literal('code'),
    source: PaneSourceSchema,
    language: z.string().min(1).max(40).optional(),
    filename: z.string().min(1).max(200).optional(),
  }).strict(),
  z.object({
    kind: z.literal('image'),
    source: PaneSourceSchema,
    alt: z.string().max(280).optional(),
  }).strict(),
  z.object({ kind: z.literal('url'), source: PaneSourceUrlSchema }).strict(),
  z.object({ kind: z.literal('html'), source: PaneSourceSchema }).strict(),
  z.object({ kind: z.literal('mermaid'), source: PaneSourceSchema }).strict(),
  z.object({ kind: z.literal('pdf'), source: PaneSourceSchema }).strict(),
  z.object({ kind: z.literal('video'), source: PaneSourceSchema }).strict(),
  z.object({ kind: z.literal('audio'), source: PaneSourceSchema }).strict(),
  z.object({ kind: z.literal('csv'), source: PaneSourceSchema }).strict(),
  z.object({
    kind: z.literal('diff'),
    before: PaneSourceSchema,
    after: PaneSourceSchema,
    language: z.string().min(1).max(40).optional(),
  }).strict(),
  z.object({ kind: z.literal('txt'), source: PaneSourceSchema }).strict(),
  z.object({ kind: z.literal('json'), source: PaneSourceSchema }).strict(),
  z.object({
    kind: z.literal('terminal'),
    cwd: z.string().min(1).optional(),
    shell: z.string().min(1).optional(),
  }).strict(),
  z.object({ kind: z.literal('files'), rootPath: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('tasks'), workspaceId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('plan'), planId: z.string().min(1) }).strict(),
  z.object({
    kind: z.literal('chrome'),
    url: z.string().url(),
    devtools: z.boolean(),
  }).strict(),
  z.object({ kind: z.literal('3d'), source: PaneSourceSchema }).strict(),
  z.object({ kind: z.literal('notebook'), source: PaneSourceSchema }).strict(),
  z.object({ kind: z.literal('scratchpad'), remoteUrl: z.string().url() }).strict(),
])

const PaneAttachmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('database'), databaseId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('connector'), connectorId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('file'), path: z.string().min(1) }).strict(),
])

/**
 * Full PaneMetadata shape — `pinned` and `closeable` are required
 * booleans here. Create requests send a partial via
 * `CreateWorkspacePaneSchema.metadata`; this schema validates the
 * complete persisted shape (server fills defaults before storing).
 */
export const PaneMetadataSchema = z.object({
  openedBy: z.enum(['user', 'agent', 'system']),
  subagentId: z.string().min(1).optional(),
  subagentLabel: z.string().min(1).max(120).optional(),
  scopedToChatId: z.string().min(1).optional(),
  pinned: z.boolean(),
  closeable: z.boolean(),
  attachedTo: PaneAttachmentSchema.optional(),
}).strict()

const PaneZoneSchema = z.enum(['tabs', 'side'])

const PanePlacementSchema = z.union([
  z.literal('split'),
  z.literal('new-tab'),
  z.object({ in: z.string().min(1) }).strict(),
  z.object({ after: z.string().min(1) }).strict(),
])

/**
 * Create a pane in a workspace. Server derives `kind` from
 * `config.kind`, fills `id` / `workspaceId` / `position` / `openedAt`,
 * and applies metadata defaults (`pinned: false`, `closeable: true`,
 * `openedBy: 'user'` unless overridden in `metadata`).
 */
export const CreateWorkspacePaneSchema = z.object({
  zone: PaneZoneSchema.optional(),
  title: z.string().min(1).max(200).optional(),
  config: PaneConfigSchema,
  metadata: PaneMetadataSchema.partial().optional(),
  placement: PanePlacementSchema.optional(),
  focused: z.boolean().optional(),
}).strict()

/**
 * Patch a pane. `focused: true` activates this pane (server clears
 * any other focused pane in the same zone). `focused: false` is
 * rejected — defocus only happens via another pane focusing or this
 * pane closing. At least one field must be provided.
 */
export const UpdateWorkspacePaneSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  position: z.number().int().min(0).optional(),
  focused: z.literal(true).optional(),
  pinned: z.boolean().optional(),
  scopedToChatId: z.string().min(1).nullable().optional(),
  groupId: z.string().min(1).nullable().optional(),
  config: PaneConfigSchema.optional(),
  metadata: PaneMetadataSchema.partial().optional(),
}).strict().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'At least one field must be provided' },
)

export const ReorderWorkspacePanesSchema = z.object({
  zone: PaneZoneSchema,
  ids: z.array(z.string().min(1)).min(1),
}).strict()

/**
 * Set the workspace's layout state. Carries up to two fields:
 *
 *   - `layout` — Dockview-serialized tabs layout. Opaque blob; we
 *     persist and return it verbatim.
 *   - `sideTrackWidth` — px width chosen by the user via the
 *     `<WorkspaceShellSplitter>` drag handle (slice 2 of the
 *     FileViewer redesign). Positive integer, ≤ 5000 px so an
 *     errant client can't push absurd values into storage.
 *
 * Both are individually optional, but the body must contain at
 * least one — empty PATCHes aren't useful and we'd rather 400 than
 * silently no-op.
 */
export const SetWorkspaceLayoutSchema = z.object({
  layout: z.string().optional(),
  sideTrackWidth: z.number().int().positive().max(5000).optional(),
}).strict().refine(
  (d) => d.layout !== undefined || d.sideTrackWidth !== undefined,
  { message: 'at least one of `layout` or `sideTrackWidth` must be provided' },
)

// ---------------------------------------------------------------------------
// App State
// ---------------------------------------------------------------------------

export const SetAppStateSchema = z.object({
  key: z.string().min(1).max(200),
  value: z.string(),
}).strict()

// ---------------------------------------------------------------------------
// Settings (section-based)
// ---------------------------------------------------------------------------

export const SaveSettingsSchema = z.record(z.string()).refine(
  (obj) => Object.keys(obj).length > 0,
  { message: 'At least one setting key is required' },
)

// ---------------------------------------------------------------------------
// Provider Keys (for handler validation)
// ---------------------------------------------------------------------------

export const SaveProviderSchema = z.object({
  provider: z.string().min(1),
  key: z.string().min(1),
}).strict()

export const ValidateProviderSchema = z.object({
  provider: z.string().min(1),
  key: z.string().min(1),
}).strict()

// Speech-to-text dictation: base64 audio in, text out. Audio rides as
// base64-in-JSON (mirrors the attachment wire shape) so it reuses the
// existing JSON client; the router's 10 MB body cap allows ~7 MB of raw
// audio — ample for dictation clips.
export const TranscribeSchema = z.object({
  audio: z.string().min(1),
  mimeType: z.string().min(1),
  language: z.string().min(2).max(10).optional(),
}).strict()

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export const OnboardingRoleSchema = z.object({
  role: z.string().min(1).max(100),
  name: z.string().min(1).max(100).optional(),
}).strict()

export const OnboardingCompleteSchema = z.object({
  profileIds: z.array(z.string()).optional(),
}).strict()
