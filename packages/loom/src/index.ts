/**
 * Loom — Agent Operating System Runtime
 *
 * A production-grade agentic framework with no framework dependencies.
 * Built for Cortex. Extended for Agent OS.
 *
 * @example Quick one-shot
 * ```ts
 * const result = await Loom.run('anthropic:claude-sonnet-4-20250514', 'What is 2+2?')
 * console.log(result.text)
 * ```
 *
 * @example Streaming with tools
 * ```ts
 * for await (const event of Loom.stream('sonnet', 'Read package.json', {
 *   tools: builtinTools,
 * })) {
 *   if (event.type === 'text.delta') process.stdout.write(event.text)
 * }
 * ```
 *
 * @example Builder pattern
 * ```ts
 * const agent = Loom.create('sonnet')
 *   .withSystemPrompt('You are a legal analyst')
 *   .withTools(filesystemTools)
 *   .withMaxTurns(20)
 *   .build()
 *
 * for await (const event of agent.run('Analyze this contract')) { ... }
 * ```
 *
 * @packageDocumentation
 */

// Version
export { VERSION as LOOM_VERSION } from './version.js'

// Core
export { loop } from './core/loop.js'
export type {
  LoopParams,
  LoopResult,
  CredentialCallbacks,
  RequestCredentialFn,
  ResolveCredentialFn,
  ListEnvCredentialsFn,
  ListAllCredentialValuesFn,
} from './core/loop.js'
export { Session, createSession } from './core/session.js'
export type { SessionState, CheckPermissionFn, RequestApprovalFn, QuerySideOptions, QuerySideResult } from './core/session.js'
export { createDefaultConfig, mergeConfig } from './core/config.js'
export type { LoomConfig, CompactionConfig, ToolResultDropConfig, BrowserSnapshotCompactionConfig, RetryConfig, ToolExecutionConfig, LoomThinkingConfig } from './core/config.js'
export { dropStaleToolResults } from './compaction/tool-result-drop.js'
export type { DropStaleToolResultsOptions, DropStaleToolResultsReport } from './compaction/tool-result-drop.js'
export { compactSupersededBrowserSnapshots } from './compaction/browser-snapshot-supersede.js'
export type { CompactSupersededBrowserSnapshotsOptions, CompactSupersededBrowserSnapshotsReport } from './compaction/browser-snapshot-supersede.js'
export type { SystemPrompt, SystemPromptBlock } from './core/system-prompt.js'
export {
  normalizeSystemPrompt,
  systemPromptToText,
  countCacheMarkers,
  CACHE_CONTROL_MARKER_LIMIT,
} from './core/system-prompt.js'
export type { CacheControlMarker, CacheProfile, CacheTTL } from './core/cache-control.js'
export { buildCacheMarker, DEFAULT_CACHE_PROFILE } from './core/cache-control.js'
export { createLinkedAbortController, createTimeoutSignal, createCombinedSignal } from './core/abort.js'

// Events
export type {
  LoomEvent,
  StopReason,
  TurnUsage,
  TurnStartEvent,
  TurnEndEvent,
  TextDeltaEvent,
  TextCompleteEvent,
  ThinkingDeltaEvent,
  ThinkingCompleteEvent,
  ToolCallStartEvent,
  ToolCallArgsDeltaEvent,
  ToolCallProgressEvent,
  ToolCallEndEvent,
  CompactionStartEvent,
  CompactionEndEvent,
  ContextPressureEvent,
  CacheStatusEvent,
  RecoveryEvent,
  PermissionRequestEvent,
  PermissionResponseEvent,
  CredentialRequestEvent,
  CredentialResponseEvent,
  AgentSpawnEvent,
  AgentCompleteEvent,
  CheckpointSavedEvent,
  SessionStartEvent,
  SessionEndEvent,
  SecurityBlockEvent,
  SecurityRedactEvent,
  AuditEvent,
  ErrorEvent,
} from './core/events.js'
export { isToolEvent, isContentEvent, isSecurityEvent, isCredentialEvent } from './core/events.js'

