/**
 * Profile Assembler
 *
 * THE KEY FILE. Takes a LoadedProfile and produces everything Loom needs
 * to create a Session and run the agent.
 *
 * This replaces Python Cortex's 886-line core/engine.py with ~300 lines.
 * No middleware classes. No framework glue. Direct Loom API calls.
 */

import {
  resolveProvider,
  createDefaultConfig,
  mergeConfig,
  builtinTools,
  filesystemTools,
  shellTools,
  credentialTools,
  agentTools,
  orchestrateTools,
  MemoryCheckpointStore,
  FileCheckpointStore,
  PromptBuilder,
  createToolUsageFragment,
  createSystemFragment,
  createSafetyPrincipleFragment,
  createOutputFragment,
  createCompactionFragment,
  createThinkingFrequencyFragment,
  MCPManager,
  ZoneManager,
  createZoneConfig,
  DEFAULT_COMBINATION_RULES,
  ZONE_NAME_LEVELS,
  compileToolPolicies,
  wrapToolsWithGuards,
} from '@ownware/loom'
import type {
  LoomConfig,
  Tool,
  ProviderAdapter,
  CheckpointStore,
  CompactionConfig,
  CredentialHandle,
  MCPServerConfig as LoomMCPServerConfig,
  ZoneOverride,
  SecurityLevel,
  ToolPolicySpec as LoomToolPolicySpec,
  SystemPromptBlock,
  HookRuntime,
  ReminderInjector,
} from '@ownware/loom'
import type { LoadedProfile } from './loader.js'
import { buildHookBinding, type HookBindingOptions } from './hooks.js'
import { applyToolPolicy } from './tool-policy.js'
import { loadCustomTools } from './custom-tools.js'
import { getGitContext, getOsContext, getDateContext, getProjectContext } from './context.js'
import type { ProfileCompactionConfig, MCPServerConfig as CortexMCPServerConfig } from './schema.js'
import { resolveEnvVarsWithFallback, resolveEnvStringWithFallback } from './env.js'
import { assertProfileIsSupported } from './unsupported.js'
import { permissionStore } from '../permissions/store.js'
import {
  createRememberTool,
  seedFromAgentsMd,
  DEFAULT_MEMORY_TOP_N,
  type MemorySystem,
  type Memory,
} from '../memory/index.js'
import { createPlanTools } from '../plans/index.js'
import { normalizeModelId } from '../gateway/catalog/models/index.js'
import { credentialStore } from '../connector/mcp/credentials.js'
import { createStubTool } from '../connector/stub-tool.js'
import type { AuthMode } from '../connector/schema.js'
import { getFeaturedServers } from '../connector/mcp/featured.js'
import { getOAuthPreset } from '../connector/mcp/oauth-presets.js'
import type { WebSearchService } from '../connector/web-search/service.js'
import type {
  ConnectorToolProvider,
  ConnectorToolProviderResult,
} from '../connector/providers/types.js'
import { WebSearchToolProvider } from '../connector/providers/web-search-provider.js'
import type { ConnectorStatusBus } from '../connector/status-bus.js'
import { attachMCPManagerToStatusBus } from '../connector/mcp/status-bridge.js'
import { PROJECT_CHECKPOINTS_SUBDIR } from '../constants.js'

// ---------------------------------------------------------------------------
// AssembledAgent — everything Loom needs
// ---------------------------------------------------------------------------

export interface AssembledAgent {
  /** Loom config, ready for Session creation */
  readonly config: LoomConfig
  /** All tools merged, filtered, and validated */
  readonly tools: Tool[]
  /**
   * Assembled system prompt as cache-aware blocks.
   *
   * Each block carries an explicit `cacheControl` flag. Consecutive stable
   * slots (tool rules, identity, skills) are grouped into one block with
   * `cacheControl: true`; volatile slots (memory, context, custom) become
   * their own block with `cacheControl: false`. Loom emits one
   * `cache_control: { type: 'ephemeral' }` marker per cache-marked block,
   * up to the 4-marker API cap.
   *
   * Callers that need the flat text form (token counting, debugging,
   * display) should use Loom's `systemPromptToText` helper to join the
   * blocks — never join them by hand, because cache-marker information
   * would be silently lost and downstream cache decisions would be wrong.
   */
  readonly systemPrompt: readonly SystemPromptBlock[]
  /** Resolved provider adapter */
  readonly provider: ProviderAdapter
  /** Checkpoint store (if configured) */
  readonly checkpointStore: CheckpointStore | null
  /**
   * MCP manager (if profile has MCP servers).
   * Consumers must call mcpManager.shutdown() when done to clean up.
   * Null if no MCP servers are configured.
   */
  readonly mcpManager: MCPManager | null
  /**
   * Zone security manager (if zones are enabled).
   * Use zoneManager.asSafetyRule() to plug into PermissionEvaluator.
   * Null if zones are disabled in the profile.
   */
  readonly zoneManager: ZoneManager | null
  /**
   * The subset of `tools` contributed by connector providers
   * (web-search, composio, any future source). Captured here so the
   * run handler can stash an initial `ManagedTools` snapshot for
   * live reconcile to diff against later turns. Names are `Tool.name`;
   * the corresponding `Tool` instances are also present in `tools`.
   *
   * Only tools that came from providers are listed — builtins, MCP,
   * and custom tools never appear here. Empty when no providers
   * contributed anything (e.g. no composio key, no web-search
   * service).
   */
  readonly connectorTools: readonly Tool[]
  /**
   * Lifecycle hook runtime compiled from the profile's `hooks` config
   * (see `profile/hooks.ts`). Null when the profile declares no hooks
   * or `OWNWARE_DISABLE_HOOKS=1` — the no-hook loop path stays identical.
   *
   * Session wiring contract: pass BOTH fields —
   * `new Session({ ..., hooks: hookRuntime, reminders: reminderInjector })`.
   * The runtime emits its outcomes into this exact injector instance;
   * passing one without the other silently drops the model-visible
   * hook feedback loop.
   */
  readonly hookRuntime: HookRuntime | null
  /** The injector `hookRuntime` emits into. Null iff `hookRuntime` is null. */
  readonly reminderInjector: ReminderInjector | null
}

/**
 * Optional dependencies injected at assembly time.
 *
 * `webSearchService` is the connector-layer facade that resolves the
 * active web-search provider (user choice → env → default) and builds
 * the Loom `SearchStrategy` instance for it. Passing the service here
 * is how the assembler flips the `web_search` built-in tool from the
 * M1 "no_provider" stub-path into a live search call.
 *
 * Resolution is deferred: the assembler calls `service.resolve()`
 * once per `assembleAgent()` so a provider switch via
 * `PATCH /connectors/web_search/provider` takes effect on the next
 * session assembled (no process-global strategy freeze).
 *
 * When omitted, behaviour is identical to M1 — the `web_search` tool
 * falls through to its `no_provider` branch. Every in-repo test that
 * was written before M2 still compiles and passes without change.
 */
