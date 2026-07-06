/**
 * Profile Schema — the complete definition of what a Cortex agent IS.
 *
 * Validated with Zod at load time. Every field has a sensible default.
 * Invalid configs fail loudly with clear error messages.
 *
 * Improvements over Python Cortex:
 * - Granular context (not all-or-nothing)
 * - Validated env vars (fail on missing)
 * - Cost enforcement (not just declared)
 * - Tool policy priority is explicit (deny always wins)
 * - Skills can be executable
 * - No deprecated fields
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export const HookSchema = z.object({
  action: z.enum(['log', 'webhook', 'command', 'save_json', 'approve']),
  url: z.string().optional(),
  command: z.string().optional(),
  path: z.string().optional(),
  level: z.enum(['info', 'warn', 'error']).default('info'),
  /**
   * For `approve` only: glob patterns naming which tools require
   * approval (e.g. `["send_*", "shell_execute"]`). Omitted/empty →
   * every tool call in the bucket pauses for approval. Ignored by
   * other actions.
   */
  tools: z.array(z.string()).optional(),
})

export type HookConfig = z.infer<typeof HookSchema>

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

export const MCPServerSchema = z.object({
  transport: z.enum(['stdio', 'sse', 'streamable_http', 'websocket']),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  url: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  headers: z.record(z.string(), z.string()).default({}),
})

export type MCPServerConfig = z.infer<typeof MCPServerSchema>

// ---------------------------------------------------------------------------
// Custom Tool Reference
// ---------------------------------------------------------------------------

export const CustomToolRefSchema = z.object({
  path: z.string(),
  functions: z.array(z.string()).optional(),
})

export type CustomToolRef = z.infer<typeof CustomToolRefSchema>

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Per-profile opt-in for Composio toolkits. Default empty — a profile that
 * does not mention Composio receives zero Composio tools, period.
 *
 * `toolkits` is an array of Composio toolkit slugs (e.g. `"gmail"`,
 * `"slack"`). The slug is resolved against Composio's live `/api/v3/toolkits`
 * catalogue at assembly time (cached briefly per gateway). Pulling the
 * slug into the profile protocol means agents generating their own
 * `agent.json` never need to know about appIds.
 *
 * An unknown slug is NOT a hard config error — assembly continues and
 * the provider emits a `connector_unknown` stub tool so the user sees a
 * clear "this slug does not exist in Composio's catalogue" message
 * instead of a silent drop.
 */
export const ComposioToolsConfigSchema = z.object({
  /**
   * Composio toolkit slugs. Each must be a non-empty string
   * (lowercase alphanumeric plus `-` / `_`).
   * Duplicates are collapsed so downstream assembly never hits the
   * assembler's duplicate-tool-name guard. Trimmed defensively so
   * trailing/leading whitespace in hand-edited `agent.json` files
   * does not silently miss the catalog lookup.
   */
  toolkits: z
    .array(z.string().trim().min(1, 'Composio toolkit slug cannot be empty'))
    .default([])
    .transform((arr) => Array.from(new Set(arr))),
})

export type ComposioToolsConfig = z.infer<typeof ComposioToolsConfigSchema>

export const ToolsConfigSchema = z.object({
  preset: z.enum(['full', 'coding', 'readonly', 'none']).default('full'),
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  custom: z.array(CustomToolRefSchema).default([]),
  mcp: z.record(z.string(), MCPServerSchema).default({}),
  // Per-source opt-in fields. Each source owns its own top-level key —
  // do NOT overload `mcp` for non-MCP platforms (Composio is an OAuth
  // platform, not a transport; cramming it in pollutes the transport
  // enum). Future sources (Arcade, Zapier, Pipedream, …) follow the
  // same shape: `tools.<source>.<source-specific config>` with a
  // zero-tool default. This keeps profile assembly deterministic from
  // `agent.json` alone — no implicit global injection from anywhere.
  composio: ComposioToolsConfigSchema.default({ toolkits: [] }),
})

export type ToolsConfig = z.infer<typeof ToolsConfigSchema>

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  sources: z.array(z.string()).default(['AGENTS.md']),
  autoLearn: z.boolean().default(true),
  isolation: z.enum(['shared', 'per_session', 'per_thread']).default('shared'),
})

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export const SkillsConfigSchema = z.object({
  dirs: z.array(z.string()).default(['skills/']),
  external: z.array(z.string()).default([]),
})

export type SkillsConfig = z.infer<typeof SkillsConfigSchema>

// ---------------------------------------------------------------------------
// Context — granular, not all-or-nothing
// ---------------------------------------------------------------------------