// Reminders — engine-level `<system-reminder>` injection subsystem.
// Runtime emits typed events (mode transitions, hook outcomes, compaction
// completions, budget warnings, …); the injector renders them through
// registered templates and produces text fragments to attach to the next
// outgoing message. Generic by design — events carry typed payloads, never
// agent-domain knowledge.
export type {
  ReminderEvent,
  ReminderEventType,
  ReminderTemplate,
  ReminderRenderContext,
  QueuedReminder,
  ModeExitOutcome,
  BudgetCurrency,
  FsModifiedSource,
  ReminderInjectorOptions,
} from './reminders/index.js'
export {
  defineTemplate,
  ReminderRegistry,
  ReminderInjector,
  defaultTemplates,
  createDefaultRegistry,
} from './reminders/index.js'

// Hooks — engine-level lifecycle hook subsystem. Profiles bind hooks
// to events (session.start, user.prompt.submit, tool.pre, tool.post);
// the loop runs them at the matching points and routes outcomes
// through the reminder injector.
export type {
  HookEvent,
  HookContext,
  HookResult,
  HookFn,
  HookSpec,
  HookRunResult,
  HookRuntimeOptions,
} from './hooks/index.js'
export {
  HookRegistry,
  HookRuntime,
  executeHook,
} from './hooks/index.js'

// Skill dispatcher — builtin `skill` tool that lazy-loads a named skill
// from the active session's `SkillRegistry` and returns its body as the
// tool result. Pair with the existing skills loader/registry.
export { createSkillTool } from './tools/builtins/skill.js'
export type { SkillToolOptions } from './tools/builtins/skill.js'

// Output sanitizer — value-format secret redaction (API keys, tokens,
// private keys, connection strings). The canonical secret-VALUE redactor;
// shell + filesystem tool results already pass through it. Exported so
// consumers (e.g. the gatherer profile) redact mined text with the same
// maintained pattern set instead of a parallel regex.
export { sanitizeOutput, containsSecrets } from './tools/builtins/output-sanitizer.js'
export type { SanitizeResult } from './tools/builtins/output-sanitizer.js'

// Context usage — engine-level token-budget measurement. Mirrors CC's
// `/context` UI: total used / free / per-category breakdown
// (system prompt / tools / memory / skills / messages). `Session.getContextUsage()`
// is the consumer-facing entry point; `measureContextUsage` is the
// stateless helper for callers that aren't holding a Session.
export type {
  ContextUsage,
  ContextUsageBreakdown,
  CountMethod,
  TokenCounter,
  MeasureContextUsageOptions,
  MeasureContextUsageDiagnostics,
} from './context/index.js'
export { measureContextUsage, measureContextUsageWithDiagnostics } from './context/index.js'

// Session metrics — unified shape for context + cost + tokens + cache.
// Replaces the scattered `Session.getState().totalUsage` / `getContextUsage`
// pair with a single `Session.getMetrics()` source. The gateway exposes
// this as one endpoint; a UI client renders it as one panel.
export type {
  SessionMetrics,
  CostBreakdown,
  TokenBreakdown,
  CacheStats,
  CostBreakdownInputs,
} from './metrics/index.js'
export { computeCostBreakdown } from './metrics/index.js'

// Modular tool descriptions — replace the flat `description: string` with
// a section-segmented document (overview / usage / safety / parallel /
// alternatives / examples). Profiles select which sections to include
// per tool; tools without a registered description fall back to flat.
export type {
  ToolDescription,
  ToolDescriptionSections,
  ToolDescriptionSection,
  ToolDescriptionSelection,
} from './tools/descriptions/index.js'
export {
  STANDARD_SECTIONS,
  ToolDescriptionRegistry,
  parseToolDescription,
  renderToolDoc,
} from './tools/descriptions/index.js'
export {
  BUILTIN_DESCRIPTIONS,
  createBuiltinDescriptionRegistry,
  skillDescription,
  shellDescription,
} from './tools/builtins/descriptions/index.js'

// Credentials — HITL isolation primitives (types shared across events + tools).
//
// NOTE: the `CredentialHandle` shape exported below is the LEGACY
// per-thread credential descriptor (id + label + placement + storedAt).
// The new opaque resolve handle is in `./credentials/handle.js` under
// the unambiguous name `OpaqueCredentialHandle`. At C21 cutover the
// legacy shape is removed and the new one assumes the unprefixed name.
export type {
  CredentialPlacement,
  CredentialRequest,
  CredentialHandle,
  EnvCredentialEntry,
  CredentialValue,
} from './credentials/types.js'