export interface AssembleOptions {
  /**
   * @deprecated Prefer `toolProviders` with a
   * `WebSearchToolProvider`. Kept for back-compat with every M1.5
   * caller — when present, the assembler wraps it into a
   * `WebSearchToolProvider` and appends it to the provider list
   * automatically. Output is byte-identical to M1.5.
   */
  readonly webSearchService?: WebSearchService
  /**
   * Phase 2a generalization: vendor-agnostic source providers that
   * contribute tools / stubs / config overlays. Each provider's
   * `getToolsForProfile()` is invoked once per `assembleAgent()`.
   *
   * Order is deterministic: the array order you pass is the order the
   * assembler walks. A provider that throws is caught and logged; its
   * contribution is dropped and other providers continue.
   *
   * Every future source (Composio in 2b, image-gen in M3, Pipedream
   * in M4) plugs in through THIS list — no new AssembleOptions field
   * per source.
   */
  readonly toolProviders?: readonly ConnectorToolProvider[]
  /**
   * Credential context visible to the agent at session start.
   *
   * `credentialHandles` names every credential the vault already holds
   * for this session — .env imports PLUS any runtime-stored credentials
   * carried forward across reconnects. Names only, no values.
   *
   * `configVars` carries non-sensitive .env config (PORT, NODE_ENV,
   * etc.) that CAN go into the system prompt as plaintext. Values show
   * up directly so the agent can read them.
   *
   * Omitted → the credentials section is omitted from the prompt.
   */
  readonly credentialContext?: {
    readonly credentialHandles: readonly CredentialHandle[]
    readonly configVars: Readonly<Record<string, string>>
  }
  /**
   * Workspace root for the session. When set, the system prompt's
   * `Working directory`, `Git branch`, and `Project context` lines are
   * resolved against this path instead of the gateway process's cwd.
   * Without it, the agent (and every sub-agent) would describe the
   * gateway's repo in its environment block — a mismatch with where
   * the filesystem tool and terminal actually operate.
   */
  readonly workspacePath?: string | null
  /**
   * Memory system + thread binding for this session.
   *
   * When provided, the assembler:
   *   1. Seeds memories from `profile.agentsMd` if no memories exist
   *      yet for this profile (one-time backward-compat import).
   *   2. Renders the global user identity layer (when populated).
   *   3. Loads top-N ranked memories from `ownware.db` and prepends
   *      them to the system prompt INSTEAD OF the static AGENTS.md.
   *   4. Honours `profile.config.memory.enabled` — when false, no
   *      memories or identity are injected and the `remember` tool
   *      is omitted regardless of `autoLearn`.
   *   5. Honours `profile.config.memory.autoLearn` — when true,
   *      adds the `remember` tool bound to (profileId, threadId)
   *      and denies Loom's write-through `memory_store /
   *      memory_search / memory_forget` to avoid the agent seeing
   *      two memory tool surfaces.
   *
   * `{ disabled: true }` → no database memory, global identity, AGENTS.md
   * fallback or memory tool. Omitted → behaviour is identical to the
   * pre-memory-system code
   * path: AGENTS.md content is used verbatim; no remember tool is
   * exposed; the user_identity table is ignored. This is the safe
   * default for tests that don't exercise the memory feature and
   * for the no-database CLI / direct-Loom callers.
   */
  readonly memory?: {
    readonly system: MemorySystem
    readonly threadId: string
  } | {
    /**
     * Explicit security posture for a caller with no scoped-memory authority.
     * Unlike omission, this suppresses the AGENTS.md compatibility fallback,
     * global identity, and `remember` tool too.
     */
    readonly disabled: true
  }
  /**
   * Connector status bus the gateway wires to the unified
   * `/api/v1/connectors/events` SSE channel. When provided, the
   * assembler subscribes to the live `MCPManager` so every transport
   * close / connect / reconnect transition emits a
   * `connector.status_changed` event with `source: 'mcp'`. Without
   * this wire, MCP server deaths only surfaced on the next tool call
   * (audit #4 / F4.b).
   *
   * Omitted → behaviour identical to the pre-F4.b code path. Tests,
   * CLI, and any direct-Loom caller that doesn't run inside the
   * gateway leave it unset.
   */
  readonly connectorStatusBus?: ConnectorStatusBus
  /**
   * Composer-picked active context for THIS turn (Slice A5b).
   *
   * When present, the assembler renders the `<active-skills>` block into
   * the system prompt right after `memory` and before `context`: for
   * each pinned skill, the body from `profile.skills[i].content` is
   * inlined. Lookups by `id` against `profile.skills[*].name`; unknown
   * ids are silently skipped (the picker filters by loaded skills, so
   * this is only hit on a stale chip whose skill was removed since the
   * last refresh).
   *
   * Rebuilt per-turn since `assembleAgent` runs once per /run. Purely
   * additive — omitted in tests and any caller that doesn't yet ship
   * the chip surface.
   *
   * The client contract lives at `gateway/types.ts:ActiveContextInput`;
   * keep the two shapes aligned.
   */
  readonly activeContext?: ActiveContextInput
  /**
   * Per-turn vertical-owned system-prompt extension (Slice B10).
   *
   * Cortex is a passthrough — this is concatenated into the assembled
   * system prompt without parsing. Verticals (Design / Marketing /
   * Coder) build their own context blocks client-side and ship them
   * here. Cortex doesn't grow per-product knowledge (Principle 22 —
   * the cortex assembler stays product-agnostic; block names like
   * `<design-metadata>` and `<design-brief>` live in the Design
   * vertical, never here).
   *
   * Placement is just before `<active-skills>` so the vertical's
   * context comes BEFORE the per-turn chip blocks — verticals describe
   * "what this thread is for"; chips describe "what's pinned right
   * now." Both come after memory and before the user message.
   *
   * Length-capped at the gateway layer (8 KB).
   */
  readonly systemPromptAppend?: string
  /**
   * Hook compilation policy — operator-level knobs for the profile's
   * declarative `hooks` config (command opt-in, webhook allowlist,
   * credential redaction). See `profile/hooks.ts`. Omitted → safe
   * defaults: command hooks rejected, https-or-localhost webhooks,
   * no redaction wired.
   */
  readonly hooks?: HookBindingOptions
}

// ---------------------------------------------------------------------------
// Active-context input (Slice A5b)
// ---------------------------------------------------------------------------

/** Mirrors `gateway/types.ts:ActiveContextInput`. Kept private to the
 *  assembler boundary so the assembler is callable by direct-Loom
 *  consumers without importing gateway types. (Design-system + canvas-
 *  selection inputs were removed with the legacy desktop design
 *  vertical — skills are the remaining per-turn pin.) */
export interface ActiveContextInput {
  readonly skills?: readonly ActiveSkillRef[]
}

export interface ActiveSkillRef {
  readonly id: string
  readonly name: string
}

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------

/**
 * Assemble a loaded profile into everything Loom needs.
 *
 * Steps:
 * 1. Resolve provider from model string
 * 2. Assemble tools (presets + allow/deny + custom + MCP)
 * 3. Wire web-search strategy (or stub) via the optional service
 * 4. Build system prompt (SOUL.md + context + memory + skills)
 * 5. Map config to LoomConfig
 * 6. Create checkpoint store
 *
 * @param profile - A fully loaded and validated profile
 * @param options - Optional runtime dependencies (web-search service, etc.)
 * @returns AssembledAgent ready for Loom Session creation
 */