export const ContextConfigSchema = z.object({
  git: z.boolean().default(false),
  os: z.boolean().default(false),
  cwd: z.boolean().default(true),
  datetime: z.boolean().default(true),
  project: z.boolean().default(false),
  modelInfo: z.boolean().default(false),
  contextUsage: z.boolean().default(false),
})

export type ContextConfig = z.infer<typeof ContextConfigSchema>

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export const WorkspaceConfigSchema = z.object({
  mode: z.enum(['cwd', 'managed', 'temp']).default('cwd'),
  isolation: z.enum(['shared', 'per_profile', 'per_run']).default('shared'),
  dirs: z.array(z.string()).default([]),
})

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

export const SandboxConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['local', 'docker', 'modal', 'anthropic']).default('local'),
})

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>

// Zone override — assign specific tools to specific zones
export const ZoneOverrideSchema = z.object({
  /** Glob pattern matching tool name (e.g., "mcp__github__*") */
  tool: z.string(),
  /** Zone level to assign */
  zone: z.enum(['safe', 'workspace', 'build', 'network', 'external', 'machine', 'never']),
  /** Optional reason for the override */
  reason: z.string().optional(),
})

export type ZoneOverrideConfig = z.infer<typeof ZoneOverrideSchema>

// Zone configuration — controls the zone security system
export const ZonesConfigSchema = z.object({
  /** Enable zone-based security classification (default: true) */
  enabled: z.boolean().default(true),
  /** Override the max auto-allow zone threshold for this profile */
  maxAutoZone: z.enum(['safe', 'workspace', 'build', 'network', 'external', 'machine']).optional(),
  /** Override the max ask zone threshold for this profile */
  maxAskZone: z.enum(['safe', 'workspace', 'build', 'network', 'external', 'machine']).optional(),
  /** Tool-specific zone overrides */
  overrides: z.array(ZoneOverrideSchema).default([]),
  /**
   * Cross-call combination detection (S7 of the 2026-05-14 permission redesign).
   *
   * The five default combination rules (exfiltration-prevention,
   * credential-harvesting, shell-after-secrets, dns-exfiltration,
   * clipboard-exfiltration) catch dangerous cross-zone patterns —
   * e.g. "read .env → fetch external URL" — but they also fire on
   * common coding inputs containing the words `authorization`,
   * `token`, `api_key`, etc. False-positive rate is too high for
   * routine developer flows.
   *
   * - 'none' (default): no combination rules fire. The user sees the
   *   prompt for each individual call, judged on its own merits.
   * - 'default-set': enable the bundled five rules. Appropriate for
   *   enterprise / legal / healthcare profiles where cross-call
   *   exfiltration prevention is worth the friction.
   *
   * Severity tag still rides on the per-call classification; only the
   * cross-call detection is gated by this flag.
   */
  combinationRules: z.enum(['none', 'default-set']).default('none'),
})

export type ZonesConfig = z.infer<typeof ZonesConfigSchema>

export const SecurityConfigSchema = z.object({
  level: z.enum(['permissive', 'standard', 'strict', 'paranoid']).default('standard'),
  permissionMode: z.enum(['auto', 'ask', 'deny', 'allowlist']).default('ask'),
  sandbox: SandboxConfigSchema.default({}),
  zones: ZonesConfigSchema.default({}),
  /**
   * How long (ms) to wait for a human response to a permission prompt
   * before auto-denying. Default: 1800000 (30 minutes).
   *
   * With decoupled runs, the agent loop survives SSE disconnects and can
   * wait indefinitely. This timeout prevents a forgotten permission prompt
   * from blocking an agent forever.
   */
  hitlTimeoutMs: z.number().positive().default(30 * 60 * 1000),
})

export type SecurityConfig = z.infer<typeof SecurityConfigSchema>

// ---------------------------------------------------------------------------
// Browser — managed Chrome lifecycle for browser_* tools
// ---------------------------------------------------------------------------
//
// When `autoLaunch: true`, the gateway spawns a Chromium-family browser
// at session-create time (via Loom's `launchChrome`) and injects the
// resulting CDP URL into the session config. The spawned instance uses
// an isolated `--user-data-dir` — the user's real Chrome profile is
// never touched. The gateway owns lifecycle: kill on `deleteThread`
// and on gateway shutdown.
//
// Default is `autoLaunch: false`, so profiles that do NOT declare
// `browser_*` tools pay zero cost (no spawn, no temp dir, no port).
//
// Pinning a port is optional — if omitted, an ephemeral port is chosen.
// Only pin when you need DevTools attach or an external integration.