// Credentials — opaque resolve handle + resolver interface
// (board: credentials-unification — C19/C20). Loom calls
// `resolver.resolve(name, ctx)` and gets back an opaque handle the
// gateway can later dereference at the OS boundary. Loom never holds
// a plaintext value.
export type {
  OpaqueCredentialHandle,
} from './credentials/handle.js'
export {
  isOpaqueCredentialHandle,
  unsafeCreateHandle,
} from './credentials/handle.js'
export type {
  CredentialResolver,
  ResolveContext,
} from './credentials/resolver.js'
export {
  MissingCredentialError,
  CredentialDeniedError,
  ALWAYS_MISSING_RESOLVER,
} from './credentials/resolver.js'

// Tool credential-requirement descriptor — declared by tools via
// `defineTool({ ..., requires: [...] })`. The future tool dispatcher
// pre-resolves every descriptor before invoking `execute()`.
export type {
  CredentialDescriptor,
  CredentialDescriptorAuthType,
  CredentialDescriptorCategory,
} from './credentials/descriptor.js'

// Credential classification patterns — shared between shell output
// redaction and Cortex's .env auto-import so the two systems agree on
// what counts as a secret.
export type { EnvKeyClassification } from './credentials/patterns.js'
export {
  SENSITIVE_KEY_PATTERNS,
  SAFE_KEY_PATTERNS,
  classifyEnvKey,
  isSensitiveEnvKey,
  BLOCKED_FILE_PATTERNS,
  BLOCKED_FILE_GLOBS,
  isBlockedFilePath,
  filterBlockedPaths,
  BLOCKED_FILE_ERROR_MESSAGE,
} from './credentials/patterns.js'

// Errors
export {
  LoomError,
  ProviderError,
  AuthenticationError,
  PermissionDeniedError,
  NotFoundError,
  UnprocessableEntityError,
  RateLimitError,
  ServiceUnavailableError,
  OverloadedError,
  ContextWindowExceededError,
  ContentPolicyError,
  classifyHttpError,
  ToolError,
  ToolTimeoutError,
  ToolPermissionError,
  CompactionError,
  CheckpointError,
  AbortError,
  ConfigError,
} from './core/errors.js'

// Messages
export type {
  Message,
  LoomMessage,
  UserMessage,
  AssistantMessage,
  SystemMessage,
  ContentBlock,
  CacheControl,
  TextBlock,
  ImageBlock,
  DocumentBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
} from './messages/types.js'
export {
  extractToolCalls,
  extractText,
  hasToolCalls,
  createUserMessage,
  createToolResultMessage,
} from './messages/types.js'

// Provider
export type {
  ProviderAdapter,
  ProviderChunk,
  ProviderRequest,
  ProviderUsage,
  ProviderFeature,
  ToolDefinition,
  JsonSchema,
} from './provider/types.js'
export { registerProvider, unregisterProvider, getProvider, resolveProvider, listProviders } from './provider/registry.js'
export { AnthropicProvider } from './provider/anthropic.js'
export { OpenAIProvider } from './provider/openai.js'
export { GoogleProvider } from './provider/google.js'
export { OpenRouterProvider } from './provider/openrouter.js'
export { OllamaProvider, resolveOllamaHost, isOllamaReachable, ollamaInstallHint } from './provider/ollama.js'
export { pickDefaultModel, listOllamaModels, NO_PROVIDER_INSTRUCTION } from './provider/auto-pick.js'
export { PROVIDER_ENV_HINTS } from './provider/registry.js'
export { parseModelString, resolveAlias, registerAlias } from './provider/router.js'

// Pricing
export type { ModelPricing, ModelInfo as ModelFacts } from './provider/pricing.js'
export { getModelPricing, getModelInfo, calculateCost, estimateCostFallback } from './provider/pricing.js'
export { getOpenRouterModelInfo, getOpenRouterPricing } from './provider/openrouter-facts.js'

// Tools
export type {
  Tool,
  ToolCall,
  ToolContext,
  ToolResult,
  ToolProgress,
  ToolCategory,
  ToolExecutionResult,
} from './tools/types.js'
export { defineTool } from './tools/types.js'
// Single-tool executor — the full lifecycle (permission → hooks → validate →
// execute → cap → after-hooks) for ONE tool. Consumers (cortex's approve-execute
// path, 8d-4) reuse this instead of hand-rolling tool execution.
export { executeTool, executeToolBatch } from './tools/executor.js'
export type { ExecuteToolOptions } from './tools/executor.js'
export { ToolResultCache } from './tools/result-cache.js'
export type { ToolResultCacheOptions } from './tools/result-cache.js'