export async function assembleAgent(
  profile: LoadedProfile,
  options: AssembleOptions = {},
): Promise<AssembledAgent> {
  // Canonicalize the model up front: a profile persisted with a friendly
  // display name or bare alias (e.g. "Deepseek V4 Flash" written by the builder
  // or a hand-edit) is healed to its real `provider:model` id, so EVERY
  // downstream use — provider resolution, the loom config, the prompt fragment —
  // sees the canonical id. This is the universal chokepoint: every run and every
  // sub-agent assembles here. An unrecognized string passes through unchanged so
  // `resolveProvider` still raises a clear, honest error. Idempotent.
  const canonicalModel = normalizeModelId(profile.config.model)
  if (canonicalModel !== profile.config.model) {
    profile = { ...profile, config: { ...profile.config, model: canonicalModel } }
  }

  // 0. Fail loudly on any field that is declared in the schema but not
  //    yet wired to the runtime. Silently accepting these (the pre-fix
  //    behaviour) was a P0 security-posture problem for sandbox /
  //    workspace isolation — operators were owed a clear error, not a
  //    false sense of defense. The checks live in ./unsupported.ts so
  //    they can be deleted one line at a time as the Planned modules
  //    ship.
  assertProfileIsSupported(profile)

  // 1. Resolve provider
  const { provider } = resolveProvider(profile.config.model)

  // 2. Connect MCP servers (if configured)
  const { manager: mcpManager, stubs: mcpStubs } = await connectMCPServers(
    profile,
    options.connectorStatusBus,
  )

  // 2b. Memory system bootstrap.
  //
  // Resolves the per-session memory context (active memories to load
  // into the prompt, the bound `remember` tool, and the user identity
  // fragment). Does the one-time AGENTS.md → memories backward-compat
  // seed when this profile has no memories yet but ships an existing
  // AGENTS.md file. Returns nullish when memory system isn't wired
  // (tests / CLI) so downstream callers preserve the pre-memory
  // behaviour exactly.
  const memoryContext = resolveMemoryContext(profile, options)

  // 3. Assemble tools (including MCP tools and not-ready stubs)
  const tools0 = await assembleTools(
    profile,
    mcpManager,
    mcpStubs,
    memoryContext,
  )

  // 4. Run connector tool providers — the vendor-agnostic seam every
  //    future source plugs into. The legacy `webSearchService` option
  //    is auto-wrapped into a provider so M1.5 callers keep working.
  const providers = resolveToolProviders(options)
  const {
    tools: providedTools,
    configOverlays,
    connectorTools,
  } = await runToolProviders(providers, profile, tools0)

  // 4b. Compile per-tool input policies into Loom ToolGuards and wrap
  //     matching tools. Tools not targeted by any guard are returned
  //     ref-equal (no-op). Compilation runs ONCE per assembly — regexes
  //     and matchers are closure-captured, not rebuilt per call.
  const tools = applyProfilePolicies(profile, providedTools)

  // 5. Build system prompt (tools passed for usage rules fragment)
  const systemPrompt = await buildSystemPrompt(
    profile,
    tools,
    options.credentialContext,
    options.workspacePath ?? null,
    memoryContext,
    options.activeContext,
    options.systemPromptAppend,
  )

  // 6. Build LoomConfig
  const compaction = mapCompactionConfig(profile.config.compaction)
  const checkpointStore = createCheckpointStore(profile)

  const baseConfig = createDefaultConfig(profile.config.model)
  const thinkingCfg = profile.config.thinking
  const cacheCfg = profile.config.cache
  const mergedConfig = mergeConfig(baseConfig, {
    model: profile.config.model,
    maxTurns: profile.config.maxTurns,
    maxTokens: profile.config.maxTokens,
    maxBudgetUsd: profile.config.execution.maxCostUsd ?? 0,
    temperature: profile.config.temperature ?? null,
    systemPrompt,
    compaction,
    checkpointStore,
    thinking: thinkingCfg.enabled
      ? { enabled: true, budgetTokens: thinkingCfg.budgetTokens }
      : null,
    // Cache profile — when the user leaves the default, we omit the
    // field entirely so Loom emits plain 5-minute markers (indistinguishable
    // from pre-existing behaviour on the wire). Opting into '1h' surfaces
    // the field so Loom knows to attach the extended-tier marker.
    ...(cacheCfg.ttl !== '5m' ? { cacheProfile: { ttl: cacheCfg.ttl } } : {}),
  })

  // Apply every provider's config overlay (e.g. webSearchStrategy).
  // `LoomConfig` is declared without these fields, so use Object.assign
  // and cast — consistent with how run.ts already extends the config
  // with `agentSpawner` / `subagentDefs`.
  const config = configOverlays.length === 0
    ? mergedConfig
    : (Object.assign({}, mergedConfig, ...configOverlays) as LoomConfig)

  // 7. Create zone security manager (if enabled) and load persistent preferences
  const zoneManager = await createZoneManager(profile)

  // 7b. Compile declarative profile hooks into a HookRuntime + the
  //     ReminderInjector that makes hook outcomes model-visible.
  //     Loud-or-dead: a malformed hook throws HERE (assembly), never
  //     dying silently at runtime. Null when no hooks are declared.
  const hookBinding = buildHookBinding(profile, options.hooks)

  // Match the `tools` list's post-policy instances, not the raw
  // provider output — policy wrapping may have replaced tool objects
  // by `applyProfilePolicies`. Filter by name so reconcile sees the
  // same Tool refs that live on the session.
  const connectorNameSet = new Set(connectorTools.map((t) => t.name))
  const finalConnectorTools = tools.filter((t) => connectorNameSet.has(t.name))

  return {
    config,
    tools,
    systemPrompt,
    provider,
    checkpointStore,
    mcpManager,
    zoneManager,
    connectorTools: finalConnectorTools,
    hookRuntime: hookBinding?.runtime ?? null,
    reminderInjector: hookBinding?.reminders ?? null,
  }
}

// ---------------------------------------------------------------------------
// Tool assembly
// ---------------------------------------------------------------------------

async function assembleTools(
  profile: LoadedProfile,
  mcpManager: MCPManager | null,
  mcpStubs: Tool[],
  memoryContext: MemoryContext | null,
): Promise<Tool[]> {
  const toolsConfig = profile.config.tools
  let tools: Tool[] = []

  // a) Preset builtins.
  //
  // `request_credential` is added to the `coding` preset so a dev agent
  // that hits an auth wall can ask the user for a token. It is NOT
  // added to `readonly`: that preset is a deliberate pure-analysis
  // shape — every tool is `isReadOnly: true` (safe for parallel
  // execution, no side effects), and `request_credential` is a
  // streaming HITL tool with `isReadOnly: false`. Mixing it in would
  // break that invariant. Profiles that want credential prompting
  // should use `coding` or `full`.
  switch (toolsConfig.preset) {
    case 'full':
      tools = [...builtinTools]
      break
    case 'coding':
      tools = [...filesystemTools, ...shellTools, ...credentialTools]
      break
    case 'readonly':
      tools = filesystemTools.filter(t => t.isReadOnly === true)
      break
    case 'none':
      tools = []
      break
  }

  // a.5) Auto-inject `agent_spawn` when the profile declares subagents.
  //      A profile that declares helpers but does not include
  //      `agent_spawn` in its tool set cannot reach them — the SOUL's
  //      "delegate to helper X" instructions become dead text. The
  //      `coding` and `readonly` presets do not include agent_spawn,
  //      so without this every helper-using profile would have to
  //      switch to `full` (over-broad) just to keep its declarations
  //      load-bearing. Skipped when the preset already includes
  //      agent_spawn (the `full` case) or when an explicit deny in
  //      the policy step will remove it shortly.
  if (
    profile.config.subagents.length > 0 &&
    !tools.some(t => t.name === 'agent_spawn')
  ) {
    tools.push(...agentTools)
  }

  // a.5b) `orchestrate` rides alongside `agent_spawn` — a profile that can
  //       delegate to helpers can also fan-out / pipeline / map-reduce them in
  //       one call. Same gating (subagents declared, not already present), so
  //       `coding`-preset helper-using profiles get it without switching to
  //       `full`. `full` already includes it (it's a builtin); this fills the
  //       `coding` gap, mirroring a.5.
  if (
    profile.config.subagents.length > 0 &&
    !tools.some(t => t.name === 'orchestrate')
  ) {
    tools.push(...orchestrateTools)
  }

  // a.6) Cortex-shipped plan tools — `plan_draft` / `plan_submit`.
  //      Available to any profile that has at least some write capability
  //      (presets `coding` and `full`). Skipped for `readonly` (plan_draft
  //      writes a plan file — violates the read-only-only invariant) and
  //      `none` (the explicit "I want no tools" intent must be honored).
  //      Profiles using those presets that still want planning can opt
  //      in via `tools.allow: ['plan_draft', 'plan_submit']`. Loom stays
  //      domain-neutral; the `.ownware/plans/` directory is a Cortex
  //      product convention, hence the tools live in Cortex.
  const planAllowedByPreset =
    toolsConfig.preset === 'full' || toolsConfig.preset === 'coding'
  const planExplicitlyAllowed =
    toolsConfig.allow.includes('plan_draft') ||
    toolsConfig.allow.includes('plan_submit')
  if (
    (planAllowedByPreset || planExplicitlyAllowed) &&
    !tools.some(t => t.name === 'plan_draft')
  ) {
    tools.push(...createPlanTools())
  }

  // (The desktop board tools + `open_pane` pane-substrate wiring were
  // removed with the legacy desktop shell.)

  // b) Apply allow/deny policy (deny always wins).
  //
  // When the memory system is wired AND `memory.autoLearn` is on, also
  // deny Loom's write-through `memory_store` / `memory_search` /
  // `memory_forget` triple. The Cortex `remember` tool replaces them
  // with approval-gated semantics; exposing both confuses the agent
  // (two ways to "store a memory" with different contracts).
  const effectiveDeny = memoryContext?.injectRememberTool === true
    ? [...toolsConfig.deny, 'memory_store', 'memory_search', 'memory_forget']
    : toolsConfig.deny
  tools = applyToolPolicy(tools, toolsConfig.allow, effectiveDeny)

  // b.2) Inject the Cortex `remember` tool — bound to (profileId,
  //      threadId) at session-creation time. Only when the memory
  //      system is wired AND `memory.autoLearn` is on. The tool
  //      surface is a single propose() call; user approves via UI.
  if (memoryContext?.injectRememberTool === true && memoryContext.rememberTool) {
    tools.push(memoryContext.rememberTool)
  }

  // c) Load custom tools from profile directory
  for (const custom of toolsConfig.custom) {
    const customTools = await loadCustomTools(custom.path, custom.functions, profile.basePath)
    tools.push(...customTools)
  }

  // d) MCP server tools — already connected by connectMCPServers()
  if (mcpManager && mcpManager.connectedCount > 0) {
    const mcpTools = mcpManager.getAdaptedTools()
    tools.push(...mcpTools)
  }

  // d.2) Stub tools for MCP servers that could not be connected (missing
  //      credentials, malformed env). The stub carries a structured
  //      `connector_not_ready` payload on its ToolResult.metadata so the
  //      gateway/UI can render an inline "Connect …" card. Skipped when a
  //      real tool with the same name already came from a live server.
  const existingNames = new Set(tools.map(t => t.name))
  for (const stub of mcpStubs) {
    if (!existingNames.has(stub.name)) {
      tools.push(stub)
      existingNames.add(stub.name)
    }
  }

  // e) Validate all tool names match the provider-required pattern
  for (const tool of tools) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(tool.name)) {
      throw new Error(
        `Tool name "${tool.name}" is invalid. ` +
        `Must match ^[a-zA-Z0-9_-]{1,128}$ (alphanumeric, hyphens, underscores, 1-128 chars).`,
      )
    }
  }

  // f) Check for duplicate tool names
  const seen = new Set<string>()
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new Error(
        `Duplicate tool name "${tool.name}". ` +
        `Each tool must have a unique name. Check your custom tools and MCP servers.`,
      )
    }
    seen.add(tool.name)
  }

  return tools
}