export const BrowserConfigSchema = z.object({
  /**
   * Launch a managed Chromium when this profile opens a session.
   *
   * Values:
   *   - `"auto"` (default): launch only if the assembled tool set
   *     contains any `browser_*` tool. Profiles that never browse pay
   *     zero cost; profiles that allowlist browser tools get a
   *     launched Chrome with no extra config.
   *   - `true`: always launch, even if no browser tool is present.
   *     Useful for dynamically-added custom tools that connect over CDP.
   *   - `false`: never launch. `browser_*` tools will error with a
   *     "not configured" message if called.
   */
  autoLaunch: z.union([z.boolean(), z.literal('auto')]).default('auto'),
  /** Run invisibly. Default false — user sees the window. */
  headless: z.boolean().default(false),
  /**
   * Pin the CDP port. If omitted, an ephemeral free port is chosen per
   * session. Useful for DevTools attach workflows.
   */
  port: z.number().int().min(1).max(65_535).optional(),
  /**
   * Persistent user-data-dir. If omitted, a fresh temp dir is created
   * per session and removed when the session ends. Set a stable path
   * to preserve login state across sessions.
   */
  userDataDir: z.string().min(1).optional(),
  /**
   * Disable the Chromium sandbox. Only for rootless containers — do
   * not set on a developer machine.
   */
  noSandbox: z.boolean().default(false),
  /** Additional raw Chromium flags. Appended verbatim. */
  extraArgs: z.array(z.string()).default([]),
  /** Total wait window for CDP to answer after spawn, in ms. */
  readyTimeoutMs: z.number().int().min(500).max(120_000).default(15_000),
})

export type BrowserConfig = z.infer<typeof BrowserConfigSchema>

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export const ExecutionConfigSchema = z.object({
  mode: z.enum(['foreground', 'background']).default('foreground'),
  timeout: z.string().default('30m'),
  maxCostUsd: z.number().positive().optional(),
})

export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>

// ---------------------------------------------------------------------------
// Avatar — rich identity block, shared by profiles AND sub-agents
// ---------------------------------------------------------------------------
//
// Declared up here so the Subagent schema below can reference it.
// The client renders a rounded-rect background filled with `bg`, then the
// `symbol` (raw SVG inner markup) painted with `fg`. `accent` is used
// for selection borders and secondary touches. Use `bg: "brand-gradient"`
// for the Cortex brand treatment (violet → teal → rose sweep).

export const ProfileAvatarSchema = z.object({
  /** Background fill. Hex (#RRGGBB) or the literal "brand-gradient". */
  bg: z.string(),
  /** Symbol stroke/fill color. Hex (#RRGGBB). */
  fg: z.string(),
  /** Accent color for selection, secondary UI. Hex (#RRGGBB). */
  accent: z.string(),
  /** Raw SVG inner markup for the symbol, drawn on a 64×64 canvas.
   *  Only a strict allowlist of tags/attributes is rendered. */
  symbol: z.string(),
})

export type ProfileAvatar = z.infer<typeof ProfileAvatarSchema>

// ---------------------------------------------------------------------------
// Subagent
// ---------------------------------------------------------------------------

export const SubagentToolsSchema = z.object({
  preset: z.enum(['full', 'coding', 'readonly', 'none']).optional(),
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
})

// Grant — explicit capability pass-through from parent to spawned child
// at spawn-time. `tools` names MUST exist in the parent's own assembled
// tool set; grants referencing unknown tools fail loudly at resolve time,
// not at call time. This is parameter-passing, NOT implicit inheritance:
// the grant is visible at the subagent declaration site, and the helper
// profile remains self-contained (same helper spawned from a different
// parent simply gets whatever that parent chose to grant).
export const SubagentGrantSchema = z.object({
  tools: z.array(z.string()).default([]),
  /**
   * Skill names (matching SkillDefinition.name) from the parent's own
   * skill set that should be passed down to the spawned child. Each
   * granted skill's full content is inlined into the child's system
   * prompt at resolve time, so the child has the playbook immediately
   * without needing runtime trigger matching. Unknown skill names
   * throw at resolve time — same fail-loud policy as tool grants.
   */
  skills: z.array(z.string()).default([]),
})

export type SubagentGrant = z.infer<typeof SubagentGrantSchema>