// Tool guards — declarative per-tool input policies (profile-driven)
export {
  compileToolPolicies,
  compileNameMatcher,
  wrapToolsWithGuards,
} from './tools/guard.js'
export type {
  ToolGuard,
  ToolGuardDecision,
  ToolPolicySpec,
  ShellPolicySpec,
} from './tools/guard.js'

// Tool sets — pre-configured collections
export { filesystemTools, forgetReadStateForSession } from './tools/builtins/filesystem.js'
export { shellTools } from './tools/builtins/shell.js'
export { browserTools } from './tools/builtins/browser.js'
export { webFetchTools, webFetch } from './tools/builtins/web-fetch.js'
export { agentTools, agentSpawn } from './tools/builtins/agent.js'
export { orchestrateTools, orchestrate } from './tools/builtins/orchestrate.js'
export { memoryTools } from './tools/builtins/memory.js'
export { taskTools, todoWrite } from './tools/builtins/tasks.js'
export { imageGenerateTools } from './tools/builtins/image-generate.js'
export { speechTools } from './tools/builtins/speech.js'
export { credentialTools } from './tools/builtins/credential.js'
export { builtinTools, createBuiltinTools } from './tools/builtins/index.js'

// Pluggable provider interfaces (consumers inject implementations)
export type {
  SearchProvider,
  SearchResult,
  WebSearchStrategyBinding,
} from './tools/builtins/web-search.js'
export type {
  SearchStrategy,
  SearchStrategyConfig,
  SearchStrategyResult,
} from './tools/search/index.js'
export {
  DuckDuckGoStrategy,
  BraveStrategy,
  TavilyStrategy,
  PerplexityOpenRouterStrategy,
  parseDuckDuckGoHtml,
  sanitizeSnippet,
  normalizeMax,
  normalizeTimeout,
} from './tools/search/index.js'
export type { HtmlConverter } from './tools/builtins/web-fetch.js'
export type { MemoryStore, MemoryEntry } from './tools/builtins/memory.js'
export type {
  TaskStore,
  TaskEntry,
  TaskStatus,
  TaskStoreWriteInput,
} from './tools/builtins/tasks.js'
export type {
  ShellRunner,
  ShellRunInput,
  ShellRunResult,
} from './tools/builtins/shell-runner.js'
export type { ImageGenerationProvider, GeneratedImage } from './tools/builtins/image-generate.js'
export type { TTSProvider, TTSResult, Voice, STTProvider, STTResult } from './tools/builtins/speech.js'

// Browser session management
export {
  connectBrowser,
  disconnectBrowser,
  disconnectAll as disconnectAllBrowsers,
  // Procedural session API — public so profile-local custom browser tools
  // (e.g. ownware-browser) can wrap them into Tool objects without
  // re-implementing Playwright lifecycle. The operations live here in loom;
  // tool DEFINITIONS may live in a profile directory.
  getPage,
  trackPageState,
  getPageState,
  navigatePage,
  clickElement,
  typeIntoElement,
  takeScreenshot,
  takeSnapshot,
  evaluateScript,
  listTabs,
  openTab,
  closeTab,
  hoverElement,
  selectOption,
  pressKey,
  dragElement,
  fillForm,
  waitForCondition,
  scrollIntoView,
  getPlaywrightError,
} from './tools/builtins/browser-session.js'
export type {
  BrowserConnection,
  BrowserTab,
  ScreenshotResult,
  SnapshotResult,
} from './tools/builtins/browser-session.js'

// Browser launcher — spawn + lifecycle for a Chromium-family browser
// with CDP enabled. Independent of the browser tools; consumers wire
// this into their own lifecycle layer (Cortex gateway, CLI, tests).
export {
  launchChrome,
  buildLaunchArgs,
  isChromeReachable,
  findFreePort,
  assertPortFree,
  findBrowserExecutable,
  resolveBrowserExecutableForPlatform,
  findChromeExecutableMac,
  findChromeExecutableLinux,
  findChromeExecutableWindows,
  readBrowserVersion,
  parseBrowserMajorVersion,
  LaunchChromeOptionsSchema,
  createDeferredChromeLauncher,
} from './browser-launcher/index.js'
export type {
  LaunchChromeOptions,
  RunningChrome,
  BrowserExecutable,
  BrowserKind,
  BuildLaunchArgsParams,
  DeferredChromeLauncher,
  CreateDeferredChromeLauncherOptions,
} from './browser-launcher/index.js'