// ---------------------------------------------------------------------------
// Policy wiring
// ---------------------------------------------------------------------------

/**
 * Compile the profile's `policies` array into Loom ToolGuards and wrap
 * matching tools. Pure pass-through when the profile declares no
 * policies. Compilation errors (invalid regex source, empty tool
 * pattern) are surfaced here so a malformed profile fails at assembly
 * time rather than during a tool call.
 *
 * The Zod schema already validates shape; this is a thin adapter.
 * The cast to the Loom type is safe because `ToolPolicySpecSchema`
 * is defined to produce structurally identical data.
 */
function applyProfilePolicies(
  profile: LoadedProfile,
  tools: readonly Tool[],
): Tool[] {
  const specs = profile.config.policies
  if (specs.length === 0) return [...tools]
  const guards = compileToolPolicies(specs as readonly LoomToolPolicySpec[])
  return wrapToolsWithGuards(tools, guards)
}

// ---------------------------------------------------------------------------
// MCP server connection
// ---------------------------------------------------------------------------

/**
 * Connect MCP servers defined in the profile.
 *
 * For each MCP entry:
 *   1. Load the per-server credential bundle from `~/.ownware/credentials/`
 *      (saved via the client's Tools page).
 *   2. Resolve `${VAR}` references using stored credentials → process.env.
 *   3. If a single server fails to resolve (missing credential, malformed
 *      config), log a warning and skip it. The other servers still connect.
 *      Per audit finding 31, throwing on a single missing var must NOT
 *      take down the whole profile.
 *
 * Returns null if no MCP servers are configured.
 */
interface ConnectResult {
  readonly manager: MCPManager | null
  readonly stubs: Tool[]
}

async function connectMCPServers(
  profile: LoadedProfile,
  connectorStatusBus?: ConnectorStatusBus,
): Promise<ConnectResult> {
  const mcpConfigs = profile.config.tools.mcp
  const entries = Object.entries(mcpConfigs)
  if (entries.length === 0) return { manager: null, stubs: [] }

  const manager = new MCPManager(/* autoReconnect */ true)

  // F4.b: route manager state transitions onto the connector status
  // bus. See `connector/mcp/status-bridge.ts` for the mapping rules.
  if (connectorStatusBus !== undefined) {
    attachMCPManagerToStatusBus(manager, connectorStatusBus)
  }
  const loomConfigs: LoomMCPServerConfig[] = []
  const stubs: Tool[] = []

  for (const [name, config] of entries) {
    let credBag: Record<string, string> | undefined
    let credLoadOutcome: 'ok' | 'missing' | 'error' = 'missing'
    let credLoadError: string | undefined
    try {
      const stored = await credentialStore.load(name)
      if (stored) {
        credBag = stored.env
        credLoadOutcome = 'ok'
      }
    } catch (err) {
      // Credential read failure is non-fatal — fall back to process.env only.
      credLoadOutcome = 'error'
      credLoadError = err instanceof Error ? err.message : String(err)
    }

    try {
      const loomConfig = mapCortexMCPToLoom(name, config, credBag)
      loomConfigs.push(loomConfig)
    } catch (err) {
      // A single server with missing credentials must NOT take down the
      // whole profile. Inject a stub tool carrying a structured
      // `connector_not_ready` payload so the agent still SEES the
      // connector (and the UI can prompt the user to connect it), but
      // calling it fails with a diagnosable error.
      //
      // Diagnostic: surface the credential-load outcome alongside the
      // resolution error. Otherwise the user sees "OPENAPI_MCP_HEADERS
      // not set" with no idea whether (a) the vault file is missing,
      // (b) it loaded but the wrong env keys are in it, or (c) there
      // was a decrypt error. This was a real diagnostic blind-spot
      // surfaced 2026-05-07 when Notion stayed broken at boot despite
      // the user having clicked Connect (vault file existed, encrypted
      // OK, but the resolution path didn't see the key).
      const message = err instanceof Error ? err.message : String(err)
      const credKeys =
        credBag != null ? Object.keys(credBag).join(',') : '(none)'
      const credInfo =
        credLoadOutcome === 'ok'
          ? `vault loaded keys=[${credKeys}]`
          : credLoadOutcome === 'error'
            ? `vault read FAILED: ${credLoadError}`
            : 'vault entry not found'
      console.warn(
        `[ownware] skipping MCP server '${name}': ${message} — ${credInfo}`,
      )
      stubs.push(buildMCPStub(name, message))
    }
  }

  if (loomConfigs.length === 0) return { manager: null, stubs }

  await manager.addServers(loomConfigs)

  for (const server of manager.listServers()) {
    console.log(`[ownware] MCP server '${server.config.name}': status=${server.status}, tools=${server.tools.length}, error=${server.error ?? 'none'}`)
    if (server.status === 'error' && server.error) {
      stubs.push(buildMCPStub(server.config.name, server.error))
    }
  }

  return { manager, stubs }
}

/**
 * Build a stub Tool for an MCP server whose connection failed. The stub's
 * name is the MCP server id (the only identifier we have before the
 * server's tool list is discovered). When credentials are later supplied
 * and the server connects, the real tools take precedence (see
 * `assembleTools` — existing names win over stubs).
 */
function buildMCPStub(serverId: string, reason: string): Tool {
  const feat = getFeaturedServers().find(f => f.id === serverId)
  const oauthPreset = getOAuthPreset(serverId)

  let authMode: AuthMode
  if (oauthPreset) {
    authMode = {
      mode: 'oauth',
      provider: feat?.title ?? serverId,
      hasPreset: true,
    }
  } else if (feat && feat.requiredEnv.length > 0) {
    authMode = {
      mode: 'api_key',
      envVars: feat.requiredEnv.map(v => ({
        name: v.name,
        description: v.description,
        isRequired: v.isRequired,
        isSecret: v.isSecret,
      })),
    }
  } else {
    authMode = { mode: 'none' }
  }

  // Tool names must match the provider-required regex
  // (^[a-zA-Z0-9_-]{1,128}$). MCP server ids can include '.' and '/'
  // (e.g. 'io.github.user/weather'), so sanitize to an underscore form
  // for the stub's tool name. connectorId keeps the original id so the
  // `ConnectorNotReadyError` metadata still identifies the server
  // unambiguously.
  const safeToolName = serverId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128)

  return createStubTool({
    toolName: safeToolName,
    description: feat?.description,
    connectorId: serverId,
    connectorName: feat?.title ?? serverId,
    source: 'mcp',
    authMode,
    reason,
  })
}