export const SubagentSpecSchema = z.object({
  name: z.string(),
  description: z.string(),
  profile: z.string().optional(),
  model: z.string().optional(),
  tools: SubagentToolsSchema.optional(),
  systemPrompt: z.string().optional(),
  /** Tools the parent passes down to this spawned child. See
   *  SubagentGrantSchema. Optional; defaults to no grant. */
  grant: SubagentGrantSchema.optional(),
  /** Optional rich avatar identity for the sub-agent. Same shape as a
   *  top-level profile avatar — consumers render it via AgentAvatar so
   *  helper cards and chips match the parent profile's visual language. */
  avatar: ProfileAvatarSchema.optional(),
})

export type SubagentSpec = z.infer<typeof SubagentSpecSchema>

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

export const CompactionTriggerSchema = z.object({
  type: z.enum(['tokens', 'fraction', 'messages', 'disabled']).default('fraction'),
  threshold: z.number().default(0.80),
})

export const CompactionRetainSchema = z.object({
  type: z.enum(['messages', 'fraction', 'tokens']).default('messages'),
  count: z.number().default(6),
})

/**
 * Tool-result drop — LLM-free microcompaction tier.
 *
 * When enabled, the loop replaces the content of `tool_result` blocks
 * older than `keepRecentTurns` with a short, self-descriptive
 * placeholder once context pressure crosses `triggerFraction`. No model
 * call, no prompt-prefix rewrite, no summary — just a cheap trim that
 * runs BEFORE full compaction and delays it.
 *
 * Default stays `enabled: false` per profile. Opt-in until the
 * behaviour is field-validated across the typical profile mix; silently
 * rewriting what the model sees in older turns is a correctness concern,
 * not a performance-only tweak.
 */
export const ToolResultDropConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Fire when estimated context usage >= this fraction of the window. Default 0.6. */
  triggerFraction: z.number().min(0).max(1).default(0.6),
  /** Keep tool results in the last N user turns untouched. Default 3. */
  keepRecentTurns: z.number().int().min(1).default(3),
  /** Skip tool results smaller than this (bytes). Default 500. */
  minBytesToDrop: z.number().int().min(0).default(500),
  /** Preserve this many chars of the original content as a preview inside the placeholder. Default 150; 0 disables preview. */
  previewBytes: z.number().int().min(0).default(150),
})

export type ToolResultDropConfig = z.infer<typeof ToolResultDropConfigSchema>

/**
 * Browser-aware snapshot compaction (B4b).
 *
 * When enabled, the loop replaces the bodies of `tool_result` blocks
 * whose `metadata.kind === 'browser-snapshot'` has been superseded by
 * a newer snapshot of the same `metadata.targetId`. Pure pattern
 * match on typed metadata — no LLM call, no regex on content.
 *
 * Fires at a LOWER pressure threshold than `toolResultDrop` so a
 * chatty browser session reclaims via supersession before the
 * generic drop fires on unrelated tool results.
 *
 * Default `enabled: false`. Profiles that ship browser tools
 * (`ownware-browser`) flip this to `true`.
 */
export const BrowserSnapshotCompactionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Fire when estimated context usage >= this fraction of the window. Default 0.5. */
  triggerFraction: z.number().min(0).max(1).default(0.5),
  /** Keep this many of the most recent snapshots per tab. Default 1. */
  keepLatestPerTarget: z.number().int().min(0).default(1),
  /** Keep tool results in the last N user turns untouched. Default 1. */
  keepRecentTurns: z.number().int().min(1).default(1),
  /** Skip snapshots smaller than this (bytes). Default 500. */
  minBytesToDrop: z.number().int().min(0).default(500),
})

export type BrowserSnapshotCompactionConfig = z.infer<
  typeof BrowserSnapshotCompactionConfigSchema
>

export const CompactionConfigSchema = z.object({
  strategy: z.enum(['summarize', 'truncate', 'sliding_window', 'hierarchical']).default('summarize'),
  trigger: CompactionTriggerSchema.default({}),
  retain: CompactionRetainSchema.default({}),
  summaryModel: z.string().optional(),
  /** LLM-free microcompaction on old tool_result bodies. Opt-in. */
  toolResultDrop: ToolResultDropConfigSchema.default({}),
  /** Browser-aware snapshot supersession compaction. Opt-in per profile. */
  browserSnapshotCompaction: BrowserSnapshotCompactionConfigSchema.default({}),
})

export type ProfileCompactionConfig = z.infer<typeof CompactionConfigSchema>

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

export const CheckpointConfigSchema = z.object({
  store: z.enum(['memory', 'file', 'postgres', 'none']).default('memory'),
  connectionString: z.string().optional(),
  dir: z.string().optional(),
})