// Provider fallback chain
export { createFallbackProvider, FallbackProviderAdapter } from './provider/fallback.js'
export type { FallbackAttempt, FallbackProviderOptions } from './provider/fallback.js'

// Permissions
export { PermissionEvaluator } from './permissions/evaluator.js'
export { HumanInTheLoop } from './permissions/hitl.js'
export { SessionPermissionStore } from './permissions/session-store.js'
export { BUILT_IN_SAFETY_RULES } from './permissions/rules.js'
export type { PermissionMode, PolicyDecision, PermissionRule, SecurityContext, SafetyRule, DecisionReason, CheckPermissionResult } from './permissions/types.js'
export { formatDecisionReason } from './permissions/types.js'

// Agents
export { AgentSpawner } from './agents/spawner.js'
export type { SpawnerEventHook, SpawnOptions } from './agents/spawner.js'
export { AgentChannel, createChannelHub } from './agents/protocol.js'
export { fanOut, pipeline, mapReduce } from './agents/coordinator.js'
export type { AgentSpec, SpawnMode, AgentHandle, AgentResult, AgentMessage } from './agents/types.js'

// Security — rule presets for different deployment contexts
export {
  CODING_AGENT_RULES,
  ENTERPRISE_AGENT_RULES,
  SANDBOX_AGENT_RULES,
} from './security/default-rules.js'
export { AuditLog } from './security/audit.js'
export type { SecurityLevel, SecurityConfig, AuditEntry } from './security/types.js'

// Zones — zone-based security classification and policy
export {
  ZONE_LEVEL_NAMES,
  ZONE_NAME_LEVELS,
  ZONE_CONFIGS,
  DEFAULT_COMBINATION_RULES,
  ZoneManager,
  CombinationTracker,
  ZoneExpansionTracker,
  classifyToolCall,
  evaluateZonePolicy,
  explainZoneDecision,
  createZoneConfig,
} from './zones/index.js'
// ZoneLevel is both a value (const object) and a type — re-export separately
export { ZoneLevel } from './zones/types.js'
export type {
  ZoneLevel as ZoneLevelType,
  ZoneLevelName,
  ClassifierLayer,
  ZoneClassification,
  ZoneDecision,
  CombinationBlockReason,
  CombinationToolEntry,
  CombinationRule,
  CombinationTrigger,
  ZoneConfig,
  ZoneOverride,
  ZoneExpansion,
  ZoneContext,
} from './zones/index.js'

// Retry
export { withRetry, retryableStream } from './provider/retry.js'

// Compaction
export type { CompactionStrategy, CompactionResult, CompactionManager } from './compaction/types.js'

// Checkpoint
export type { Checkpoint, CheckpointStore } from './checkpoint/types.js'
export { MemoryCheckpointStore } from './checkpoint/memory-store.js'
export { FileCheckpointStore } from './checkpoint/file-store.js'

// Prompt
export { PromptBuilder } from './prompt/builder.js'
export type { PromptFragment, PromptSlot, AssembledPrompt } from './prompt/types.js'
export { createToolUsageFragment, createToolsFragment } from './prompt/fragments/tools.js'
export {
  createSafetyPrincipleFragment,
  createSafetyFragment,
  createBehaviorFragment,
  createEngineeringDisciplineFragment,
} from './prompt/fragments/behavior.js'
export { createOutputFragment } from './prompt/fragments/output.js'
export {
  createSystemFragment,
  createCompactionFragment,
  createSecurityPolicyFragment,
  createThinkingFrequencyFragment,
} from './prompt/fragments/system.js'
export { createIdentityFragment } from './prompt/fragments/identity.js'
export { createMemoryFragment } from './prompt/fragments/memory.js'
export { createContextFragment } from './prompt/fragments/context.js'
export { createSkillsFragment } from './prompt/fragments/skills.js'

// Skills
export type { SkillDefinition, SkillManifest, SkillFrontmatter } from './skills/types.js'