/**
 * Map a Cortex profile MCP server config to a Loom MCPServerConfig.
 *
 * `credentialFallback` is the per-server credential bag loaded from the
 * MCP credential store. ${VAR} references are resolved against it FIRST,
 * then against process.env. This is the bridge between credentials saved
 * via the client UI and the running MCP child process — without it,
 * stored credentials would never reach the agent.
 */
function mapCortexMCPToLoom(
  name: string,
  config: CortexMCPServerConfig,
  credentialFallback: Record<string, string> | undefined,
): LoomMCPServerConfig {
  const ctx = `MCP server '${name}'`
  const resolvedEnv = Object.keys(config.env).length > 0
    ? resolveEnvVarsWithFallback(config.env, credentialFallback, ctx)
    : undefined

  const transport = config.transport === 'streamable_http' ? 'http' : config.transport

  switch (transport) {
    case 'stdio': {
      if (!config.command) {
        throw new Error(`${ctx} (stdio) requires a 'command' field.`)
      }
      const resolvedCommand = resolveEnvStringWithFallback(
        config.command, credentialFallback, `${ctx}.command`,
      )
      const resolvedArgs = config.args.map((arg, i) =>
        resolveEnvStringWithFallback(arg, credentialFallback, `${ctx}.args[${i}]`),
      )
      return {
        name,
        transport: 'stdio',
        command: resolvedCommand,
        args: resolvedArgs,
        env: resolvedEnv,
      }
    }
    case 'sse': {
      if (!config.url) {
        throw new Error(`${ctx} (sse) requires a 'url' field.`)
      }
      return {
        name,
        transport: 'sse',
        url: resolveEnvStringWithFallback(config.url, credentialFallback, `${ctx}.url`),
        headers: Object.keys(config.headers).length > 0 ? config.headers : undefined,
        env: resolvedEnv,
      }
    }
    case 'http': {
      if (!config.url) {
        throw new Error(`${ctx} (http) requires a 'url' field.`)
      }
      return {
        name,
        transport: 'http',
        url: resolveEnvStringWithFallback(config.url, credentialFallback, `${ctx}.url`),
        headers: Object.keys(config.headers).length > 0 ? config.headers : undefined,
        env: resolvedEnv,
      }
    }
    case 'websocket': {
      if (!config.url) {
        throw new Error(`${ctx} (websocket) requires a 'url' field.`)
      }
      return {
        name,
        transport: 'websocket',
        url: resolveEnvStringWithFallback(config.url, credentialFallback, `${ctx}.url`),
        headers: Object.keys(config.headers).length > 0 ? config.headers : undefined,
        env: resolvedEnv,
      }
    }
    default:
      throw new Error(`${ctx} has unsupported transport: ${transport}`)
  }
}

// ---------------------------------------------------------------------------
// Connector tool providers (generic — every source plugs in here)
// ---------------------------------------------------------------------------

/**
 * Build the effective provider list for this assembly.
 *
 * Order:
 *   1. Explicit `options.toolProviders` (in array order).
 *   2. Legacy `options.webSearchService` (wrapped in a
 *      `WebSearchToolProvider` and appended).
 *
 * Deduplication: if both an explicit web-search provider AND a legacy
 * service are passed, the explicit one wins (the legacy wrapper is
 * skipped) so callers migrating from M1.5 aren't surprised by double-
 * resolution of the web-search provider.
 */
function resolveToolProviders(options: AssembleOptions): readonly ConnectorToolProvider[] {
  const explicit = options.toolProviders ?? []
  const hasWebSearchProvider = explicit.some(p => p.source === 'web_search')
  if (!options.webSearchService || hasWebSearchProvider) return explicit
  return [...explicit, new WebSearchToolProvider(options.webSearchService)]
}

/**
 * Run every provider against the current tool list. Handles:
 *   - Provider exceptions (logged, contribution dropped, assembly
 *     continues — one bad vendor integration must not brick a profile)
 *   - `replaceToolNames` — provider swaps the named built-in tool for
 *     its own version (or a stub)
 *   - `stubs` — appended only for names not already present
 *   - `tools` — appended after a duplicate-name check
 *   - `configOverlay` — accumulated so Object.assign applies each
 */