export type CheckpointConfig = z.infer<typeof CheckpointConfigSchema>

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export const HooksConfigSchema = z.object({
  onStart: z.array(HookSchema).default([]),
  onComplete: z.array(HookSchema).default([]),
  onError: z.array(HookSchema).default([]),
  onToolCall: z.array(HookSchema).default([]),
  onToolEnd: z.array(HookSchema).default([]),
  /** Before each model call (every attempt). Observe/inject; cannot block. */
  onModelCall: z.array(HookSchema).default([]),
  /** After each successful model response — the per-call metering moment
   *  (usage, cost, stop reason, tool-call count). Cannot block. */
  onModelEnd: z.array(HookSchema).default([]),
})

export type HooksConfig = z.infer<typeof HooksConfigSchema>

// ---------------------------------------------------------------------------
// Metadata — UI display fields declared by the profile author
// ---------------------------------------------------------------------------
//
// Anything that controls how the profile LOOKS in the UI goes here. This
// is the single source of truth for icon, color, and category — the
// gateway passes the values straight through from `agent.json` with no
// inference. If a profile author wants to change how their agent shows
// up, they edit these fields (or use the profile editor UI, which writes
// to the same fields). Nothing about visual identity should ever be
// hardcoded in the gateway or a UI client — it's all here.

/**
 * Required-secret declaration. Profiles advertise the env-placed credentials
 * their tools need up-front so the client can surface them in the Secrets panel
 * at profile detail time, rather than making the user wait for the first
 * tool call to fail. The agent still prompts via `request_credential` at
 * runtime — this is the opt-in "also show me up front" UX hook.
 */
export const ProfileRequiredSecretSchema = z.object({
  /** Env variable name the credential will be stored under (e.g. "FRED_API_KEY"). */
  variableName: z.string().min(1),
  /** Short user-facing name (e.g. "FRED API key"). */
  label: z.string().min(1),
  /** Where the user can find it (URL / instructions). */
  hint: z.string().default(''),
  /** What the profile will use it for. */
  usage: z.string().default(''),
  /** True when the profile cannot function without this secret. */
  required: z.boolean().default(false),
})

export type ProfileRequiredSecret = z.infer<typeof ProfileRequiredSecretSchema>

/**
 * Pixel-character identity config — a code-only, deterministic avatar
 * (no images). ~13 fields the character editor produces; the
 * renderer turns them into the same pixel portrait everywhere. Indices
 * (hi/si/ti) map to palette arrays in the client; style strings stay loose
 * here (the client clamps unknown/out-of-range values) so this contract
 * doesn't have to track the art vocabulary.
 */
export const PixelAvatarConfigSchema = z.object({
  hair: z.string().default('short'),
  hi: z.number().int().min(0).default(1),
  si: z.number().int().min(0).default(1),
  ti: z.number().int().min(0).default(0),
  face: z.string().default('oval'),
  expr: z.string().default('smile'),
  glasses: z.string().default('none'),
  facial: z.string().default('none'),
  headwear: z.string().default('none'),
  earrings: z.boolean().default(false),
  headset: z.boolean().default(false),
  blush: z.boolean().default(true),
})

export type PixelAvatarConfig = z.infer<typeof PixelAvatarConfigSchema>

export const ProfileMetadataSchema = z.object({
  /** Legacy: single character or emoji shown in the fallback glyph. */
  icon: z.string().optional(),
  /** Legacy: brand hue for the fallback glyph rings + accents. */
  color: z.enum(['violet', 'teal', 'rose', 'slate', 'mix']).default('violet'),
  /** Category label (e.g. "Engineering", "Legal", "Research"). */
  category: z.string().default('General'),
  /**
   * One-line role / title shown under the agent's name (e.g. "Data
   * Analyst", "Outbound & prospecting"). Optional; when absent the UI
   * falls back to `category`. Purely additive — display-only.
   */
  role: z.string().max(120).optional(),
  /** Rich avatar identity — overrides icon/color when present. */
  avatar: ProfileAvatarSchema.optional(),
  /** Pixel-character identity (the character editor output). When present,
   *  it is the agent's face everywhere; otherwise one is derived from the
   *  name. Optional + additive. */
  pixelAvatar: PixelAvatarConfigSchema.optional(),
  /** A grounded one-line "first-hello" the builder writes when it READ the
   *  user (clone/read path) — one true thing about them, shown at Meet before
   *  they type. Omitted on the describe path. Optional + additive. */
  firstHello: z.string().max(280).optional(),
  /** 2–4 grounded sample prompts the builder writes — tappable starters shown
   *  in the agent's chat empty-state so turn 1 is never a blank box. Optional + additive. */
  starters: z.array(z.string().min(1).max(120)).max(5).optional(),
  /** Secrets the profile will ask for via `request_credential`. */
  requiredSecrets: z.array(ProfileRequiredSecretSchema).default([]),
})