// MCP (Model Context Protocol)
export { MCPClient } from './mcp/client.js'
export type { UnexpectedCloseListener } from './mcp/client.js'
export { MCPManager } from './mcp/manager.js'
export type {
  MCPServerStateChange,
  MCPServerStateChangeListener,
} from './mcp/manager.js'
export { MCPError } from './mcp/types.js'
export { adaptMCPTool, adaptAllMCPTools, createListResourcesTool, createReadResourceTool } from './mcp/adapter.js'
export { StdioTransport, SSETransport, HTTPTransport, WebSocketTransport, createTransport } from './mcp/transports.js'
export type {
  MCPServerConfig,
  MCPStdioServerConfig,
  MCPSSEServerConfig,
  MCPHTTPServerConfig,
  MCPWebSocketServerConfig,
  MCPTransport,
  MCPServerStatus,
  MCPServer,
  MCPTool,
  MCPToolAnnotations,
  MCPResource,
  MCPResourceContent,
  MCPServerCapabilities,
  MCPTransportLayer,
} from './mcp/types.js'

// MCP OAuth2 Authentication (generic PKCE primitives only —
// provider presets + validators live in @ownware/cortex)
export {
  startOAuthFlow,
  refreshTokens,
  findAvailablePort,
  buildRedirectUri,
  OAuthFlowError,
  // Dynamic OAuth (MCP 2025-03-26 spec): auto-discovery + RFC 7591
  // dynamic client registration. Used when no preset exists for the
  // server (e.g. Figma-MCP). Pre-step before startOAuthFlow.
  discoverOAuthEndpoints,
  parseResourceMetadataUrl,
  probeForWWWAuthenticate,
  OAuthDiscoveryError,
  registerOAuthClient,
  DynamicClientRegistrationError,
} from './mcp/auth/index.js'
export type {
  OAuthFlowConfig,
  OAuthTokens,
  OAuthPreset,
  MCPServerAuthType,
  PendingOAuthFlow,
  DiscoveredOAuthEndpoints,
  OAuthDiscoveryOptions,
  DynamicClientRegistrationRequest,
  IssuedClientCredentials,
  DynamicClientRegistrationOptions,
} from './mcp/auth/index.js'

// Media processing
export {
  processImage,
  processImageToBase64,
  detectImageFormat,
  detectImageFormatFromBase64,
  createImageMetadataText,
  ImageProcessError,
  readPDF,
  getPDFPageCount,
  isPdftoppmAvailable,
  extractPDFPages,
  parsePDFPageRange,
  readNotebook,
  notebookCellsToContent,
  processAttachment,
  processAttachments,
  categorizeFile,
  hasBinaryExtension,
  hasImageExtension,
  isPDFExtension,
  isNotebookExtension,
  isBinaryContent,
} from './media/index.js'
export type {
  ImageDimensions,
  ImageProcessResult,
  CompressedImageResult,
  PDFResult,
  PDFReadResult,
  PDFExtractResult,
  ProcessedCell,
  ProcessedOutput,
  RawAttachment,
  AttachmentCategory,
} from './media/index.js'

// ---------------------------------------------------------------------------
// Loom class — the main entry point
// ---------------------------------------------------------------------------

import { Session } from './core/session.js'
import { createDefaultConfig, mergeConfig } from './core/config.js'
import { resolveProvider, registerProvider } from './provider/registry.js'
import { AnthropicProvider } from './provider/anthropic.js'
import { OpenAIProvider } from './provider/openai.js'
import { GoogleProvider } from './provider/google.js'
import { OpenRouterProvider } from './provider/openrouter.js'
import { OllamaProvider } from './provider/ollama.js'
import type { LoomConfig } from './core/config.js'
import type { SystemPrompt } from './core/system-prompt.js'
import type { LoomEvent, TurnUsage } from './core/events.js'
import type { LoopResult } from './core/loop.js'
import type { Tool } from './tools/types.js'
import type { PermissionMode } from './permissions/types.js'
import type { Message } from './messages/types.js'
import type { ProviderAdapter } from './provider/types.js'

// Auto-register known providers.
//
// Each provider's SDK constructor (Anthropic / OpenAI / Google) THROWS at
// construction time if its env var key is missing — the SDKs are eager.
// In a desktop app where the user might not have entered keys yet, we
// can't let one missing key crash the whole import + every consumer.
//
// safeRegister: wrap in try/catch so a provider with no key just doesn't
// get auto-registered. The gateway can register it later with an
// explicit key once the user saves one (handlers/providers.ts already
// stores keys in its DB; instantiation with an explicit key still works).
function safeRegister(name: string, create: () => ProviderAdapter): void {
  try {
    registerProvider(create())
  } catch {
    // No env-var key = provider waits for runtime registration with an
    // explicit key (gateway/handlers/providers.ts re-registers from the
    // DB at boot and on every Settings save). This is the EXPECTED path
    // under D12 (keychain-only credentials), so don't spam the console
    // — quiet by default. Set `LOOM_DEBUG=1` to surface the reason.
    if (process.env.LOOM_DEBUG === '1') {
      // eslint-disable-next-line no-console
      console.debug(`[loom] '${name}' not auto-registered (no env key)`)
    }
  }
}