async function runToolProviders(
  providers: readonly ConnectorToolProvider[],
  profile: LoadedProfile,
  initialTools: readonly Tool[],
): Promise<{
  tools: Tool[]
  configOverlays: Record<string, unknown>[]
  connectorTools: Tool[]
}> {
  let tools: Tool[] = [...initialTools]
  const configOverlays: Record<string, unknown>[] = []
  // Tools contributed by providers (incl. stubs), in the order they
  // were appended / replaced. This is the seed for the live-reconcile
  // `ManagedTools` snapshot so the first reconcile after a profile
  // change knows exactly which names it owns.
  const connectorNames = new Set<string>()

  for (const provider of providers) {
    let result: ConnectorToolProviderResult
    try {
      result = await provider.getToolsForProfile(profile, { existingTools: tools })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[ownware] connector provider '${provider.source}' failed; skipping: ${msg}`,
      )
      continue
    }

    // Handle tool replacement (web-search swaps the built-in tool).
    if (result.replaceToolNames && result.replaceToolNames.size > 0) {
      const replacements = new Map<string, Tool>()
      for (const t of result.stubs) replacements.set(t.name, t)
      for (const t of result.tools) replacements.set(t.name, t)
      tools = tools.map(t =>
        result.replaceToolNames!.has(t.name) && replacements.has(t.name)
          ? replacements.get(t.name)!
          : t,
      )
      // Replaced names are now provider-owned.
      for (const name of result.replaceToolNames) connectorNames.add(name)
    }

    // Append real tools — reject hard collisions (non-replace).
    const existingNames = new Set(tools.map(t => t.name))
    for (const t of result.tools) {
      if (result.replaceToolNames?.has(t.name)) continue // already placed above
      if (existingNames.has(t.name)) {
        throw new Error(
          `Connector provider '${provider.source}' contributes tool '${t.name}' ` +
            `which collides with an existing tool. Only replaceToolNames-marked ` +
            `tools may shadow names already in the assembly.`,
        )
      }
      tools.push(t)
      existingNames.add(t.name)
      connectorNames.add(t.name)
    }

    // Append stubs only for names not already present (real wins).
    for (const s of result.stubs) {
      if (result.replaceToolNames?.has(s.name)) continue
      if (!existingNames.has(s.name)) {
        tools.push(s)
        existingNames.add(s.name)
        connectorNames.add(s.name)
      }
    }

    if (result.configOverlay) {
      configOverlays.push({ ...result.configOverlay })
    }
  }

  const connectorTools = tools.filter(t => connectorNames.has(t.name))
  return { tools, configOverlays, connectorTools }
}

// ---------------------------------------------------------------------------
// Memory context — bridges the (system, threadId) input to the tools
// + system-prompt fragments the rest of the assembler consumes.
// ---------------------------------------------------------------------------

interface MemoryContext {
  /** Pre-rendered "About you" fragment, or null when identity is empty. */
  readonly identityFragment: string | null
  /** Pre-rendered top-N memories as a markdown block, or null when empty. */
  readonly memoryFragment: string | null
  /** True when the agent should receive the `remember` tool. */
  readonly injectRememberTool: boolean
  /** The bound tool, or null when memory.autoLearn is off. */
  readonly rememberTool: Tool | null
}

function resolveMemoryContext(
  profile: LoadedProfile,
  options: AssembleOptions,
): MemoryContext | null {
  const wired = options.memory
  if (!wired) return null

  if ('disabled' in wired) {
    return {
      identityFragment: null,
      memoryFragment: null,
      injectRememberTool: false,
      rememberTool: null,
    }
  }

  const profileId = profile.config.name
  const memoryCfg = profile.config.memory

  // One-time backward-compat seed: if no memories exist for this
  // profile yet AND the profile ships an AGENTS.md with bullets,
  // import them as legacy_import-source memories. Idempotent — the
  // count check makes a second call a no-op.
  if (
    memoryCfg.enabled &&
    profile.agentsMd &&
    wired.system.memories.countForProfile(profileId, 'all') === 0
  ) {
    seedFromAgentsMd(wired.system.memories, profileId, profile.agentsMd)
  }

  // When memory is disabled entirely, render no fragments and inject
  // no tool — but still return a context so downstream code can branch
  // on `memoryContext != null` to know "DB-backed memory is wired".
  if (!memoryCfg.enabled) {
    return {
      identityFragment: wired.system.identity.renderForPrompt(),
      memoryFragment: null,
      injectRememberTool: false,
      rememberTool: null,
    }
  }

  // Load top-N for the prompt and bump usage counters.
  const top = wired.system.memories.loadActiveForPrompt(profileId, DEFAULT_MEMORY_TOP_N)
  const memoryFragment = renderMemoryFragmentForPrompt(top)
  if (top.length > 0) {
    wired.system.memories.recordReferences(top.map((m) => m.id))
  }

  // Build the bound `remember` tool when autoLearn is on.
  let rememberTool: Tool | null = null
  if (memoryCfg.autoLearn) {
    const capturedThreadId = wired.threadId
    const proposalsRef = wired.system.proposals
    rememberTool = createRememberTool({
      hook: {
        propose(input) {
          const proposal = proposalsRef.propose({
            profileId,
            threadId: capturedThreadId,
            content: input.content,
            ...(input.kind !== undefined ? { kind: input.kind } : {}),
          })
          return { proposalId: proposal.id }
        },
      },
    })
  }

  return {
    identityFragment: wired.system.identity.renderForPrompt(),
    memoryFragment,
    injectRememberTool: rememberTool != null,
    rememberTool,
  }
}

function renderMemoryFragmentForPrompt(memories: readonly Memory[]): string | null {
  if (memories.length === 0) return null
  const lines = ['## Memory — what this agent has learned about working with the user']
  lines.push(
    'Apply these facts when answering. Do not re-ask for information already listed below. ' +
    'If a fact is wrong, correct yourself and call `remember` with the corrected version (if you have that tool).',
  )
  for (const m of memories) {
    const prefix = m.pinned ? '★ ' : ''
    lines.push(`- ${prefix}${m.content}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// System prompt assembly
// ---------------------------------------------------------------------------

/**
 * Append the truly-universal Loom fragments (the engine baseline) onto a
 * `PromptBuilder`. Domain-neutral — same set every profile, top-level or
 * helper. Order matches SLOT_ORDER (tools → behavior). Centralizing here
 * means: when the universal set evolves, every profile (including
 * subagents resolved via `buildSubagentSystemPrompt`) picks it up
 * automatically. No drift.
 */
function appendUniversalFragments(builder: PromptBuilder, tools: Tool[]): void {
  // Tool usage rules — already conditional on which tools are loaded
  // (filesystem, shell, agent_spawn, todo_write, connectors).
  builder.addFragment(createToolUsageFragment(tools))

  // System rules (tags, permissions, parallel calls, compression, prompt-
  // injection awareness, no-URL-invention).
  builder.addFragment(createSystemFragment())

  // Reasoning-depth calibration; how to read <system-reminder> tags.
  builder.addFragment(createThinkingFrequencyFragment())

  // Universal safety principle (reversibility / blast radius /
  // authorization scope). No domain examples — those belong in profile
  // SOUL.md.
  builder.addFragment(createSafetyPrincipleFragment())

  // Output style (concise responses, no colon before tool calls,
  // emoji policy). Code-reference formats moved to coder/SOUL.md.
  builder.addFragment(createOutputFragment())

  // Compaction awareness (write down important info before it's cleared).
  builder.addFragment(createCompactionFragment())
}

/**
 * Build the system-prompt text a spawned helper should run with.
 *
 * Production-grade unification: helpers go through the same fragment
 * assembly as top-level profiles. Universal hygiene rules (system,
 * thinking, safety-principle, output, compaction, tool-usage) plus
 * the helper's own identity (SOUL.md / inline systemPrompt). This is
 * the bridge function `subagent-resolver.ts` and `run.ts` use to
 * close the long-standing "subagents miss universal fragments" gap.
 *
 * Returns a single text string (matches Loom's `AgentSpec.systemPrompt`
 * shape today). Per-block cache markers are not emitted here — helpers
 * are typically short-lived; cache benefit is small and not worth the
 * threaded-through `SystemPromptBlock[]` plumbing for v1.
 *
 * Domain-neutral: Loom carries no content; this function only composes
 * fragment factories the engine already exposes. Coding-flavored prose
 * stays in `coder/SOUL.md` and other profile SOUL.md files.
 */
export function buildSubagentSystemPrompt(
  profile: LoadedProfile,
  tools: Tool[],
): string {
  const builder = new PromptBuilder()

  // 1. Universal Loom fragments — same as the main agent gets.
  appendUniversalFragments(builder, tools)

  // 2. Identity (helper's SOUL.md takes priority over inline systemPrompt).
  if (profile.soulMd) {
    builder.add('identity', profile.soulMd, { cacheControl: true })
  } else if (profile.config.systemPrompt) {
    builder.add('identity', profile.config.systemPrompt, { cacheControl: true })
  }

  // Render to text. Loom's `agent_spawn` will append the env footer
  // (cwd / OS / date) on top of this string when it spawns the child.
  return builder.buildText()
}

async function buildSystemPrompt(
  profile: LoadedProfile,
  tools: Tool[],
  credentialContext: AssembleOptions['credentialContext'],
  workspacePath: string | null,
  memoryContext: MemoryContext | null,
  activeContext?: ActiveContextInput,
  systemPromptAppend?: string,
): Promise<SystemPromptBlock[]> {
  // Resolve the cwd the agent should be told it lives in. This MUST be
  // the user-selected workspace, not the gateway process's cwd. The
  // gateway runs from the Cortex repo (or wherever the user launched
  // the dev server), so falling back to `process.cwd()` here would put
  // a working-directory line into the system prompt that disagrees with
  // both the filesystem tool's boundary check AND the terminal's cwd —
  // the agent would then construct absolute paths into the wrong tree
  // on every turn. The fallback to `process.cwd()` is preserved only
  // for the no-workspace case (CLI / unit tests).
  const promptCwd = workspacePath ?? process.cwd()
  const builder = new PromptBuilder()

  // ── LOOM STATIC: domain-neutral baseline (every profile, cacheable) ──
  // The truly-universal engine baseline. Contains no domain-specific
  // examples — domain rules live in each profile's SOUL.md. Same set
  // is applied to spawned helpers via `buildSubagentSystemPrompt` so
  // helpers and top-level profiles stay in lockstep on universal
  // hygiene rules. When the set evolves, both paths pick it up.
  appendUniversalFragments(builder, tools)

  // ── CORTEX DYNAMIC (per profile/session) ─────────────────────────

  // Identity (SOUL.md takes priority over inline systemPrompt)
  if (profile.soulMd) {
    builder.add('identity', profile.soulMd, { cacheControl: true })
  } else if (profile.config.systemPrompt) {
    builder.add('identity', profile.config.systemPrompt, { cacheControl: true })
  }

  // Global user identity ("About you" panel). Independent of the
  // per-profile memory system — it always renders when populated, so
  // a fresh profile already knows the user's name, role, etc. The
  // identity store renders nothing when every field is null, so the
  // null-block is never added to the prompt.
  if (memoryContext) {
    const identityFragment = memoryContext.identityFragment
    if (identityFragment) {
      builder.add('memory', identityFragment)
    }
  }

  // Memory — DB-backed when the memory system is wired,
  // AGENTS.md-backed otherwise (legacy CLI / direct-Loom test path).
  // Both paths are gated on `memory.enabled`; setting `false` in
  // agent.json opts the profile out of memory entirely.
  if (profile.config.memory.enabled) {
    if (memoryContext && memoryContext.memoryFragment) {
      builder.add('memory', memoryContext.memoryFragment)
    } else if (!memoryContext && profile.agentsMd) {
      // Fallback path: no DB-backed memory system was injected (likely
      // a unit test or CLI-only callsite). Preserve the pre-feature
      // behaviour of rendering AGENTS.md verbatim so existing tests do
      // not break.
      builder.add('memory', profile.agentsMd)
    }
  }

  // Vertical-owned system-prompt extension (Slice B10) — Design /
  // Marketing / future verticals append their own context blocks
  // here. Cortex is a passthrough; it does NOT parse the string.
  // Comes BEFORE active-context so the agent reads
  // identity → memory → vertical "this thread is for X" →
  // per-turn pinned chips → environment context.
  if (systemPromptAppend != null && systemPromptAppend.length > 0) {
    builder.add('context', systemPromptAppend)
  }

  // Active context (Slice A5b) — composer-picked chips for THIS turn.
  // Rendered between memory and per-flag context so the agent reads:
  // identity → memory → composer pins (active for this turn) →
  // environment context. The fragment is rebuilt fresh per /run, so
  // the agent picks up chip changes between turns immediately.
  const activeFragment = renderActiveContextFragment(profile, activeContext)
  if (activeFragment !== null) {
    builder.add('context', activeFragment)
  }

  // Context (granular — each flag independently controlled)
  const ctx = profile.config.context

  if (ctx.datetime) {
    builder.add('context', getDateContext())
  }

  if (ctx.cwd) {
    builder.add('context', `Working directory: ${promptCwd}`)
  }

  if (ctx.os) {
    builder.add('context', getOsContext())
  }

  if (ctx.git) {
    const gitCtx = await getGitContext(promptCwd)
    if (gitCtx) builder.add('context', gitCtx)
  }

  if (ctx.project) {
    const projectCtx = await getProjectContext(promptCwd)
    if (projectCtx) builder.add('context', projectCtx)
  }

  if (ctx.modelInfo) {
    builder.add('context', `Model: ${profile.config.model}`)
  }

  // Credentials + env config — only when the session runner passed a
  // context object. The agent sees credential NAMES (never values)
  // plus plain-config values. Rendered as a single fragment so both
  // halves land in one cacheable block.
  const credFragment = renderCredentialContextFragment(credentialContext)
  if (credFragment) {
    builder.add('context', credFragment)
  }

  // Connector-add routing guidance — only when the `connectors()`
  // agent tool is in this session's catalog. The tool exposes
  // `list_attached` and `status` only (the `search` action retired
  // 2026-05-12); it CANNOT add new connectors. Adding is a user-
  // driven action from the chat AbilityRail's `+ Add` button. Tell
  // the agent explicitly so it routes the user to the rail instead
  // of either pretending it can add the service or staying silent
  // when the user asks.
  if (tools.some((t) => t.name === 'connectors')) {
    builder.add(
      'context',
      'Adding connectors: if the user asks for a service or tool you don\'t already have access to, tell them to click "+ Add" in the chat ability rail (the strip above the message input) to search and connect it. You CANNOT add or connect services yourself — only the user can, via that button.',
    )
  }

  // Subagents catalog (session-specific guidance). Lists each subagent
  // with its "when to use" hook and, when the profile includes the
  // standard coder trio (explore/planner/verifier), adds the verifier
  // contract — enforces the "spawn verifier before reporting done on
  // non-trivial work" guarantee.
  if (profile.config.subagents.length > 0) {
    const agentDocs = profile.config.subagents.map(sa =>
      `- **${sa.name}** — ${sa.description}`,
    ).join('\n')

    const subagentNames = new Set(profile.config.subagents.map(s => s.name))
    const hasVerifier = subagentNames.has('verifier')
    const hasExplore = subagentNames.has('explore')
    const hasPlanner = subagentNames.has('planner')
    const hasOrchestrate = tools.some(t => t.name === 'orchestrate')

    const lines: string[] = [
      '# Available subagents',
      '',
      'You can spawn these subagents via `agent_spawn` (pass the subagent name as `subagent_type`):',
      agentDocs,
      ...(hasOrchestrate ? [
        '',
        'To run several at once, call `orchestrate` with a `shape`: **fan-out** (independent tasks in parallel), **pipeline** (ordered — each step\'s output feeds the next), **map-reduce** (parallel, then a reducer merges the results into one answer). Reach for it instead of many separate `agent_spawn` calls when the work is genuinely parallel or staged. Each worker has real startup cost — don\'t fan out something one or two steps could do — and put wide, shallow reads on a cheap model while you keep the synthesis.',
      ] : []),
      '',
      'When to reach for a subagent:',
      '- The work would flood your context with raw output you won\'t need again (broad searches, multi-file analysis).',
      '- Independent subtasks that can run in parallel with what you\'re doing.',
      '- Specialized work where a focused prompt + restricted tool set produces better results than doing it in your general context.',
      '',
      'When NOT to reach for one:',
      '- A single-file read or a known-path lookup. Just use `readFile` / `grep` directly.',
      '- Work you can finish in 1–2 tool calls. The spawn overhead costs more than it saves.',
      '- Anything the user needs to watch happen in real time (edits they\'re reviewing turn-by-turn).',
    ]

    if (hasExplore) {
      lines.push(
        '',
        `Use \`explore\` for codebase navigation — finding where a symbol lives, mapping how a feature is structured, sampling callsites. It runs on a small, fast model; expect a terse file:line report, not an essay.`,
      )
    }
    if (hasPlanner) {
      lines.push(
        `Use \`planner\` before non-trivial implementation work: multi-file changes, new abstractions, anything that has to fit cleanly into an existing pattern. Planner returns a step-by-step plan with critical files and trade-offs named.`,
      )
    }
    if (hasVerifier) {
      lines.push(
        '',
        '# Verifier contract',
        '',
        'When non-trivial implementation happens on your turn, independent adversarial verification must happen before you report completion — regardless of who did the implementing (you directly or a subagent you spawned). You are the one reporting to the user; you own the gate.',
        '',
        'Non-trivial means: 3+ file edits, backend/API changes, infrastructure changes, migrations, or anything that crosses a module boundary.',
        '',
        `When the bar is met, spawn \`agent_spawn\` with \`subagent_type: "verifier"\`. Pass the original user request, the files changed, the approach taken, and the relevant test/build commands. Your own spot-checks do NOT substitute for verifier output. Flag concerns if you have them, but do NOT claim the work is done until the verifier agrees.`,
        '',
        'On FAIL: fix the issue, then call the verifier again with a summary of the fix. Repeat until PASS.',
        'On PASS: report completion. Spot-check one or two commands from the verifier\'s report if they feel suspect — a well-run verifier shows the exact command and the exact output; if that\'s missing, treat the PASS with suspicion.',
        'On PARTIAL: report what was verified and what couldn\'t be, and why. Don\'t upgrade a PARTIAL to a PASS yourself.',
      )
    }

    builder.add('custom', lines.join('\n'))
  }

  // Skills catalog — disabled skills (active === false) stay on disk
  // but are filtered out here so they don't reach the system prompt.
  if (profile.skills.length > 0) {
    const activeSkills = profile.skills.filter(s => s.active !== false)
    if (activeSkills.length > 0) {
      const catalog = activeSkills.map(s =>
        `- /${s.name}: ${s.description}`,
      ).join('\n')
      builder.add('skills', `# Available Skills\n\n${catalog}`)
    }
  }

  // `buildBlocks` groups consecutive stable fragments into one cache-marked
  // block and volatile fragments into their own unmarked block. Loom honours
  // the flags when it composes the provider request; any volatile change
  // (memory, date-to-date, context) only invalidates the volatile block, not
  // the whole prompt. See `packages/loom/src/core/system-prompt.ts` for the
  // wire-level semantics.
  return builder.buildBlocks()
}

/**
 * Render the credential-awareness fragment for the system prompt.
 *
 * Two sections, each omitted when empty:
 *
 *   `## Available Credentials` — lists credential LABELS (or variable
 *     names for env placements) so the agent knows what's already in
 *     the vault and doesn't re-request them. No values, ever.
 *
 *   `## Environment Config` — lists non-sensitive KEY=value pairs from
 *     the workspace .env. Values ARE visible — these are explicitly
 *     non-secret (PORT, NODE_ENV, ...).
 *
 * Returns null when both sections would be empty so the caller skips
 * adding an empty context fragment.
 */
function renderCredentialContextFragment(
  ctx: AssembleOptions['credentialContext'],
): string | null {
  if (!ctx) return null
  const handles = ctx.credentialHandles
  const configVars = ctx.configVars

  const lines: string[] = []

  if (handles.length > 0) {
    lines.push('## Available Credentials')
    lines.push(
      'The following credentials are stored in the vault and automatically ' +
        'injected as environment variables into every shell command you run. ' +
        'You do not need to manage them — reference the variable name directly ' +
        '(e.g. `$DATABASE_URL`). If you need a NEW credential not listed here, ' +
        'use the `request_credential` tool.',
    )
    for (const h of handles) {
      if (h.placement.type === 'env') {
        lines.push(`- \`${h.placement.variableName}\` — ${h.label}`)
      } else {
        lines.push(`- ${h.label} (placement: ${h.placement.type})`)
      }
    }
  }

  const configKeys = Object.keys(configVars).sort()
  if (configKeys.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('## Environment Config')
    lines.push(
      'Non-sensitive values from the workspace .env. These are plain ' +
        'configuration — the agent can read them directly.',
    )
    for (const key of configKeys) {
      lines.push(`- \`${key}\` = \`${configVars[key]}\``)
    }
  }

  return lines.length > 0 ? lines.join('\n') : null
}

// ---------------------------------------------------------------------------
// Config mapping
// ---------------------------------------------------------------------------

function mapCompactionConfig(pc: ProfileCompactionConfig): CompactionConfig {
  const trigger = pc.trigger.type === 'disabled'
    ? { type: 'disabled' as const }
    : pc.trigger.type === 'fraction'
      ? { type: 'fraction' as const, threshold: pc.trigger.threshold }
      : pc.trigger.type === 'tokens'
        ? { type: 'tokens' as const, threshold: pc.trigger.threshold }
        : { type: 'messages' as const, threshold: pc.trigger.threshold }

  const retain = pc.retain.type === 'messages'
    ? { type: 'messages' as const, count: pc.retain.count }
    : pc.retain.type === 'fraction'
      ? { type: 'fraction' as const, amount: pc.retain.count }
      : { type: 'tokens' as const, count: pc.retain.count }

  // Tool-result drop — forward the profile opt-in to Loom. We only
  // emit the field when the user actually enabled it so the wire shape
  // for "default profile" stays byte-identical to pre-feature behaviour.
  // A LoomConfig with `toolResultDrop` absent is treated by the loop as
  // disabled, exactly the same as `{ enabled: false }`.
  const toolResultDrop = pc.toolResultDrop.enabled
    ? {
        enabled: true as const,
        triggerFraction: pc.toolResultDrop.triggerFraction,
        keepRecentTurns: pc.toolResultDrop.keepRecentTurns,
        minBytesToDrop: pc.toolResultDrop.minBytesToDrop,
        previewBytes: pc.toolResultDrop.previewBytes,
      }
    : undefined

  // Browser-aware snapshot supersession (B4b). Same pass-through
  // posture as `toolResultDrop` — emit only when enabled, so
  // non-browser profiles keep their wire shape unchanged.
  const browserSnapshotCompaction = pc.browserSnapshotCompaction.enabled
    ? {
        enabled: true as const,
        triggerFraction: pc.browserSnapshotCompaction.triggerFraction,
        keepLatestPerTarget: pc.browserSnapshotCompaction.keepLatestPerTarget,
        keepRecentTurns: pc.browserSnapshotCompaction.keepRecentTurns,
        minBytesToDrop: pc.browserSnapshotCompaction.minBytesToDrop,
      }
    : undefined

  return {
    trigger,
    retain,
    strategy: pc.strategy,
    summaryModel: pc.summaryModel ?? null,
    ...(toolResultDrop !== undefined ? { toolResultDrop } : {}),
    ...(browserSnapshotCompaction !== undefined ? { browserSnapshotCompaction } : {}),
  }
}

/**
 * Create a ZoneManager from the profile's security configuration.
 *
 * Maps Cortex profile zone config to Loom's ZoneManager.
 * Loads persistent user preferences from ~/.ownware/permissions/.
 * Returns null if zones are disabled.
 */
async function createZoneManager(profile: LoadedProfile): Promise<ZoneManager | null> {
  const security = profile.config.security
  const zones = security.zones

  if (!zones.enabled) return null

  // Map Cortex zone overrides to Loom format
  const overrides: ZoneOverride[] = zones.overrides.map(o => ({
    toolPattern: o.tool,
    level: ZONE_NAME_LEVELS[o.zone],
    reason: o.reason,
  }))

  // Build zone config with optional threshold overrides.
  // S7 (2026-05-14 permission redesign): the bundled combination rules
  // are opt-in. `'none'` (the schema default) ships an empty array so
  // the false-positive engine — flagging routine inputs containing the
  // words `token`, `api_key`, `authorization`, etc. — is off for new
  // profiles. Enterprise profiles set `combinationRules: 'default-set'`
  // to re-enable the bundled five-rule set.
  const combinationRules =
    zones.combinationRules === 'default-set' ? DEFAULT_COMBINATION_RULES : []

  const config = createZoneConfig(security.level as SecurityLevel, {
    maxAutoZone: zones.maxAutoZone ? ZONE_NAME_LEVELS[zones.maxAutoZone] : undefined,
    maxAskZone: zones.maxAskZone ? ZONE_NAME_LEVELS[zones.maxAskZone] : undefined,
    overrides: overrides.length > 0 ? overrides : undefined,
    combinationRules,
  })

  const manager = new ZoneManager(config)

  // Load persistent user preferences and pre-populate expansions
  // Safeguard 1: getEffectiveRules filters rules against the security level
  try {
    const savedRules = await permissionStore.getEffectiveRules(
      profile.config.name,
      config.maxAutoZone,
    )

    // Saved rules are 'allow'-only post-2026-05-14 redesign (the store
    // drops legacy 'deny' entries on load). Every loaded rule becomes
    // a session-wide expansion the user pre-authorised on a prior run.
    for (const rule of savedRules) {
      manager.grantExpansion(
        rule.toolPattern,
        rule.maxZone as ZoneOverride['level'],
        'session',
      )
    }
  } catch {
    // Permission file not found or corrupt — start fresh (safe default)
  }

  return manager
}

function createCheckpointStore(profile: LoadedProfile): CheckpointStore | null {
  const cp = profile.config.checkpoint

  switch (cp.store) {
    case 'memory':
      return new MemoryCheckpointStore()
    case 'file': {
      const dir = cp.dir ?? PROJECT_CHECKPOINTS_SUBDIR
      return new FileCheckpointStore(dir)
    }
    case 'postgres':
      // Postgres store requires async initialization — deferred to process manager
      return null
    case 'none':
      return null
  }
}

// ---------------------------------------------------------------------------
// Active-context renderer
// ---------------------------------------------------------------------------

/** Build the `<active-skills>` block for the current turn. Returns `null`
 *  when there's nothing to render — the assembler skips emit so the
 *  prompt stays byte-identical for legacy callers that don't pass
 *  `activeContext`.
 *
 *  Unknown skill ids are silently skipped (the chip store may have a
 *  stale id whose skill was removed between turns). Known skills
 *  inline `profile.skills[i].content` verbatim. (The design-system and
 *  canvas-selection blocks were removed with the legacy desktop design
 *  vertical; vertical-specific context ships via the generic
 *  `systemPromptAppend` passthrough instead.) */
export function renderActiveContextFragment(
  profile: LoadedProfile,
  active: ActiveContextInput | undefined,
): string | null {
  if (active == null) return null

  const skills = active.skills ?? []
  if (skills.length === 0) return null

  const blocks: string[] = []
  for (const ref of skills) {
    const loaded = profile.skills.find((s) => s.name === ref.id)
    if (!loaded) {
      // Stale chip — skill no longer present in the loaded profile.
      // Skip silently; logging in the prompt itself would be noise.
      continue
    }
    const body = loaded.content.trim()
    blocks.push(
      `<skill name="${escapeAttr(ref.id)}">\n${body}\n</skill>`,
    )
  }
  if (blocks.length === 0) return null

  return (
    '<active-skills>\nThe user pinned these skills to the composer for this turn. Follow their rubric / framework on this response.\n\n' +
    blocks.join('\n\n') +
    '\n</active-skills>'
  )
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