export type ProfileMetadata = z.infer<typeof ProfileMetadataSchema>

// ---------------------------------------------------------------------------
// Tool Policies — declarative per-tool input guards
// ---------------------------------------------------------------------------
//
// Where this sits: tool-name gating is handled by `tools.preset` +
// `tools.allow` / `tools.deny` (which tools EXIST). Zones decide
// permission prompts. Policies answer a different question: once a tool
// IS in the profile, which inputs may flow through it?
//
// For shell_execute specifically, these flags feed Loom's
// `validateCommand` under the hood, and Loom's shell-security Level 1
// (irreversible), Level 4 (exfiltration), and Level 5 (sensitive PII)
// floors are ALWAYS enforced — a profile cannot opt out of them.
//
// This schema is a discriminated union keyed on `kind` so adding new
// guard kinds (path, host, etc.) later is additive and typesafe.

export const ShellPolicySpecSchema = z.object({
  kind: z.literal('shell'),
  tool: z.string().min(1),
  allowPrefixes: z.array(z.string()).default([]),
  denyPatterns: z.array(z.string()).default([]),
  allowDangerous: z.boolean().default(false),
  allowInjection: z.boolean().default(false),
})

export type ShellPolicySpec = z.infer<typeof ShellPolicySpecSchema>

export const ToolPolicySpecSchema = z.discriminatedUnion('kind', [
  ShellPolicySpecSchema,
])

export type ToolPolicySpec = z.infer<typeof ToolPolicySpecSchema>

// ---------------------------------------------------------------------------
// Thinking — extended reasoning (Anthropic native)
// ---------------------------------------------------------------------------
//
// Maps 1:1 to Loom's `LoomThinkingConfig`. When `enabled: true`, Anthropic
// models emit a thinking block before the response using `budget_tokens`
// from the API. Budget must be ≥ 1024 and strictly less than `maxTokens`
// (Loom enforces both). OpenAI and Google adapters currently IGNORE this
// field — setting it on a GPT/Gemini profile is a silent no-op until
// those adapters land their own reasoning primitives.

export const ThinkingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Token budget the model may spend on internal reasoning. Min 1024. */
  budgetTokens: z.number().int().min(1024).default(10000),
})

export type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>

// ---------------------------------------------------------------------------
// Cache profile
// ---------------------------------------------------------------------------

/**
 * Controls the session's prompt-cache TTL tier. Maps 1:1 to Loom's
 * `CacheProfile`.
 *
 *   ttl: '5m' (default)  → provider default, 5-minute ephemeral cache.
 *                          Safe for every account; matches pre-existing behaviour.
 *   ttl: '1h'            → 1-hour ephemeral cache. Survives routine
 *                          between-turn pauses (reading, thinking, typing)
 *                          that regularly exceed 5 minutes.
 *
 * Picking '1h' is cost-positive: the provider charges a slightly higher
 * cache-write rate for the 1h tier, but the increased hit rate across
 * pauses more than compensates for profiles used interactively. Profiles
 * that only run short non-interactive bursts can safely stay on '5m'.
 *
 * Non-Anthropic providers ignore the field — the tier is only meaningful
 * to provider implementations that honour cache_control markers.
 */
export const CacheConfigSchema = z.object({
  ttl: z.enum(['5m', '1h']).default('5m'),
})

export type CacheConfig = z.infer<typeof CacheConfigSchema>

// ---------------------------------------------------------------------------
// Pane policy — what the profile's agent + UI can do with the pane substrate
// ---------------------------------------------------------------------------
//
// Per the pane-system DESIGN.md §3.6 and PROFILES.md, each profile
// declares which pane kinds its agent is permitted to open and how
// agent-driven panes default-place themselves. Cortex generates the
// `open_pane` tool's JSON-Schema `kind` enum from `allowedKinds` per
// session — the agent literally cannot emit a disallowed kind because
// the schema rejects it (no silent drop, no runtime gate). The same
// list also drives the user-visible "+" menu in the workspace shell.
//
// Defaults are conservative: chat + markdown only. This way every
// existing profile that doesn't declare a `panes` block continues to
// work (chat tabs + agent-opened markdown summaries), and profiles
// expand the allowlist to match their archetype (Coder gets the full
// list, Frontend gets html/url/etc but not `code`, etc — see
// PROFILES.md profile-by-pane-kind matrix). Adding kinds is additive
// and safe; restricting an existing profile is a careful change.