// Gate cloud providers on their env key being PRESENT, not just on the
// constructor surviving: some SDKs (Anthropic) construct fine without a
// key and only fail at request time with a cryptic auth error. Gating on
// the env var means a keyless run fails EARLY at resolveProvider with an
// actionable "set X or use Ollama" message (see registry.ts) instead of
// deep inside a provider call. The gateway still registers providers
// explicitly from its credential store at boot and on Settings saves.
if (process.env.ANTHROPIC_API_KEY) safeRegister('anthropic', () => new AnthropicProvider())
if (process.env.OPENAI_API_KEY) safeRegister('openai', () => new OpenAIProvider())
if (process.env.GOOGLE_API_KEY) safeRegister('google', () => new GoogleProvider())
if (process.env.OPENROUTER_API_KEY) safeRegister('openrouter', () => new OpenRouterProvider())
// Ollama is keyless (local server) — always registers; runs fail with a
// connection error only if no Ollama is listening on the resolved host.
safeRegister('ollama', () => new OllamaProvider())

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface LoomOptions {
  model: string
  systemPrompt?: SystemPrompt
  tools?: Tool[]
  permissionMode?: PermissionMode
  config?: Partial<LoomConfig>
  initialMessages?: Message[]
}

export interface RunOptions {
  tools?: Tool[]
  systemPrompt?: SystemPrompt
  maxTurns?: number
  maxTokens?: number
  config?: Partial<LoomConfig>
}

export interface RunResult {
  text: string
  usage: TurnUsage
  turnCount: number
  reason: string
}

// ---------------------------------------------------------------------------
// Loom class
// ---------------------------------------------------------------------------

/**
 * Loom — the simplest way to run an agent.
 *
 * Three ways to use:
 *
 * 1. Static one-shot:  `await Loom.run('sonnet', 'What is 2+2?')`
 * 2. Static streaming:  `for await (const e of Loom.stream('sonnet', 'Hello')) { ... }`
 * 3. Instance:  `new Loom({ model: 'sonnet' }).run('Hello')`
 * 4. Builder:  `Loom.create('sonnet').withTools([...]).build().run('Hello')`
 */
export class Loom {
  private session: Session

  constructor(opts: LoomOptions) {
    const { provider } = resolveProvider(opts.model)
    const config = mergeConfig(
      createDefaultConfig(opts.model),
      {
        model: opts.model,
        systemPrompt: opts.systemPrompt ?? '',
        ...opts.config,
      },
    )

    this.session = new Session({
      config,
      provider,
      tools: opts.tools ?? [],
      initialMessages: opts.initialMessages,
      ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
    })
  }

  /**
   * Run the agent with a prompt.
   * Returns an AsyncGenerator that yields LoomEvents.
   */
  async *run(prompt: string): AsyncGenerator<LoomEvent, LoopResult> {
    return yield* this.session.submitMessage(prompt)
  }

  /** Abort the current run */
  abort(): void {
    this.session.abort()
  }

  /** Get the underlying session */
  getSession(): Session {
    return this.session
  }

  // -------------------------------------------------------------------------
  // Static factory: one-shot run (collects result)
  // -------------------------------------------------------------------------

  /**
   * Run a prompt and collect the full text result.
   *
   * ```ts
   * const result = await Loom.run('sonnet', 'What is 2+2?')
   * console.log(result.text)   // "4"
   * console.log(result.usage)  // { inputTokens: 23, outputTokens: 5, ... }
   * ```
   */
  static async run(model: string, prompt: string, opts?: RunOptions): Promise<RunResult> {
    const agent = new Loom({
      model,
      systemPrompt: opts?.systemPrompt,
      tools: opts?.tools,
      config: {
        maxTurns: opts?.maxTurns,
        maxTokens: opts?.maxTokens,
        ...opts?.config,
      },
    })

    return collectResult(agent.run(prompt))
  }

  /**
   * Stream a prompt — returns the raw event AsyncGenerator.
   *
   * ```ts
   * for await (const event of Loom.stream('sonnet', 'Hello')) {
   *   if (event.type === 'text.delta') process.stdout.write(event.text)
   * }
   * ```
   */
  static stream(model: string, prompt: string, opts?: RunOptions): AsyncGenerator<LoomEvent, LoopResult> {
    const agent = new Loom({
      model,
      systemPrompt: opts?.systemPrompt,
      tools: opts?.tools,
      config: {
        maxTurns: opts?.maxTurns,
        maxTokens: opts?.maxTokens,
        ...opts?.config,
      },
    })

    return agent.run(prompt)
  }

  // -------------------------------------------------------------------------
  // Static factory: builder pattern
  // -------------------------------------------------------------------------

  /**
   * Start building a Loom agent with a fluent API.
   *
   * ```ts
   * const agent = Loom.create('sonnet')
   *   .withSystemPrompt('You are a legal analyst')
   *   .withTools(filesystemTools)
   *   .withMaxTurns(20)
   *   .build()
   * ```
   */
  static create(model: string): LoomBuilder {
    return new LoomBuilder(model)
  }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export class LoomBuilder {
  private model: string
  private systemPrompt?: SystemPrompt
  private tools: Tool[] = []
  private maxTurns?: number
  private maxTokens?: number
  private permissionMode?: PermissionMode
  private configOverrides: Partial<LoomConfig> = {}
  private messages?: Message[]

  constructor(model: string) {
    this.model = model
  }

  withSystemPrompt(prompt: SystemPrompt): this {
    this.systemPrompt = prompt
    return this
  }

  withTools(tools: Tool[]): this {
    this.tools.push(...tools)
    return this
  }

  withMaxTurns(maxTurns: number): this {
    this.maxTurns = maxTurns
    return this
  }

  withMaxTokens(maxTokens: number): this {
    this.maxTokens = maxTokens
    return this
  }

  withPermissionMode(mode: PermissionMode): this {
    this.permissionMode = mode
    return this
  }

  withConfig(config: Partial<LoomConfig>): this {
    this.configOverrides = { ...this.configOverrides, ...config }
    return this
  }

  withMessages(messages: Message[]): this {
    this.messages = messages
    return this
  }

  build(): Loom {
    return new Loom({
      model: this.model,
      systemPrompt: this.systemPrompt,
      tools: this.tools,
      permissionMode: this.permissionMode,
      initialMessages: this.messages,
      config: {
        maxTurns: this.maxTurns,
        maxTokens: this.maxTokens,
        ...this.configOverrides,
      },
    })
  }
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

/**
 * Collect all text from an agent run.
 *
 * ```ts
 * const text = await collectText(agent.run('Hello'))
 * ```
 */
export async function collectText(
  events: AsyncGenerator<LoomEvent, LoopResult>,
): Promise<string> {
  let text = ''
  let result = await events.next()
  while (!result.done) {
    const event = result.value
    if (event.type === 'text.delta') {
      text += event.text
    }
    result = await events.next()
  }
  return text
}

/**
 * Collect the full result from an agent run.
 *
 * ```ts
 * const { text, usage, turnCount } = await collectResult(agent.run('Hello'))
 * ```
 */
export async function collectResult(
  events: AsyncGenerator<LoomEvent, LoopResult>,
): Promise<RunResult> {
  let text = ''
  let usage: TurnUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    model: '',
    costUsd: 0,
  }
  let turnCount = 0
  let reason = 'end_turn'

  let result = await events.next()
  while (!result.done) {
    const event = result.value
    if (event.type === 'text.delta') {
      text += event.text
    }
    result = await events.next()
  }

  // LoopResult from the generator return value
  const loopResult = result.value
  usage = loopResult.totalUsage
  turnCount = loopResult.turnCount
  reason = loopResult.reason

  return { text, usage, turnCount, reason }
}

/**
 * Filter events by type from an agent run.
 *
 * ```ts
 * for await (const event of filterEvents(agent.run('Hello'), 'text.delta')) {
 *   process.stdout.write(event.text)
 * }
 * ```
 */
export async function* filterEvents<T extends LoomEvent['type']>(
  events: AsyncGenerator<LoomEvent, LoopResult>,
  type: T,
): AsyncGenerator<Extract<LoomEvent, { type: T }>> {
  let result = await events.next()
  while (!result.done) {
    if (result.value.type === type) {
      yield result.value as Extract<LoomEvent, { type: T }>
    }
    result = await events.next()
  }
}