const PANE_KIND_VALUES = [
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

/**
 * Local enum for pane kinds — kept in sync with `PANE_KINDS` /
 * `PaneKindSchema` in `gateway/validation/schemas.ts`. Both lists
 * are exercised by `tests/unit/schema/panes-policy.test.ts` which
 * asserts they match — an out-of-sync addition fails CI.
 */
const ProfilePaneKindSchema = z.enum(PANE_KIND_VALUES)

/**
 * Sugar for the workspace's "+ → New tab → ..." menu. Each preset
 * is a one-click open of a specific pane kind with author-supplied
 * defaults. For example, the Frontend profile ships with
 * `{ label: 'Live preview', kind: 'chrome', url: '...' }` so users
 * skip the dialog. When the user picks a preset, the client constructs
 * a `CreateWorkspacePaneRequest` from the entries below.
 *
 * `data` is intentionally `unknown` here — each kind's required
 * config fields are validated when the create request hits the
 * gateway (via `PaneConfigSchema`). Keeping this loose at the
 * profile-config layer means new kinds don't require schema
 * gymnastics in the profile spec.
 */
export const ProfilePanePresetSchema = z.object({
  label: z.string().min(1).max(80),
  kind: ProfilePaneKindSchema,
  /** Optional default config fragment merged into the create call. */
  data: z.record(z.string(), z.unknown()).optional(),
}).strict()

export type ProfilePanePreset = z.infer<typeof ProfilePanePresetSchema>

export const ProfilePanePolicySchema = z.object({
  /**
   * Pane kinds this profile's agent + user are permitted to open.
   * Cortex narrows the `open_pane` tool's input schema to this list
   * per session. Any kind not in the list returns a clean validation
   * failure if the agent tries — the agent never silently fails.
   *
   * Default: `['chat', 'markdown']` — the conservative minimum so
   * profiles without a declared policy still work (chat tabs +
   * agent-opened markdown summaries).
   */
  allowedKinds: z
    .array(ProfilePaneKindSchema)
    .default(['chat', 'markdown'])
    .transform((arr) => Array.from(new Set(arr))),

  /**
   * When the agent opens a pane in an active chat, where does the
   * pane go by default?
   *   - `'split'` (recommended) — split to the right of the chat
   *      group; both visible. Best for live-update flows like a
   *      coder editing while the chat shows the diff alongside.
   *   - `'new-tab'` — open as a tab in the active group; user
   *      switches to it. Best for writer/researcher profiles where
   *      single-focus reading dominates.
   */
  defaultAgentPlacement: z.enum(['split', 'new-tab']).default('split'),

  /**
   * Pre-configured "+ → New tab → ..." menu entries for the user.
   * Empty by default — most profiles don't need it. Curated
   * profiles (Frontend, Researcher, Trading) populate this with
   * one-click shortcuts.
   */
  newTabPresets: z.array(ProfilePanePresetSchema).default([]),
}).strict()

export type ProfilePanePolicy = z.infer<typeof ProfilePanePolicySchema>

// ---------------------------------------------------------------------------
// Root Profile Schema
// ---------------------------------------------------------------------------

export const ProfileSchema = z.object({
  // Identity
  // `name` is the stable slug / key: registry lookup, fork reference,
  // sub-agent reference, thread binding. NEVER repurpose it for display —
  // renaming it orphans threads + forks. Use `displayName` for the
  // human-facing name instead.
  name: z.string().min(1).max(128),
  // Friendly, human-facing name shown in the UI (e.g. "Alice"). Optional;
  // when absent the UI falls back to a prettified `name`. Purely additive —
  // does not affect lookup, assembly, or any existing consumer.
  displayName: z.string().max(128).optional(),
  description: z.string().optional(),
  version: z.string().default('0.1.0'),
  tags: z.array(z.string()).default([]),

  // Product binding — which Ownware product UI hosts this profile.
  // Defaults to `'ownware'` (the default product). Specialized products
  // (`'ownware-design'`, `'ownware-marketing'`, future Ownware-X
  // editions) declare their own slug on the profiles they ship. User-
  // authored custom profiles inherit the default — only the Ownware
  // default product accepts custom profiles in v1; specialized products
  // have one fixed profile each (D-19, D-21 in product-base-shift docs).
  productId: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/, 'productId must be a lowercase kebab slug')
    .default('ownware'),

  // Vertical lock. When true, this profile belongs to a locked first-party
  // vertical (e.g. Ownware Coder, Ownware Design, Ownware Marketing): it is
  // hidden from the general Profiles library and cannot be forked or edited
  // by the user. The general Ownware home + user-authored profiles stay
  // `false`. Capability only at this stage — the gateway exposes it; the
  // list-filtering + edit-blocking that consume it land in a later slice.
  locked: z.boolean().default(false),

  // Profile role — controls whether this profile is runnable directly
  // by the user, callable only as a sub-agent of another profile, or both.
  //   agent  → shown in main Profiles lobby, runnable directly
  //   helper → hidden from lobby, only invokable as a sub-agent
  //   both   → shown in lobby AND invokable as a sub-agent
  kind: z.enum(['agent', 'helper', 'both']).default('agent'),

  // UI metadata — how the profile shows up in the client. Authored, not
  // inferred. See ProfileMetadataSchema above.
  metadata: ProfileMetadataSchema.default({}),

  // Model
  model: z.string().default('openai:gpt-5.5'),
  /**
   * Optional small / fast model for one-shot meta-tasks: thread title
   * generation, permission classification, single-turn parsing, etc.
   * Format is the same as `model` (`provider:model-id`).
   *
   * When present, the gateway routes those side-tasks through
   * `Session.querySide(smallFastModel, …)` instead of the main loop's
   * model. A typical pairing: `model: "anthropic:claude-sonnet-4-6"`
   * with `smallFastModel: "anthropic:claude-haiku-4-5"` — each
   * side-task is then ~10–30× cheaper than running it on the main
   * model, and the user-visible thread keeps using the main model for
   * the actual work.
   *
   * When absent, side-tasks fall back to whatever non-LLM default the
   * gateway uses (e.g. plain substring titling). Adding this field is
   * how a profile opts INTO LLM-driven meta-tasks; nothing happens if
   * you don't.
   */
  smallFastModel: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().positive().default(16384),
  maxTurns: z.number().positive().default(100),

  // Tools
  tools: ToolsConfigSchema.default({}),

  // Per-tool input policies (compiled into Loom ToolGuards at assembly)
  policies: z.array(ToolPolicySpecSchema).default([]),

  // System prompt (inline — or loaded from SOUL.md)
  systemPrompt: z.string().optional(),

  // Persistent per-turn reminder. When set, Cortex passes this string
  // through to Loom as `LoomConfig.persistentReminder` / Session option,
  // and Loom injects it as a `<system-reminder>` on every outgoing user
  // message. Loom carries no content of its own — content lives here, in
  // the profile, so Loom stays domain-neutral. Use sparingly: this is for
  // hard guarantees the model must not forget across long sessions (e.g.,
  // a verifier helper pinning "you must end with VERDICT: PASS|FAIL|PARTIAL").
  criticalReminder: z.string().optional(),

  // Memory
  memory: MemoryConfigSchema.default({}),

  // Skills
  skills: SkillsConfigSchema.default({}),

  // Context
  context: ContextConfigSchema.default({}),

  // Workspace
  workspace: WorkspaceConfigSchema.default({}),

  // Security
  security: SecurityConfigSchema.default({}),

  // Execution
  execution: ExecutionConfigSchema.default({}),

  // Browser — managed Chrome lifecycle when tools include browser_*
  browser: BrowserConfigSchema.default({}),

  // Sub-agents
  subagents: z.array(SubagentSpecSchema).default([]),

  // Compaction
  compaction: CompactionConfigSchema.default({}),

  // Checkpoint
  checkpoint: CheckpointConfigSchema.default({}),

  // Hooks
  hooks: HooksConfigSchema.default({}),

  // Extended thinking (Anthropic native; silently ignored by other providers)
  thinking: ThinkingConfigSchema.default({}),

  // Prompt-cache TTL tier (Anthropic native; non-Anthropic providers ignore)
  cache: CacheConfigSchema.default({}),

  /**
   * Pane policy — which pane kinds the agent is allowed to open via
   * `open_pane`, the default placement when it does, and any "+ → New
   * tab" menu presets. See ProfilePanePolicySchema above. Default
   * (`{}`) is the conservative minimum: chat + markdown allowed,
   * 'split' placement, no presets — every profile that doesn't declare
   * a `panes` block keeps working with that baseline.
   */
  panes: ProfilePanePolicySchema.default({
    allowedKinds: ['chat', 'markdown'],
    defaultAgentPlacement: 'split',
    newTabPresets: [],
  }),
})

export type ProfileConfig = z.infer<typeof ProfileSchema>
