/**
 * Agent execution handlers — the core of the gateway.
 *
 * POST /api/v1/run — start a background agent run, return { threadId }.
 * POST /api/v1/threads/:threadId/resume — respond to permission prompt.
 * POST /api/v1/threads/:threadId/abort — stop a running agent.
 * GET  /api/v1/runs/active — list all active background runs.
 *
 * The run handler does NOT stream SSE. It starts the Loom loop in the
 * background via SessionRunner and returns immediately. The client then
 * connects to GET /threads/:tid/agents/root/events (the existing replay
 * + live-tail SSE endpoint) to watch the run. This means:
 *
 *   - Tab close / refresh = SSE unsubscribe. Loop keeps running.
 *   - Reconnect = replay from SQLite + tail live events. No gap.
 *   - Permission prompt = loop blocks on HITL Promise. No HTTP needed.
 *   - Only POST /abort kills the loop.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  Session, HumanInTheLoop, mergeConfig, AgentSpawner,
  launchChrome, createDeferredChromeLauncher, resolveProvider, getProvider,
  executeTool,
} from '@ownware/loom'
import type {
  ContentBlock, ZoneDecision, RunningChrome, LaunchChromeOptions, Tool,
  ToolContext, ToolCall, ToolResult,
} from '@ownware/loom'
import { processAttachments, categorizeFile } from '@ownware/loom'
import {
  validateAttachments,
  AttachmentValidationError,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_ITEM_BYTES,
  ATTACHMENT_MAX_TOTAL_BYTES,
  ATTACHMENT_MAX_FILENAME_CHARS,
} from '@ownware/loom'
import { RequestError, sendError, sendJSON, readJSON } from '../router.js'
import type { GatewayState } from '../state.js'
import type { ProfileRegistry } from '../../profile/registry.js'
import { assembleAgent, buildSubagentSystemPrompt } from '../../profile/assembler.js'
import { hookBindingOptionsFromEnv } from '../../profile/hooks.js'
import { applyRunSafety, envelopeSpawnerPool, summarizeHeldCall, type HoldSink } from '../../schedules/draft-hold.js'
import type { SqliteApprovalStore } from '../../schedules/approvals.js'
import { resolveSubagentDef } from '../../profile/subagent-resolver.js'
import {
  resolveLocalHelperDir,
  loadLocalHelperProfile,
} from '../../profile/local-helpers.js'
import type { RunRequest, ResumeRequest, AttachmentMeta } from '../types.js'
import type { UserMessageEvent } from '../events.js'
import type { LoomEvent } from '@ownware/loom'
import { permissionStore } from '../../permissions/store.js'
import type { SessionRunner } from '../session-runner.js'
import { trace } from '../trace.js'
import { asHitlLike, denyAllHitls, type HITLLike } from '../hitl-registry.js'
import type { WebSearchService } from '../../connector/web-search/service.js'
import type { ConnectorToolProvider } from '../../connector/providers/types.js'
import { CredentialHITL } from '../../credential/hitl.js'
import { ThreadCredentialRuntime } from '../../credential/runtime.js'
import { credentialVault } from '../../connector/credentials/vault.js'
import type { SqliteTaskStore } from '../../tasks/store.js'
import type { CredentialStore } from '../../credential/store/index.js'
import { selectSttProvider } from '../../speech/index.js'
import { createThreadScopedTaskStore } from '../../tasks/scoped-store.js'
import type { MemorySystem } from '../../memory/index.js'
import type { TerminalSessionRegistry } from '../../terminal/session-registry.js'
import type { PendingReconciles } from '../pending-reconcile.js'
import { initialManagedTools } from '../../profile/reconcile.js'
import type { ConnectorStatusBus } from '../../connector/status-bus.js'
import { createWorkspaceAgentShellRunner } from '../../terminal/scoped-shell-runner.js'

const FileAttachmentInputSchema = z.object({
  filename: z.string().min(1).max(ATTACHMENT_MAX_FILENAME_CHARS),
  data: z.string().min(1).max(Math.ceil(ATTACHMENT_MAX_ITEM_BYTES / 3) * 4),
  mimeType: z.string().min(1).max(127),
}).strict()

const ActiveSkillRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
}).strict()

// (Design-system + canvas-selection active-context inputs were removed with
// the legacy desktop design vertical — skills are the remaining per-turn pin.)
const ActiveContextInputSchema = z.object({
  skills: z.array(ActiveSkillRefSchema).optional(),
}).strict()

/**
 * Maximum bytes for a single `systemPromptAppend` payload.
 *
 * Raised from 8 KB → 64 KB on 2026-05-27 (slice B1.5.1) when the Design
 * vertical's `<template-reference>` block started baking SKILL.md +
 * example.html verbatim into the SPA — pinning even a simple template
 * like `magazine-poster` (4 KB SKILL.md + 8.5 KB example.html) breaches
 * the old 8 KB cap before any active-context blocks are added.
 *
 * 64 KB sits comfortably under Sonnet 4.6's 200 K context (≈ 4 %),
 * fits every catalog template + every realistic active-context combo,
 * and is still small enough that an accidental megabyte-payload is
 * caught at the wire. File contents that exceed this still belong in
 * the user message, attachments, or skill bodies — not in SPA.
 */
const SYSTEM_PROMPT_APPEND_MAX_BYTES = 64 * 1024

const RunRequestSchema = z.object({
  prompt: z.string().min(1),
  profileId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  attachments: z.array(FileAttachmentInputSchema).max(ATTACHMENT_MAX_COUNT).optional(),
  activeContext: ActiveContextInputSchema.optional(),
  /**
   * Per-turn vertical-owned system-prompt extension. Cortex is a
   * passthrough — it concatenates this string into the assembled
   * system prompt without parsing it. The Design vertical (client-side)
   * builds the `<design-metadata>` + `<design-brief>` blocks here.
   * Marketing / Coder / future verticals can attach their own shapes
   * without cortex growing per-product knowledge (Principle 22).
   *
   * Length-capped to defend against accidental megabytes; null/omitted
   * means "no vertical context this turn." See SYSTEM_PROMPT_APPEND_MAX_BYTES.
   */
  systemPromptAppend: z.string().max(SYSTEM_PROMPT_APPEND_MAX_BYTES).optional(),
}).strict()

const ExactPermissionDecisionSchema = z.object({
  decision: z.enum(['approve', 'deny']),
  operationHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()

/** What startProfileRun returns once the background run is dispatched. */
interface RunStartResult {
  readonly runId: string
  readonly threadId: string
  readonly agentId: 'root'
  readonly profileId: string
  readonly candidateId: string | null
  readonly model: string
  readonly status: 'running'
  /** Enforced wall-clock limit selected from the resolved profile. */
  readonly timeoutMs?: number
  readonly attachments: AttachmentMeta[] | undefined
  /** Resolves when the background run finishes (scheduler may await it). */
  readonly done: Promise<unknown>
}

interface PreparedAttachmentBatch {
  readonly results: Awaited<ReturnType<typeof processAttachments>>
  readonly metadata: AttachmentMeta[]
}

/**
 * A preflight failure inside startProfileRun (bad workspace/thread/
 * profile, missing companions). The HTTP handler maps `.status` to an
 * HTTP code; the scheduler maps it to a failed run record.
 */
class RunStartError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
    this.name = 'RunStartError'
  }
}

import { normalizeModelId, pickRunnableDefaultModel } from '../catalog/models/index.js'
import { authorizePrincipalScope, getRequestPrincipal } from '../auth/scoped-principal.js'
import {
  isValidIdempotencyKey,
  principalContinuityKey,
  type RunIdempotencyStore,
  type RunStartSnapshot,
} from '../idempotency.js'
import { ProfileRunNotAcceptingError, type GatewayRunStore } from '../run-store.js'
import type { CandidateStore } from '../candidate-store.js'
import type { CandidateProfileResolver } from '../../profile/candidate-activation.js'

export interface RunHandlerDeps {
  /** Attachment processor override for failure-injection tests. */
  readonly processAttachmentsFn?: typeof processAttachments
  /** Durable execution snapshots and lifecycle transitions. */
  readonly runStore?: GatewayRunStore
  /** Durable public retry fence. Scheduler calls do not pass through it. */
  readonly idempotencyStore?: RunIdempotencyStore
  /** Resolve and verify the currently active immutable candidate, when one exists. */
  readonly candidateResolver?: CandidateProfileResolver
  /** Durable candidate deployment state used by the early pause fence. */
  readonly candidateStore?: CandidateStore
  /**
   * Connector services threaded into `assembleAgent` so sessions pick
   * up the user's live provider choice. Optional — omitting them
   * keeps the pre-M2 behaviour (web_search falls through to its
   * `no_provider` branch).
   */
  readonly webSearchService?: WebSearchService
  /**
   * Additional tool providers threaded into `assembleAgent`. Phase 2b.2
   * wires Composio here; assembler ordering: explicit providers first,
   * then legacy webSearchService (back-compat).
   */
  readonly toolProviders?: readonly ConnectorToolProvider[]
  /**
   * Browser launcher override — the production default is Loom's
   * `launchChrome`. Tests inject a mock to exercise the autoLaunch path
   * without spawning a real browser. Must return a `RunningChrome` whose
   * `stop()` is idempotent so the gateway shutdown path stays safe.
   */
  readonly launchChromeFn?: (opts: LaunchChromeOptions) => Promise<RunningChrome>
  /**
   * Shared task store. When provided, each session gets a per-thread
   * scoped adapter on `config.taskStore` so Loom's `todo_write` tool
   * persists via SQLite + emits `tasks.updated` bus events. Optional
   * — gateway unit tests that don't need tasks simply omit this.
   */
  readonly taskStore?: SqliteTaskStore
  /**
   * Approvals store (Slice 8d). When present, a draft-for-approval scheduled
   * run parks each held write/send tool call here instead of executing it.
   * Omitted → `applyRunSafety` fails closed to read-only (no place to park).
   */
  readonly approvalStore?: SqliteApprovalStore
  /**
   * Unified credential store. When provided, each session gets an
   * `sttProvider` on its config (resolved from the highest-priority
   * configured speech key) so Loom's `speech_transcribe` tool can turn
   * audio files into text. Omitted in tests → the tool falls through to
   * its `no_provider` branch.
   */
  readonly credentialStore?: CredentialStore
  /**
   * Shared terminal session registry. When provided, each session
   * gets a per-workspace PTY-backed `shellRunner` on its config so
   * Loom's `shell_execute` routes through the workspace terminal.
   * Omitted in tests that don't need the terminal.
   */
  readonly terminalRegistry?: TerminalSessionRegistry
  /**
   * Per-thread pending-reconcile tracker. When provided:
   *   - After initial session creation, stashes the connector-tool
   *     snapshot so the next reconcile has a valid baseline.
   *   - Consumed by `SessionRunner` via its `reconcileDeps` wire —
   *     run.ts only writes the baseline here.
   * Omitted in tests that don't exercise reconcile.
   */
  readonly pendingReconciles?: PendingReconciles
  /**
   * Memory system (shared across all sessions in the gateway). When
   * provided, each new session is assembled with `options.memory =
   * { system, threadId }` so:
   *   - Top-N ranked memories from `ownware.db` are prepended to the
   *     system prompt instead of static AGENTS.md content.
   *   - The user identity layer (always-loaded "About you" facts)
   *     is included.
   *   - When `profile.memory.autoLearn` is on, the agent receives
   *     the `remember` tool bound to (profileId, threadId).
   *
   * Omitted in tests that don't need the memory feature; the
   * assembler then falls back to its pre-feature AGENTS.md path.
   */
  readonly memorySystem?: MemorySystem
  /**
   * Connector status bus the gateway wires to the unified
   * `/api/v1/connectors/events` SSE channel. Threaded into
   * `assembleAgent` so the MCPManager built for each session fans
   * transport-close + reconnect transitions back onto the bus
   * (audit #4 / F4.b). Omitted in tests that don't need live
   * connector status to surface.
   */
  readonly connectorStatusBus?: ConnectorStatusBus
}

/**
 * Build a thread's credential runtime + import its workspace `.env` — the ONE
 * vault-touching credential construction, shared by the normal run path
 * (`startProfileRun`) and the approve-execute path (`executeHeldTool`, 8d-4). The
 * .env import is best-effort: a broken file must never block the run/approve (the
 * agent can still use already-stored credentials). Values stay in the vault + the
 * runtime's in-memory cache — NEVER logged, NEVER put in the prompt or a result.
 */
async function buildThreadCredentialRuntime(
  threadId: string,
  workspacePath: string | undefined,
): Promise<{ credentialRuntime: ThreadCredentialRuntime; credentialConfigVars: Record<string, string> }> {
  const credentialRuntime = new ThreadCredentialRuntime(threadId, credentialVault)
  let credentialConfigVars: Record<string, string> = {}
  if (workspacePath) {
    try {
      const dotenvResult = await credentialRuntime.importFromWorkspace(workspacePath)
      credentialConfigVars = { ...dotenvResult.configVars }
    } catch (err) {
      console.warn(
        `[run] .env import failed for thread ${threadId}: ` +
          (err instanceof Error ? err.message : String(err)),
      )
    }
  }
  return { credentialRuntime, credentialConfigVars }
}

export function createRunHandlers(
  state: GatewayState,
  registry: ProfileRegistry,
  runner: SessionRunner,
  deps: RunHandlerDeps = {},
) {

  // POST /api/v1/run — thin HTTP wrapper; the run-start core is
  // startProfileRun (shared with the scheduler).
  async function run(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let rawBody: unknown
    try {
      rawBody = await readJSON(req)
    } catch (e) {
      if (e instanceof RequestError) {
        sendError(res, e.status, e.message, undefined, e.category, e.details)
      } else {
        sendError(res, 400, 'Invalid JSON body')
      }
      return
    }
    if (rawBody === null) {
      sendError(res, 400, 'Request body is required.')
      return
    }
    const parsed = RunRequestSchema.safeParse(rawBody)
    if (!parsed.success) {
      if (parsed.error.issues.some((issue) => issue.path[0] === 'attachments')) {
        sendError(
          res,
          400,
          'Attachment input is invalid.',
          'attachment_invalid',
          'invalid_request',
          { limits: attachmentLimits() },
        )
        return
      }
      sendError(res, 400, `Invalid body: ${parsed.error.message}`)
      return
    }
    const body: RunRequest = parsed.data

    let preparedAttachments: PreparedAttachmentBatch | undefined
    try {
      preparedAttachments = await prepareAttachmentBatch(body.attachments)
    } catch (err) {
      if (err instanceof RunStartError) {
        sendError(res, err.status, err.message, err.code, undefined, err.details)
      } else {
        sendError(res, 422, 'Attachment processing failed safely.', 'attachment_processing_failed')
      }
      return
    }

    if (!authorizePrincipalScope(req, {
      workspaceId: body.workspaceId,
      profileId: body.profileId,
    })) {
      sendError(
        res,
        403,
        'Delegated principal does not allow this workspace or profile',
        'principal_scope_denied',
        'auth',
      )
      return
    }

    const principal = getRequestPrincipal(req)
    if (
      body.attachments && body.attachments.length > 0 &&
      principal?.kind === 'delegated' &&
      !principal.operations.includes('runs.attachments')
    ) {
      sendError(
        res,
        403,
        'Delegated principal does not allow ephemeral run attachments',
        'principal_operation_denied',
        'auth',
      )
      return
    }
    const header = req.headers['idempotency-key']
    const idempotencyKey = Array.isArray(header) ? undefined : header
    if (header !== undefined && (idempotencyKey === undefined || !isValidIdempotencyKey(idempotencyKey))) {
      sendError(res, 400, 'Idempotency-Key must be a UUID', 'idempotency_key_invalid', 'invalid_request')
      return
    }
    if (principal?.kind === 'delegated' && idempotencyKey === undefined) {
      sendError(res, 400, 'Delegated run start requires Idempotency-Key', 'idempotency_key_required', 'invalid_request')
      return
    }

    const fence = idempotencyKey !== undefined && principal !== undefined && deps.idempotencyStore
      ? {
          principalKey: principalContinuityKey(principal),
          operation: 'runs.start' as const,
          key: idempotencyKey,
        }
      : undefined
    let idempotencyRecordId: string | undefined
    if (fence) {
      const claim = deps.idempotencyStore!.claim({ ...fence, input: body })
      if (claim.kind === 'replay') {
        res.setHeader('Idempotency-Replayed', 'true')
        sendJSON(res, claim.statusCode, claim.result)
        return
      }
      if (claim.kind !== 'claimed') {
        const code = `idempotency_${claim.kind}`
        if (claim.kind === 'in_progress') res.setHeader('Retry-After', '1')
        sendError(
          res,
          409,
          claim.kind === 'conflict'
            ? 'Idempotency key was already used with different input'
            : claim.kind === 'expired'
              ? 'Idempotency replay window expired; inspect the original run before acting'
              : claim.kind === 'in_progress'
                ? 'The original request is still in progress'
                : 'The original request outcome is indeterminate; inspect before acting',
          code,
          'invalid_request',
        )
        return
      }
      idempotencyRecordId = claim.recordId
    }

    // Guard: reject if this thread already has an active run.
    if (body.threadId && runner.isRunning(body.threadId)) {
      if (fence) deps.idempotencyStore!.markIndeterminate(fence)
      sendError(res, 409, 'Thread already has an active run. Abort it first.')
      return
    }

    try {
      const result = await startProfileRun(body, preparedAttachments)
      const snapshot: RunStartSnapshot = {
        runId: result.runId,
        threadId: result.threadId,
        agentId: result.agentId,
        profileId: result.profileId,
        candidateId: result.candidateId,
        model: result.model,
        status: result.status,
        ...(result.timeoutMs !== undefined ? { timeoutMs: result.timeoutMs } : {}),
      }
      if (idempotencyRecordId) {
        deps.idempotencyStore!.linkRun(idempotencyRecordId, result.runId)
      }
      if (fence) deps.idempotencyStore!.complete({ ...fence, statusCode: 200, result: snapshot })
      // Return thread ID — client connects to the SSE endpoint to watch.
      sendJSON(res, 200, fence ? snapshot : {
        runId: result.runId,
        threadId: result.threadId,
        agentId: result.agentId,
        profileId: result.profileId,
        candidateId: result.candidateId,
        model: result.model,
        status: result.status,
        timeoutMs: result.timeoutMs,
        attachments: result.attachments,
      })
    } catch (err) {
      if (fence) deps.idempotencyStore!.markIndeterminate(fence)
      if (err instanceof RunStartError) {
        sendError(res, err.status, err.message, err.code, undefined, err.details)
      } else {
        sendError(res, 500, err instanceof Error ? err.message : 'Run failed')
      }
    }
  }

  /**
   * Start a single-profile background run — the SHARED core for both the
   * HTTP handler above and the scheduler. Same pipeline (profile assembly,
   * credentials, memory, tools, permission boundary); returns immediately
   * with { threadId, done }. Preflight failures throw RunStartError.
   */
  async function startProfileRun(
    params: RunRequest,
    preflightAttachments?: PreparedAttachmentBatch,
  ): Promise<RunStartResult> {
    const body = params
    const profileId = body.profileId ?? 'example'
    let threadId = body.threadId
    const workspaceId = body.workspaceId
    // Scheduler/channel callers share the same pre-mutation attachment gate.
    const preparedAttachments = preflightAttachments ?? await prepareAttachmentBatch(body.attachments)

    {
      const deployment = deps.candidateStore?.getActive(profileId)
      if (deployment?.routingState === 'paused') {
        throw new RunStartError(
          409,
          'Profile is paused and is not accepting new runs.',
          'profile_paused',
          {
            deploymentRevision: deployment.deploymentRevision,
            activeCandidateId: deployment.candidateId,
          },
        )
      }
      // 0. Resolve workspace path (if provided)
      let workspacePath: string | undefined
      if (workspaceId) {
        const ws = state.getWorkspace(workspaceId)
        if (!ws) {
          throw new RunStartError(404, `Workspace "${workspaceId}" not found`)
        }
        if (!existsSync(ws.path)) {
          throw new RunStartError(410, `Workspace path no longer exists: ${ws.path}`)
        }
        workspacePath = ws.path
        state.touchWorkspace(workspaceId)
        state.updateWorkspace(workspaceId, { lastProfileId: profileId })
      }

      // 1. Get or create thread
      let session: Session | undefined

      if (threadId) {
        const thread = state.getThread(threadId)
        if (!thread) {
          throw new RunStartError(404, `Thread "${threadId}" not found`)
        }
        session = state.getSession(threadId)
        if (!workspacePath && thread.workspaceId) {
          const ws = state.getWorkspace(thread.workspaceId)
          if (ws) workspacePath = ws.path
        }
      }

      if (!threadId) {
        const thread = state.createThread(profileId, undefined, workspaceId)
        threadId = thread.id
      }

      // 2. Resolve modelString unconditionally.
      //
      // Previous bug: this lived inside the `if (!session)` block at line
      // ~140 and defaulted to 'unknown'. On a thread's second message
      // the session is already cached, the if-branch is skipped, and
      // the response reported `model: 'unknown'`. Worse, the runtime
      // was also only set inside that branch — so the runner bailed
      // silently with "Missing session or runtime" and the chat appeared
      // frozen.
      //
      // Computing the model here means: (a) the response always carries
      // the real model string, and (b) we have a `profile` reference
      // we can use to read execution.timeoutMs below regardless of
      // whether the session is cached.
      const resolvedCandidate = await deps.candidateResolver?.resolve(profileId) ?? null
      const candidateId = resolvedCandidate?.candidateId ?? null
      if (!resolvedCandidate && !registry.has(profileId)) {
        // A just-built legacy agent may not be registered yet — re-scan user
        // dirs once. Immutable candidates resolve independently of registry.
        await registry.refreshUser()
        if (!registry.has(profileId)) {
          throw new RunStartError(404, `Profile "${profileId}" not found`)
        }
      }
      const profile = resolvedCandidate?.profile ?? await registry.get(profileId)
      if (session && state.getSessionCandidateId(threadId!) !== candidateId) {
        await state.resetSession(threadId!)
        session = undefined
      }
      const requestModel = body.model
      // Three-level precedence: request → thread → profile.
      //
      //   1. `body.model`    — explicit override on this run (the client's
      //      dropdown change rides on the next /run body).
      //   2. `thread.model`  — what the user last picked for THIS
      //      thread, persisted via setThreadModel below. This is the
      //      bit that makes the dropdown stick across reload.
      //   3. `profile.config.model` — the template default for new
      //      threads.
      //
      // Canonicalize all paths. Aliases (`haiku`, `sonnet`, etc.) get
      // resolved to the catalog's full id so the provider never sees a
      // bare alias it can't look up.
      const threadRow = state.getThread(threadId!)
      const threadModel = threadRow?.model ?? null
      const rawModel =
        requestModel != null && requestModel.length > 0
          ? requestModel
          : threadModel != null && threadModel.length > 0
            ? threadModel
            : profile.config.model
      let effectiveModel = normalizeModelId(rawModel)

      // Keyless fallback (F1): when the model is the PROFILE default and
      // its provider has no credentials on this install, swap in a model
      // that can actually answer (vault/env-keyed provider, else a
      // reachable local Ollama). Scope: profile-sourced only — an
      // explicit request/thread choice must fail honestly with the
      // provider's actionable error, never be silently second-guessed.
      // This is what makes the shipped quickstart answer with zero keys:
      // the raw curl in serve.mjs sends no model, the profile names a
      // cloud model, and without this the run dies on "not configured"
      // even though a local Ollama is sitting right there.
      const modelCameFromProfile =
        !(requestModel != null && requestModel.length > 0) &&
        !(threadModel != null && threadModel.length > 0)
      if (modelCameFromProfile) {
        const providerId = effectiveModel.includes(':')
          ? effectiveModel.slice(0, effectiveModel.indexOf(':'))
          : effectiveModel
        if (getProvider(providerId) == null) {
          const fallback = await pickRunnableDefaultModel()
          if (fallback != null) {
            console.log(
              `[ownware] profile model "${effectiveModel}" has no credentials — answering with "${fallback}" instead`,
            )
            effectiveModel = normalizeModelId(fallback)
          }
        }
      }
      const modelString = effectiveModel

      // Persist the dispatched model onto the thread so reload + the
      // next turn see the same selection. Idempotent: a no-op write of
      // the same value when the user hasn't switched. Both writers
      // (this and the PATCH /threads/:id endpoint) converge on the
      // same column.
      if (effectiveModel !== threadModel) {
        state.setThreadModel(threadId!, effectiveModel)
        // A cached session is bound to the OLD provider (the model is
        // resolved into the session's provider only inside the
        // `if (!session)` assembly block below). Without this, switching
        // the model on a thread that already has a session keeps running
        // the old model. Swap the provider on the live session so the new
        // model takes effect on THIS turn, preserving conversation
        // history. (A fresh thread has no session yet → assembled with the
        // model directly below.)
        if (session) {
          session.setModel(effectiveModel, resolveProvider(effectiveModel).provider)
        }
      }

      // 3. Create session if needed (new thread or no cached session)
      if (!session) {
        const profileToAssemble = effectiveModel !== profile.config.model
          ? { ...profile, config: { ...profile.config, model: effectiveModel } }
          : profile

        // 3a. Per-thread credential runtime + HITL. Built BEFORE
        // assembleAgent so the system prompt can name the .env-imported
        // credentials on the very first turn. Values stay in the vault
        // and the in-memory cache — never in the prompt.
        // The vault-touching construction (credential runtime + best-effort
        // workspace .env import) is the ONE canonical credential builder,
        // shared with the approve-execute path (8d-4) via
        // buildThreadCredentialRuntime. Values stay in the vault + in-memory
        // cache, never the prompt. The CredentialHITL below is session-only
        // (an unattended approve-execute has no human to prompt).
        const { credentialRuntime, credentialConfigVars } =
          await buildThreadCredentialRuntime(threadId!, workspacePath)
        const credentialHITL = new CredentialHITL({
          timeoutMs: profileToAssemble.config.security.hitlTimeoutMs,
        })

        // (The desktop pane runtime + workspace build-board tool wiring
        // were removed with the legacy desktop shell.)

        // Late-bound HITL reference for `approve` hook actions. The
        // HumanInTheLoop instance is constructed AFTER assembly (it needs
        // the assembled zone manager alongside it), but the hook binding
        // is compiled DURING assembly — so the approver closure reads
        // this holder at fire time. A hook can only fire once the run is
        // underway, long after the assignment below; the null branch is
        // pure defense (fail-closed deny, never allow).
        let hookApprovalHitl: HumanInTheLoop | null = null
        const hookApprovalThreadId = threadId!

        const assembled = await assembleAgent(profileToAssemble, {
          webSearchService: deps.webSearchService,
          ...(deps.toolProviders !== undefined ? { toolProviders: deps.toolProviders } : {}),
          credentialContext: {
            credentialHandles: credentialRuntime.listHandles(),
            configVars: credentialConfigVars,
          },
          // Hook policy: operator env opt-ins (command hooks, webhook
          // allowlist) + credential redaction over hook payloads. The
          // redactor closure reads the thread's live credential runtime
          // at fire time, so credentials stored mid-session are scrubbed
          // from later webhook/save_json payloads too. This is a legal
          // consumer of listAllCredentialValues — a redactor replacement
          // map, same class as the shell output redactor.
          hooks: {
            ...hookBindingOptionsFromEnv(),
            redactValues: () =>
              credentialRuntime.listAllCredentialValues().map((v) => v.value),
            // `approve` hook actions pause the run on the SAME per-thread
            // permission HITL the zone system uses — so the answer comes
            // through the existing POST /threads/:id/resume endpoint,
            // the same abort path (denyAllHitls) unblocks it, and the
            // same hitlTimeoutMs denies an unanswered prompt. We ingest
            // a permission.request event so the web UI's permission card
            // AND channel clients (via SSE) can present the decision.
            requestHookApproval: async (req) => {
              const hitlRef = hookApprovalHitl
              if (!hitlRef) {
                return {
                  approved: false,
                  reason: 'Approval channel not ready — denied (fail-closed).',
                }
              }
              const requestId = `hookapproval_${randomUUID().replace(/-/g, '').slice(0, 12)}`
              const activeRun = runner.get(hookApprovalThreadId)
              if (!activeRun || !deps.runStore) {
                return {
                  approved: false,
                  reason: 'Durable approval identity unavailable — denied (fail-closed).',
                }
              }
              let operationHash: string
              try {
                const permission = deps.runStore.recordPermissionRequest({
                  runId: activeRun.runId,
                  requestId,
                  toolName: req.toolName,
                  toolInput: req.toolInput,
                })
                operationHash = permission.operationHash
                deps.runStore.markWaiting(activeRun.runId)
                state.eventIngestor.ingestParentEvent(hookApprovalThreadId, {
                  type: 'permission.request',
                  requestId,
                  operationHash,
                  toolName: req.toolName,
                  input: req.toolInput,
                  reason: req.reason,
                  turnIndex: req.turnIndex,
                } as unknown as LoomEvent)
              } catch {
                return {
                  approved: false,
                  reason: 'Approval request could not be recorded — denied (fail-closed).',
                }
              }
              const approved = await hitlRef.requestApproval(
                { id: requestId, name: req.toolName, input: req.toolInput },
                req.reason,
              )
              const currentPermission = deps.runStore.getPermissionRequest(activeRun.runId, requestId)
              if (currentPermission?.status === 'pending') {
                deps.runStore.decidePermission(
                  activeRun.runId,
                  requestId,
                  operationHash,
                  approved ? 'approve' : 'deny',
                )
              }
              if (hitlRef.pendingCount === 0) {
                deps.runStore.markRunningAfterDecision(activeRun.runId)
              }
              try {
                state.eventIngestor.ingestParentEvent(hookApprovalThreadId, {
                  type: 'permission.response',
                  requestId,
                  granted: approved,
                  turnIndex: req.turnIndex,
                } as unknown as LoomEvent)
              } catch {
                // Non-fatal — the decision already resolved the run.
              }
              return {
                approved,
                ...(approved
                  ? {}
                  : { reason: `The operator denied "${req.toolName}" (approval prompt).` }),
              }
            },
          },
          workspacePath: workspacePath ?? null,
          ...(deps.memorySystem !== undefined
            ? { memory: { system: deps.memorySystem, threadId: threadId! } }
            : {}),
          // F4.b: route MCPManager state transitions onto the status
          // bus so transport closures hit the connector SSE channel
          // without waiting for the next tool call to probe the dead
          // server.
          ...(deps.connectorStatusBus !== undefined
            ? { connectorStatusBus: deps.connectorStatusBus }
            : {}),
          // Composer-picked active context for this turn. The assembler
          // builds the <active-skills> block in the system prompt so the
          // agent follows the user's pinned skill rubric on the very
          // next turn.
          ...(body.activeContext !== undefined
            ? { activeContext: body.activeContext }
            : {}),
          // Slice B10 — per-turn vertical-owned system-prompt extension.
          // Cortex is a passthrough: the string is concatenated into the
          // assembled system prompt without parsing, so any client
          // vertical can attach its own context blocks while cortex
          // stays product-agnostic (Principle 22 — no per-vertical block
          // names in shared code).
          ...(body.systemPromptAppend !== undefined &&
          body.systemPromptAppend.length > 0
            ? { systemPromptAppend: body.systemPromptAppend }
            : {}),
        })

        // Audit Hazard 21 fix — attach MCP manager for cleanup
        state.setMCPManager(threadId, assembled.mcpManager)

        // Set up the managed-Chrome lifecycle. IMPORTANT: we do NOT
        // spawn Chrome here. A deferred launcher is registered on the
        // session config; Loom's browser tools call it lazily on the
        // FIRST `browser_*` tool invocation. Profiles that include
        // browser tools but never call them (e.g. the user just said
        // "hi") pay zero cost — no Chrome window, no RAM, no temp dir.
        //
        // `autoLaunch === "auto"` (the default) only registers the
        // provider when the assembled tool set actually contains a
        // `browser_*` tool. `true` always registers; `false` never does.
        //
        // The `onLaunched` hook stashes the RunningChrome into
        // `state.chromeLaunches` BEFORE any caller sees the CDP URL so
        // the shutdown paths (`deleteThread`, `gateway.stop()`) can
        // reliably kill it even if the first browser tool call races a
        // teardown.
        let browserCdpUrlProvider: (() => Promise<string>) | undefined
        let browserDefaultTargetId: string | undefined
        let browserActiveTargetProvider: (() => Promise<string | null>) | undefined
        let browserCreateTabHook:
          | ((url: string) => Promise<{ targetId: string; url: string; title?: string }>)
          | undefined
        // Loopback (localhost / 127.x / ::1) navigation. OFF by default so the
        // cloud / standalone packaging keeps localhost SSRF-blocked. Turned ON
        // only for the embedded desktop browser below, where the agent already
        // reaches localhost via the shell tool — so blocking the browser from a
        // local dev server is pure friction ("preview my dev server").
        let browserAllowLoopback = false
        const wantsBrowser =
          profileToAssemble.config.browser.autoLaunch === true ||
          (profileToAssemble.config.browser.autoLaunch === 'auto' &&
            assembled.tools.some(t => t.name.startsWith('browser_')))

        // The Electron desktop client can hand the gateway a browser to
        // drive — its in-app embedded WebContentsView, exposed over the app's
        // CDP endpoint — instead of the gateway launching a SEPARATE headless
        // Chrome. When `OWNWARE_BROWSER_CDP_URL` is set we drive that, and
        // `OWNWARE_BROWSER_TARGET_ID` pins the exact target so Loom never grabs
        // the client's own UI. Absent in the cloud / standalone packaging (no
        // Electron) → the deferred headless launcher below is used as before.
        const embeddedCdpUrl = process.env.OWNWARE_BROWSER_CDP_URL
        const embeddedTargetId = process.env.OWNWARE_BROWSER_TARGET_ID
        const brokerUrl = process.env.OWNWARE_BROWSER_BROKER_URL

        // Embedded mode needs the CDP url AND a way to pin the right target —
        // either a static target id OR the broker (which reports the active
        // tab). Without one of those, a bare connectOverCDP could grab the
        // client's OWN UI, so we fall back to headless Chrome.
        const hasPin =
          (embeddedTargetId != null && embeddedTargetId !== '') ||
          (brokerUrl != null && brokerUrl !== '')

        if (wantsBrowser && embeddedCdpUrl != null && embeddedCdpUrl !== '' && hasPin) {
          const url = embeddedCdpUrl
          browserCdpUrlProvider = () => Promise.resolve(url)
          // Desktop embedded browser → allow the agent to preview localhost dev
          // servers (the watch-the-agent-browse view). LAN/private ranges stay
          // blocked in Loom regardless.
          browserAllowLoopback = true
          if (embeddedTargetId != null && embeddedTargetId !== '') {
            browserDefaultTargetId = embeddedTargetId
          }
          if (brokerUrl != null && brokerUrl !== '') {
            const base = brokerUrl
            // Drive whichever tab is active right now (user OR agent switched it).
            browserActiveTargetProvider = async () => {
              try {
                const r = await fetch(`${base}/active-target`)
                const j = (await r.json()) as { targetId?: string | null }
                return j.targetId ?? null
              } catch {
                return null
              }
            }
            // Let the agent OPEN tabs — Electron can't create CDP targets, so
            // the app creates a real tab and returns its id for the agent to drive.
            browserCreateTabHook = async (tabUrl: string) => {
              const r = await fetch(`${base}/tab`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ url: tabUrl }),
              })
              return (await r.json()) as { targetId: string; url: string; title?: string }
            }
          }
        } else if (wantsBrowser) {
          const launchFn = deps.launchChromeFn ?? launchChrome
          const launchOpts: LaunchChromeOptions = {
            headless: profileToAssemble.config.browser.headless,
            noSandbox: profileToAssemble.config.browser.noSandbox,
            extraArgs: profileToAssemble.config.browser.extraArgs,
            readyTimeoutMs: profileToAssemble.config.browser.readyTimeoutMs,
            ...(profileToAssemble.config.browser.port !== undefined
              ? { port: profileToAssemble.config.browser.port }
              : {}),
            ...(profileToAssemble.config.browser.userDataDir !== undefined
              ? { userDataDir: profileToAssemble.config.browser.userDataDir }
              : {}),
          }
          const capturedThreadIdForChrome = threadId!
          const deferred = createDeferredChromeLauncher({
            launchOptions: launchOpts,
            launchFn,
            onLaunched: running => {
              state.setChromeLaunch(capturedThreadIdForChrome, running)
            },
          })
          browserCdpUrlProvider = () => deferred.getCdpUrl()
          // Also hand the launcher itself to state, so `stop()` works
          // even if no browser tool ever fired (no-op in that case, but
          // the kill path stays uniform across code paths).
          state.setChromeLauncher(threadId, deferred)
        }

        // Wire HITL + zones — timeout prevents a decoupled run from
        // blocking forever on a permission prompt nobody will answer.
        const hitl = new HumanInTheLoop({
          timeoutMs: profile.config.security.hitlTimeoutMs,
        })
        // Arm the approve-hook channel (see requestHookApproval above).
        hookApprovalHitl = hitl
        const zoneManager = assembled.zoneManager ?? null

        let lastZoneDecision: ZoneDecision | null = null

        // Session-mutable list of additional workspace roots the user has
        // granted via the HITL permission flow (scope='session'). The
        // SAME array reference flows into LoomConfig — `readonly string[]`
        // is a compile-time guarantee only, so subsequent `.push(...)`
        // calls from the permission-response endpoint are visible to the
        // loop on the very next ToolContext build (loop.ts:1099 reads
        // `config.additionalWorkspaceRoots` per tool call). Sub-agents
        // inherit the same reference through their LoomConfig copy, so a
        // grant on the parent thread immediately covers helper agents.
        const sessionAdditionalRoots: string[] = []

        const baseSessionConfig = mergeConfig(assembled.config, {
          ...(workspacePath ? { workspacePath } : {}),
          additionalWorkspaceRoots: sessionAdditionalRoots,
        })

        // Spawn tool pool. Starts as the parent's assembled tools. A
        // referenced helper that ships its OWN custom tools (e.g. the
        // gatherer's scan_* — tools the parent cannot share as builtins)
        // gets those tools merged in by the subagent loop below, so the
        // spawned child can actually call them. The spawner stores this
        // array by reference, and spawns only happen once the run starts
        // (after this whole block), so pushing into it in the loop is safe.
        // NOTE: only the spawner's isolation POOL is widened — the parent's
        // own callable tool set (the `Session` below) stays `assembled.tools`,
        // so the builder never gains the ability to scan directly.
        const spawnerToolPool: Tool[] = [...assembled.tools]
        const spawnerPoolNames = new Set(spawnerToolPool.map(t => t.name))

        // Wire sub-agent spawner
        const capturedThreadId = threadId!
        const spawner = new AgentSpawner({
          provider: assembled.provider,
          tools: spawnerToolPool,
          config: baseSessionConfig,
          onEvent: (event, subagentId) => {
            trace('spawner-recv', capturedThreadId, subagentId, event.type)
            try {
              state.eventIngestor.ingestSubagentEvent(
                capturedThreadId,
                subagentId,
                event,
              )
            } catch (err) {
              trace('spawner-ingest-fail', capturedThreadId, subagentId, event.type, {
                err: err instanceof Error ? err.message : String(err),
              })
              console.error('[run] subagent event ingest failed:', err)
            }
            // Sub-agent lifecycle events are emitted by the spawner's
            // generator, NOT the parent session's. Without this hook
            // the parent runner's accumulator never sees them and the
            // saved messages row has empty subAgents[]/parts[] entries
            // for the helper. Forwarding agent.spawn + agent.complete
            // here is what closes that loop.
            //
            // We deliberately do NOT forward other sub-agent events
            // (text.delta, tool.call.*, etc.) — those belong to the
            // sub-agent's own stream, not the parent's reduced row.
            if (event.type === 'agent.spawn' || event.type === 'agent.complete') {
              try {
                const consumed = runner.notifyParentLifecycleEvent(capturedThreadId, event)
                trace('spawner-lifecycle-forward', capturedThreadId, subagentId, event.type, {
                  consumed,
                })
                if (!consumed && event.type === 'agent.complete') {
                  state.patchMessageSubAgent(capturedThreadId, event.agentId, {
                    status: 'completed',
                    result: event.result,
                    durationMs: event.durationMs,
                    toolCount: (event as { toolCount?: number }).toolCount,
                    turnCount: (event as { turnCount?: number }).turnCount,
                  })
                  trace('spawner-lifecycle-fallback', capturedThreadId, subagentId, event.type, {
                    agent: event.agentId,
                  })
                }
              } catch (err) {
                trace('spawner-lifecycle-fail', capturedThreadId, subagentId, event.type, {
                  err: err instanceof Error ? err.message : String(err),
                })
                console.error('[run] parent lifecycle notify failed:', err)
              }
            }
          },
        })

        // Resolve subagent specs. A subagent may be declared inline
        // (with systemPrompt/model/tools embedded in the parent profile)
        // or by reference (`{ name, profile: "<helper-name>" }`) which
        // points at a standalone profile on disk. References win when
        // both forms are present; inline fields on the reference act
        // as per-parent overrides (e.g. parent tightens tools or swaps
        // model for a specific helper usage). Grants (if declared)
        // pass named parent tools down to the child and are validated
        // against the parent's assembled tool set.
        const parentToolNames = new Set(assembled.tools.map(t => t.name))
        const subagentDefs: Record<string, {
          model?: string; tools?: string[]; systemPrompt?: string; maxTurns?: number; persistentReminder?: string
        }> = {}
        for (const sa of profile.config.subagents) {
          let refProfile: Awaited<ReturnType<typeof registry.get>> | null = null

          // Resolution chain (helpers folder first, then global registry).
          //
          // 1. If the parent ships a `helpers/<name>/` directory matching
          //    the subagent's resolved name (`sa.profile ?? sa.name`),
          //    load that local helper. This is the per-profile private
          //    helper convention — nested helpers are scoped to their
          //    enclosing profile and never appear in the global registry.
          // 2. Else, if `sa.profile` is set, look up that name in the
          //    global registry (top-level peer profiles).
          // 3. Else, the subagent is treated as inline (no refProfile).
          //
          // Order matters: a parent can shadow a global profile with a
          // private helper of the same name, mirroring the registry's
          // existing builtin/user shadow semantics.
          const lookupName = sa.profile ?? sa.name
          const helperDir = await resolveLocalHelperDir(profile.basePath, lookupName)
          if (helperDir !== null) {
            // Load the helper inline — it's a real LoadedProfile, just
            // not registered globally.
            refProfile = await loadLocalHelperProfile(helperDir)
          } else if (sa.profile) {
            if (!registry.has(sa.profile)) {
              throw new Error(
                `Subagent "${sa.name}" references profile "${sa.profile}" which is not registered.`,
              )
            }
            refProfile = await registry.get(sa.profile)
          }

          // Self-contained helper tools. A referenced helper that ships
          // its OWN custom tools (the gatherer's scan_*) cannot get them
          // through the default isolate-from-parent path — the parent
          // definitionally lacks them. Assemble such a helper, merge its
          // tools into the spawn pool, and scope the child to exactly its
          // own tool set (below). Guard on `tools.custom.length` so this
          // touches ONLY helpers with private tools: every preset-only
          // helper (explore, verifier, …) is skipped and keeps its
          // existing inherit-from-parent resolution byte-for-byte.
          let helperOwnTools: Tool[] | null = null
          if (refProfile && refProfile.config.tools.custom.length > 0) {
            const helperAsm = await assembleAgent(refProfile, {
              webSearchService: deps.webSearchService,
              ...(deps.toolProviders !== undefined ? { toolProviders: deps.toolProviders } : {}),
              credentialContext: {
                credentialHandles: credentialRuntime.listHandles(),
                configVars: credentialConfigVars,
              },
              // Same operator hook policy as the parent assembly — a
              // helper profile with command hooks must not fail assembly
              // when the operator HAS opted in (or silently differ from
              // the parent's policy when they haven't).
              hooks: hookBindingOptionsFromEnv(),
              workspacePath: workspacePath ?? null,
            })
            helperOwnTools = [...helperAsm.tools]
            for (const t of helperOwnTools) {
              if (!spawnerPoolNames.has(t.name)) {
                spawnerToolPool.push(t)
                spawnerPoolNames.add(t.name)
              }
            }
          }

          const resolved = resolveSubagentDef({
            spec: sa,
            refProfile,
            parentToolNames,
            parentSkills: profile.skills,
          })

          // Subagent envelope coverage. Spawned helpers used to receive
          // ONLY their SOUL.md as systemPrompt, missing the universal
          // Loom hygiene fragments (system rules, thinking-frequency,
          // safety-principle, output style, compaction, tool-usage)
          // every top-level profile gets. Production-grade fix: run
          // the helper through the same fragment assembly the main
          // agent uses, with the helper's resolved tool subset.
          //
          // Helper tools = parent's assembled.tools filtered by the
          // helper's effective allow list. When the helper inherits
          // (no allow restriction), it sees the full parent tool set.
          // This mirrors the runtime tool gating Loom applies to the
          // spawned session and ensures createToolUsageFragment renders
          // exactly the rules relevant to what the helper can actually
          // call.
          let envelopedSystemPrompt = resolved.systemPrompt
          if (refProfile) {
            // Self-contained helpers envelope from their OWN tools; all
            // other helpers keep filtering the parent's assembled set.
            const helperToolNames = resolved.tools
            const helperTools = helperOwnTools
              ? helperOwnTools
              : helperToolNames
                ? assembled.tools.filter(t => helperToolNames.includes(t.name))
                : assembled.tools
            envelopedSystemPrompt = buildSubagentSystemPrompt(
              refProfile,
              helperTools,
            )
          }

          subagentDefs[sa.name] = {
            // Spawned helpers inherit the PARENT run's resolved brain (so a
            // model picked for the builder, e.g. deepseek, also drives the
            // gatherer) — unless the helper spec explicitly pins its own model.
            // The helper profile's own `model` stays the fallback for when it
            // runs standalone (no parent override).
            model: sa.model ?? effectiveModel,
            // Self-contained helpers are scoped to exactly their own tool
            // names so `isolateTools` hands the child its private set out
            // of the widened spawn pool (not the parent's tools).
            tools: helperOwnTools
              ? helperOwnTools.map(t => t.name)
              : resolved.tools ? [...resolved.tools] : undefined,
            systemPrompt: envelopedSystemPrompt,
            maxTurns: resolved.maxTurns,
            ...(resolved.persistentReminder && resolved.persistentReminder.trim().length > 0
              ? { persistentReminder: resolved.persistentReminder }
              : {}),
          }
        }

        // Speech-to-text provider for Loom's `speech_transcribe` tool.
        // `sttProvider` IS a typed LoomConfig field — bound to the highest-
        // priority configured speech key. Null (no key configured) leaves the
        // tool in its `no_provider` branch, same shared keys as chat.
        const sttProvider = deps.credentialStore
          ? await selectSttProvider(deps.credentialStore)
          : null

        const sessionConfig = Object.assign({}, baseSessionConfig, {
          agentSpawner: spawner,
          subagentDefs,
          ...(sttProvider ? { sttProvider } : {}),
          // `browserCdpUrlProvider` is read by Loom's browser-session
          // tools as a dynamic field on ToolContext.config. It's an
          // async function that spawns Chrome on first call and caches
          // the URL for the session. Added via Object.assign mirroring
          // how agentSpawner is plumbed — neither field is declared on
          // LoomConfig, both are consumed at runtime.
          ...(browserCdpUrlProvider ? { browserCdpUrlProvider } : {}),
          // Loom reads `browserDefaultTargetId` (ToolContext.config) to drive a
          // SPECIFIC CDP target by default — set when the desktop client supplies its
          // embedded view, so a bare connectOverCDP to the app's multi-target
          // endpoint drives the right page, not the client's own UI.
          ...(browserDefaultTargetId ? { browserDefaultTargetId } : {}),
          // `browserActiveTargetProvider` → drive whichever tab is active now;
          // `browserCreateTabHook` → let the agent open real tabs via the app's
          // broker (Electron can't create CDP targets from outside). Both unset
          // outside the Electron desktop packaging.
          ...(browserActiveTargetProvider ? { browserActiveTargetProvider } : {}),
          ...(browserCreateTabHook ? { browserCreateTabHook } : {}),
          // `browserAllowLoopback` → Loom's browser tools permit localhost
          // navigation (desktop dev-server preview). Untyped runtime field on
          // ToolContext.config, same plumbing as the browser hooks above.
          ...(browserAllowLoopback ? { browserAllowLoopback: true } : {}),
          // Per-thread task store adapter. Loom's `todo_write` tool
          // reads `config.taskStore` the same way memory tools read
          // `config.memoryStore`. When the dep is omitted (older
          // bootstrap paths, tests), the tool gracefully returns its
          // `no_store` branch.
          ...(deps.taskStore != null
            ? { taskStore: createThreadScopedTaskStore(deps.taskStore, threadId!) }
            : {}),
          // Per-workspace agent PTY shell runner. Routes Loom's
          // `shell_execute` through the workspace's agent terminal so
          // shell state (cd, venv, env vars) persists across tool
          // calls. The agent PTY is dedicated to `shell_execute` —
          // user-owned PTYs are not reachable through this path. Only
          // wired when BOTH a registry and a workspace id exist —
          // sessions without a workspace fall back to the detached-
          // spawn branch in `shell_execute`.
          ...(deps.terminalRegistry != null && workspaceId != null
            ? { shellRunner: createWorkspaceAgentShellRunner(deps.terminalRegistry, workspaceId) }
            : {}),
        })

        // Draft-for-approval hold sink (Slice 8d): when a draft-approval
        // scheduled run has an approvals store + run ids, each held write/send
        // tool parks an approval (the draft) instead of executing. Absent →
        // applyRunSafety fails closed to read-only (never executes a write).
        const holdSink: HoldSink | undefined =
          body.safetyLevel === 'draft-approval' &&
          deps.approvalStore != null &&
          body.approvalScheduleId != null &&
          body.approvalRunId != null
            ? {
                hold: ({ toolName, toolInput }): void => {
                  // The HoldSink contract says the sink owns its own error
                  // routing and must never throw back into the agent loop. Honor
                  // it: if persisting the draft fails (e.g. a SQLite error), the
                  // failure MUST be logged, not swallowed (Principle 21) — a
                  // silently-lost park in the safety path would tell the model
                  // "queued for approval" while the user never sees the draft.
                  // Log ids + the tool name only — NEVER toolInput (it may carry
                  // the email body / file contents the user is composing).
                  try {
                    deps.approvalStore!.create({
                      scheduleId: body.approvalScheduleId!,
                      runId: body.approvalRunId!,
                      threadId: threadId ?? null,
                      toolName,
                      toolInput,
                      summary: summarizeHeldCall(toolName, toolInput),
                    })
                  } catch (err) {
                    console.error(
                      `[schedule-approval] failed to park held "${toolName}" for run ` +
                        `${body.approvalRunId} (schedule ${body.approvalScheduleId}):`,
                      err,
                    )
                  }
                },
              }
            : undefined

        // Safe-by-default is TRANSITIVE across delegation. The parent Session
        // below is enveloped by `applyRunSafety`, but a scheduled run can also
        // call `agent_spawn` (it is `isReadOnly`, so it survives the read-only /
        // draft-approval filter) and the spawner's tool POOL is the FULL
        // unfiltered `assembled.tools` (widened above with helper-own tools).
        // Enveloping that pool IN PLACE — now that it is fully built and the
        // hold sink exists — makes every child inherit the SAME envelope, so a
        // read-only / draft-approval run can never send/write through a child.
        // (Live-verified before this fix: a read-only run wrote a file via a
        // sub-agent.) Interactive runs (no safetyLevel) are a no-op.
        envelopeSpawnerPool(spawnerToolPool, body.safetyLevel, holdSink)

        session = new Session({
          config: sessionConfig,
          provider: assembled.provider,
          // Unattended safety envelope (Slices 8b/8d): a scheduled run is handed
          // ONLY the tools its level permits — read-only withholds writes;
          // draft-approval WRAPS each write/send so calling it parks an approval
          // (the draft) instead of executing; full-access passes through.
          // Interactive / HTTP runs pass no safetyLevel → full assembled set.
          tools:
            body.safetyLevel != null
              ? applyRunSafety(assembled.tools, body.safetyLevel, holdSink)
              : assembled.tools,
          checkpoint: assembled.checkpointStore,

          // Profile-declared lifecycle hooks (assembler compiled them via
          // profile/hooks.ts). BOTH fields ship together — the runtime
          // emits its outcomes into this exact injector instance; passing
          // one without the other would silently drop the model-visible
          // hook feedback loop (blocked reasons, hook output reminders).
          ...(assembled.hookRuntime ? { hooks: assembled.hookRuntime } : {}),
          ...(assembled.reminderInjector ? { reminders: assembled.reminderInjector } : {}),

          // Permission mode. A scheduled (headless) run runs 'auto' — there is
          // no human to answer an 'ask', so capability is the tool filter above,
          // never a prompt that would hang forever (mirrors team members,
          // team/member-policy.ts). An interactive run keeps the profile's
          // configured mode so its pre-callback bypass + zone-manager
          // checkPermission below behave exactly as before.
          permissionMode:
            body.safetyLevel != null ? 'auto' : profile.config.security.permissionMode,

          checkPermission: zoneManager
            ? async (tool) => {
                const decision = zoneManager.evaluate({
                  toolName: tool.name,
                  input: tool.input,
                  sessionId: assembled.config.sessionId,
                  workspacePath,
                })
                lastZoneDecision = decision
                // Return the rich CheckPermissionResult so the loop's
                // `permission.request` event carries the classification
                // metadata (zone level, severity tag, severity reason).
                // The client's permission card uses these to render an
                // appropriate severity badge + warning copy.
                return {
                  decision: decision.decision,
                  zoneLevel: decision.classification.level,
                  zoneName: decision.classification.zoneName,
                  explanation: decision.explanation,
                  ...(decision.classification.severityTag !== undefined
                    ? { severityTag: decision.classification.severityTag }
                    : {}),
                  ...(decision.classification.severityReason !== undefined
                    ? { severityReason: decision.classification.severityReason }
                    : {}),
                }
              }
            : undefined,

          requestApproval: async (tool) => {
            const reason = lastZoneDecision?.explanation
              ?? 'Tool requires explicit approval'
            return hitl.requestApproval(tool, reason)
          },

          // Credential isolation wiring — see packages/cortex/CLAUDE.md.
          // All four callbacks read from the per-thread credentialRuntime
          // + credentialHITL we built above. The vault stays the
          // exclusive source of truth for plaintext values; the agent
          // never touches these closures directly (they live inside
          // Loom's ToolContext).
          credentials: {
            requestCredential: async (req) => {
              return credentialHITL.request({
                requestId: req.requestId,
                label: req.label,
                hint: req.hint,
                usage: req.usage,
                placement: req.placement,
                isRequired: req.isRequired,
                createdAt: Date.now(),
              })
            },
            resolveCredential: (id) => credentialRuntime.resolveValue(id),
            listEnvCredentials: () => credentialRuntime.listEnvCredentials(),
            listAllCredentialValues: () => credentialRuntime.listAllCredentialValues(),
          },
        })

        hitl.onApprovalNeeded(() => {
          // The loop emits permission.request before calling requestApproval.
          // SSE clients pick it up from the EventBus. No additional work needed.
        })

        state.setSession(threadId, session)
        state.setSessionCandidateId(threadId, candidateId)
        // Stash hitl + zoneManager + lastZoneDecision accessor next to
        // the session. These are captured by closures inside the Session
        // (requestApproval, checkPermission) and reused for every turn.
        // Persisting them here means the per-run runtime sentinel can
        // be rebuilt on every subsequent run without recreating these
        // resources — recreating hitl in particular would silently
        // break HITL because the session would still hold a reference
        // to the old one in its requestApproval closure.
        // Registry: every HITL this session owns, in register order.
        // The abort handler iterates this exact array — the two direct
        // `hitl` / `credentialHITL` fields above stay for callers that
        // need type-specific access (e.g. credential endpoints calling
        // `credentialHITL.respond`). A new HITL adds one line here
        // (`asHitlLike('<name>', theNewHitl)`) and the abort path picks
        // it up structurally.
        const hitls: readonly HITLLike[] = [
          asHitlLike('permission', hitl),
          asHitlLike('credential', credentialHITL),
        ]
        state.setSessionCompanions(threadId, {
          hitl,
          zoneManager,
          getLastZoneDecision: () => lastZoneDecision,
          credentialHITL,
          credentialRuntime,
          // Side-task model is profile-declared. When absent (most
          // profiles today), the gateway keeps using the non-LLM
          // defaults for those tasks — see session-runner.ts.
          smallFastModel: profileToAssemble.config.smallFastModel ?? null,
          hitls,
          sessionAdditionalRoots,
        })

        // Seed the live-reconcile baseline: the connector-sourced
        // tools the session was just born with are exactly what
        // future reconciles diff against. Without this, the first
        // reconcile (after e.g. an attach) would treat EVERY
        // connector tool as new and duplicate-install them on the
        // session — addTool throws on duplicate names. Skipped when
        // no tracker is wired (older bootstrap paths, tests).
        if (deps.pendingReconciles !== undefined) {
          deps.pendingReconciles.setManaged(
            threadId,
            initialManagedTools(assembled.connectorTools),
          )
        }
      }

      // 4. Always (re)set runtime sentinel for this run.
      //
      // The runtime entry is per-run — created here, deleted in the
      // runner's finally. It MUST exist when consumeLoop pulls it (else
      // the loop bails with "Missing session or runtime"), so we set it
      // even when reusing a cached session. The companion fields come
      // from the persistent SessionCompanions slot so hitl/zoneManager
      // identity matches what the session's closures captured.
      //
      // Defensive: if companions are missing for a cached session
      // (in-memory state corruption, race), fail fast rather than
      // proceeding with a half-wired runtime.
      const companions = state.getSessionCompanions(threadId)
      if (!companions) {
        throw new RunStartError(500, `Session companions missing for thread "${threadId}"`)
      }
      state.setRuntime(threadId, {
        session: session!,
        hitl: companions.hitl,
        zoneManager: companions.zoneManager,
        lastZoneDecision: companions.getLastZoneDecision,
      })

      // 3. Process attachments (if any)
      let promptContent: string | ContentBlock[] = body.prompt
      let attachmentMeta: AttachmentMeta[] | undefined

      if (preparedAttachments !== undefined) {
          const contentBlocks: ContentBlock[] = [
            { type: 'text', text: body.prompt },
          ]

          attachmentMeta = preparedAttachments.metadata

          for (const result of preparedAttachments.results) {
            contentBlocks.push(...result.blocks)
          }

          promptContent = contentBlocks
      }

      const timeoutMs = profile.timeoutMs
      let runId: string
      try {
        runId = deps.runStore?.create({
          threadId: threadId!,
          ...(workspaceId !== undefined ? { workspaceId } : {}),
          profileId,
          ...(candidateId !== null ? { candidateId } : {}),
          model: modelString,
          timeoutMs,
          startSeq: state.getAgentEventMaxSeq(threadId!, 'root'),
        }).runId ?? randomUUID()
      } catch (error) {
        if (!(error instanceof ProfileRunNotAcceptingError)) throw error
        state.deleteRuntime(threadId!)
        throw new RunStartError(
          409,
          'Profile is paused and is not accepting new runs.',
          'profile_paused',
          { deploymentRevision: error.deploymentRevision },
        )
      }

      // 4. Save user message
      state.addMessage(threadId, {
        id: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
        role: 'user',
        content: body.prompt,
        attachments: attachmentMeta,
        timestamp: new Date().toISOString(),
      })

      // 5. Ingest user.message event so replay stream is self-contained.
      //    user.message is a Cortex-owned gateway event (see
      //    packages/cortex/src/gateway/events.ts) — Loom never emits it
      //    because user input is not an agent event. The cast widens to
      //    LoomEvent because the ingestor's LoomEvent-typed write path
      //    persists any discriminated `type` payload verbatim.
      try {
        const userEvent: UserMessageEvent = {
          type: 'user.message',
          text: body.prompt,
          attachments: attachmentMeta ?? null,
          timestamp: Date.now(),
        }
        state.eventIngestor.ingestParentEvent(threadId!, userEvent as unknown as LoomEvent)
      } catch {
        // Non-fatal — messages table already has the user message
      }

      // 6. Start background run — returns immediately. The resolved
      // profile's timeout and immutable run record were fixed before the
      // first user-message mutation above.

      // Flip thread.status → 'active' so SSE handlers + hydrate read the
      // authoritative "this thread can receive future events right now"
      // signal. The previous run's finalizer sets status to
      // 'completed'/'error' and nothing else re-enables it; without this
      // line the agent-events SSE for the root tab still treats the
      // thread as terminal across the second-turn boundary (see the
      // 2026-04-22 stream audit CRITICAL-2 finding + the symmetric fix
      // in handlers/agent-events.ts §4 tail-vs-close split).
      //
      // Placed here — AFTER every sync preflight (profile lookup, thread
      // create, session build, attachments, user-message write) and
      // RIGHT BEFORE runner.start() — so a rejected request (missing
      // profile, bad workspace, etc.) never leaves a thread stranded in
      // 'active' with no runtime behind it. If the runner itself fails
      // later the runner's own finally block flips status to 'error'.
      state.updateThread(threadId!, { status: 'active' })

      const handle = runner.start({
        runId,
        threadId: threadId!,
        profileId,
        model: modelString,
        prompt: promptContent,
        attachments: attachmentMeta,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      })

      // 7. Return — caller (HTTP handler / scheduler) connects/awaits.
      return {
        runId: handle.runId,
        threadId: handle.threadId,
        agentId: 'root',
        profileId,
        candidateId,
        model: modelString,
        status: 'running',
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        attachments: attachmentMeta,
        done: handle.done,
      }
    }
  }

  async function prepareAttachmentBatch(
    attachments: RunRequest['attachments'],
  ): Promise<PreparedAttachmentBatch | undefined> {
    if (!attachments || attachments.length === 0) return undefined
    let validation: ReturnType<typeof validateAttachments>
    try {
      validation = validateAttachments(attachments)
    } catch (err) {
      if (err instanceof AttachmentValidationError) {
        throw new RunStartError(
          400,
          'Attachment input is invalid.',
          'attachment_invalid',
          {
            reason: err.code,
            index: err.index,
            limits: attachmentLimits(),
          },
        )
      }
      throw err
    }
    try {
      const results = await (deps.processAttachmentsFn ?? processAttachments)(validation.attachments)
      return {
        results,
        metadata: validation.attachments.map((attachment, index) => ({
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          sizeBytes: validation.itemBytes[index]!,
          category: categorizeFile(attachment.filename, attachment.mimeType),
        })),
      }
    } catch (err) {
      console.error('[run] attachment processing failed', {
        errorType: err instanceof Error ? err.name : 'unknown',
      })
      throw new RunStartError(
        422,
        'Attachment processing failed safely.',
        'attachment_processing_failed',
      )
    }
  }

  function attachmentLimits(): Readonly<Record<string, number>> {
    return {
      maxCount: ATTACHMENT_MAX_COUNT,
      maxItemDecodedBytes: ATTACHMENT_MAX_ITEM_BYTES,
      maxTotalDecodedBytes: ATTACHMENT_MAX_TOTAL_BYTES,
      maxFilenameCharacters: ATTACHMENT_MAX_FILENAME_CHARS,
    }
  }

  // POST /api/v1/threads/:threadId/resume — respond to permission prompt
  async function resume(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    if (getRequestPrincipal(_req)?.kind === 'delegated') {
      sendError(
        res,
        403,
        'Delegated principals must use the exact run permission decision route',
        'exact_permission_route_required',
        'auth',
      )
      return
    }
    const threadId = params['threadId']!
    const thread = state.getThread(threadId)
    if (!authorizePrincipalScope(_req, {
      workspaceId: thread?.workspaceId ?? undefined,
      profileId: thread?.profileId,
    })) {
      sendError(res, 403, 'Delegated principal does not allow this thread', 'principal_scope_denied', 'auth')
      return
    }
    const body = await readJSON<ResumeRequest>(_req)
    if (!body?.action) {
      sendError(res, 400, 'Missing required field: action')
      return
    }

    const runtime = state.getRuntime(threadId)
    if (!runtime) {
      sendError(res, 404, `No active runtime for thread "${threadId}"`)
      return
    }

    const { hitl, zoneManager } = runtime
    const approved =
      body.action === 'approve' ||
      body.action === 'always' ||
      body.action === 'allow_folder_session'

    if (hitl.pendingCount === 0) {
      sendError(res, 409, 'No pending permission request')
      return
    }

    // Session-scope folder grant. Append the canonicalized grant path
    // to the session's additionalWorkspaceRoots BEFORE resolving the
    // pending HITL request — the loop's next ToolContext (built when
    // the awaited tool resumes) reads from the same array reference,
    // so the boundary check sees the grant on this very call.
    if (body.action === 'allow_folder_session') {
      if (!body.grantPath || typeof body.grantPath !== 'string') {
        sendError(res, 400, 'allow_folder_session requires "grantPath"')
        return
      }
      const companions = state.getSessionCompanions(threadId)
      if (companions) {
        const { realpath } = await import('node:fs/promises')
        let canonical = body.grantPath
        try {
          canonical = await realpath(body.grantPath)
        } catch {
          // realpath fails for non-existent paths — keep literal so a
          // grant for a yet-to-be-created folder still works.
        }
        // Reject root '/' outright — it would defeat the whole boundary.
        if (canonical === '/' || canonical === '') {
          sendError(res, 400, 'Cannot grant root "/" as a workspace folder')
          return
        }
        // Dedupe against existing grants. The boundary check accepts
        // both literal and realpath forms, so duplicate-by-realpath is
        // sufficient.
        const already = companions.sessionAdditionalRoots.some(
          (r) => r === canonical || r === body.grantPath,
        )
        if (!already) {
          companions.sessionAdditionalRoots.push(canonical)
        }
      }
    }

    if (body.requestId) {
      hitl.respond(body.requestId, approved)
    } else {
      if (approved) hitl.approveAll()
      else hitl.denyAll()
    }

    // If "always" — grant a zone expansion and (optionally) persist it.
    //
    // Scope semantics (see ResumeRequest.scope):
    //   - 'session'        in-memory only, dies with the session
    //   - 'tool' (default) persisted to disk, this exact tool name
    //   - 'profile'        persisted to disk, toolPattern '*' for the profile
    //
    // The zone level we grant is read from the original permission.request
    // event so a Zone 5 (MACHINE) approval actually sticks for Zone 5 — the
    // earlier hard-coded EXTERNAL was wrong: an "always allow" on a MACHINE
    // tool would only cover up to EXTERNAL and re-prompt on the next call.
    if (body.action === 'always') {
      const eventLog = state.getEventLog(threadId, { type: 'permission.request', limit: 1 })
      if (eventLog.length > 0) {
        const lastRequest = eventLog[eventLog.length - 1]!.event as {
          toolName?: string
          zoneLevel?: number
          reason?: string
        }
        const toolName = lastRequest.toolName
        if (typeof toolName === 'string' && toolName.length > 0) {
          // Default to BUILD (2) if the request didn't carry zoneLevel —
          // matches the lowest "ask" tier so a missing field can't
          // accidentally widen the grant.
          const zoneLevel = typeof lastRequest.zoneLevel === 'number' ? lastRequest.zoneLevel : 2
          const scope: 'session' | 'tool' | 'profile' = body.scope ?? 'tool'

          if (zoneManager) {
            // Map UI scope → ZoneExpansionTracker scope.
            //   profile → wildcard pattern '*' (any tool, this zone)
            //   tool    → specific tool name
            //   session → specific tool name, in-memory only (no save)
            const expansionPattern = scope === 'profile' ? '*' : toolName
            zoneManager.grantExpansion(
              expansionPattern,
              zoneLevel as Parameters<typeof zoneManager.grantExpansion>[1],
              'session',
            )
          }

          // Persist on tool / profile scope only. 'session' is in-memory.
          if (scope !== 'session') {
            const thread = state.getThread(threadId)
            if (thread) {
              try {
                await permissionStore.saveRule(thread.profileId, {
                  toolPattern: scope === 'profile' ? '*' : toolName,
                  maxZone: zoneLevel,
                  decision: 'allow',
                  reason: lastRequest.reason || 'Approved via UI',
                })
              } catch {
                // Zone 6 (NEVER) is hard-rejected by the store — by design.
                // Disk error: the in-memory grant still applies for the
                // session, so the user isn't stuck. Don't break the flow.
              }
            }
          }
        }
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      threadId,
      action: body.action,
      approved,
      pendingCount: hitl.pendingCount,
    }))
  }

  async function decidePermission(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const runId = params['runId']!
    const requestId = params['requestId']!
    const snapshot = deps.runStore?.get(runId) ?? null
    if (!snapshot) {
      sendError(res, 404, 'Run was not found', 'run_not_found', 'not_found')
      return
    }
    if (!authorizePrincipalScope(req, {
      workspaceId: snapshot.workspaceId ?? undefined,
      profileId: snapshot.profileId,
    })) {
      sendError(res, 403, 'Delegated principal does not allow this run', 'principal_scope_denied', 'auth')
      return
    }
    const parsed = ExactPermissionDecisionSchema.safeParse(await readJSON(req))
    if (!parsed.success) {
      sendError(res, 400, 'Exact permission decision is invalid', 'invalid_request', 'invalid_request')
      return
    }
    const permission = deps.runStore?.getPermissionRequest(runId, requestId) ?? null
    if (!permission) {
      sendError(res, 404, 'Permission request was not found for this run', 'permission_request_not_found', 'not_found')
      return
    }
    if (permission.operationHash !== parsed.data.operationHash) {
      sendError(res, 409, 'Permission operation hash does not match', 'permission_operation_mismatch', 'invalid_request')
      return
    }
    if (permission.status !== 'pending') {
      sendError(res, 409, 'Permission request was already decided', 'permission_already_decided', 'invalid_request')
      return
    }
    const active = runner.get(snapshot.threadId)
    const runtime = state.getRuntime(snapshot.threadId)
    if ((active && active.runId !== runId) || !runtime || !runtime.hitl.hasPending(requestId)) {
      sendError(res, 409, 'Permission request is no longer live', 'permission_request_stale', 'invalid_request')
      return
    }
    const outcome = deps.runStore!.decidePermission(
      runId,
      requestId,
      parsed.data.operationHash,
      parsed.data.decision,
    )
    if (outcome !== 'decided') {
      sendError(res, 409, 'Permission decision conflicted with current state', 'permission_decision_conflict', 'invalid_request')
      return
    }
    const delivered = runtime.hitl.respond(requestId, parsed.data.decision === 'approve')
    if (!delivered) {
      sendError(res, 409, 'Permission request became stale', 'permission_request_stale', 'invalid_request')
      return
    }
    if (runtime.hitl.pendingCount === 0) {
      deps.runStore!.markRunningAfterDecision(runId)
    }
    sendJSON(res, 200, {
      runId,
      requestId,
      operationHash: parsed.data.operationHash,
      decision: parsed.data.decision,
    })
  }

  function signalCancellation(
    threadId: string,
    session: Session,
    armWatchdog: boolean,
  ): void {
    try {
      session.abort('user')
    } catch (err) {
      console.error(
        `[cancel] abort signal failed for thread ${threadId}; durable request remains pending:`,
        err instanceof Error ? err.message : 'unknown error',
      )
    }

    // An abort signal alone cannot wake an HITL Promise. Deny every
    // registered HITL so the loop can observe the signal and finalize.
    const companions = state.getSessionCompanions(threadId)
    if (companions) {
      const snapshot = denyAllHitls(companions.hitls)
      const blocking = snapshot.filter(s => s.pendingBefore > 0)
      if (blocking.length > 0) {
        console.info(
          `[cancel] thread=${threadId} denied pending HITL(s): ` +
          blocking.map(s => `${s.name}=${s.pendingBefore}`).join(', '),
        )
      }
    }

    // Evidence-only watchdog. A stuck, non-abort-aware await remains
    // cancel_requested with its runtime sentinel intact. Only the runner
    // finalizer may confirm cancelled/timed_out/succeeded/failed.
    if (!armWatchdog) return
    const watchdog = setTimeout(() => {
      if (!runner.isRunning(threadId)) return
      console.warn(
        `[cancel] run for thread ${threadId} did not finalize within 2s; ` +
        'leaving outcome pending because work may still be active',
      )
    }, 2000)
    watchdog.unref?.()
  }

  // POST /api/v1/runs/:runId/cancel — exact public cancellation request.
  async function cancelRun(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const runId = params['runId']!
    const snapshot = deps.runStore?.get(runId) ?? null
    if (!snapshot) {
      sendError(res, 404, 'Run was not found', 'run_not_found', 'not_found')
      return
    }
    if (!authorizePrincipalScope(req, {
      workspaceId: snapshot.workspaceId ?? undefined,
      profileId: snapshot.profileId,
    })) {
      sendError(res, 403, 'Delegated principal does not allow this run', 'principal_scope_denied', 'auth')
      return
    }
    if (snapshot.terminal) {
      sendJSON(res, 200, {
        runId,
        status: snapshot.status,
        terminal: true,
        outcomeKnown: snapshot.outcomeKnown,
        cancellation: 'already_terminal',
      })
      return
    }

    const active = runner.get(snapshot.threadId)
    if (!active || active.runId !== runId) {
      sendError(res, 409, 'Run is not active on this Gateway', 'run_not_active', 'invalid_request')
      return
    }
    const session = state.getSession(snapshot.threadId)
    if (!session) {
      sendError(res, 409, 'Run runtime is unavailable', 'run_runtime_unavailable', 'invalid_request')
      return
    }

    // Persist before signalling. A crash after this point recovers to
    // indeterminate, never to invented cancelled/succeeded.
    const outcome = deps.runStore!.requestCancel(runId)
    if (outcome === 'missing') {
      sendError(res, 404, 'Run was not found', 'run_not_found', 'not_found')
      return
    }
    if (outcome === 'terminal') {
      const terminal = deps.runStore!.get(runId)!
      sendJSON(res, 200, {
        runId,
        status: terminal.status,
        terminal: true,
        outcomeKnown: terminal.outcomeKnown,
        cancellation: 'already_terminal',
      })
      return
    }
    const persisted = deps.runStore!.get(runId)!
    signalCancellation(snapshot.threadId, session, outcome === 'requested')
    sendJSON(res, 202, {
      runId,
      status: persisted.status,
      terminal: false,
      outcomeKnown: persisted.outcomeKnown,
      cancellation: outcome,
    })
  }

  // POST /api/v1/threads/:threadId/abort — owner-only legacy compatibility.
  async function abort(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    if (getRequestPrincipal(req)?.kind === 'delegated') {
      sendError(
        res,
        403,
        'Delegated principals must use the exact run cancellation route',
        'exact_cancellation_route_required',
        'auth',
      )
      return
    }
    const threadId = params['threadId']!
    const thread = state.getThread(threadId)
    if (!authorizePrincipalScope(req, {
      workspaceId: thread?.workspaceId ?? undefined,
      profileId: thread?.profileId,
    })) {
      sendError(res, 403, 'Delegated principal does not allow this thread', 'principal_scope_denied', 'auth')
      return
    }
    const session = state.getSession(threadId)
    if (!session) {
      sendError(res, 404, `No active session for thread "${threadId}"`)
      return
    }

    const active = runner.get(threadId)
    if (active) deps.runStore?.requestCancel(active.runId)
    signalCancellation(threadId, session, true)

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ aborted: true, cancelRequested: active !== undefined, threadId }))
  }

  // GET /api/v1/runs/:runId — bounded durable execution snapshot.
  async function getRun(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const snapshot = deps.runStore?.get(params['runId']!) ?? null
    if (!snapshot) {
      sendError(res, 404, 'Run was not found', 'run_not_found', 'not_found')
      return
    }
    if (!authorizePrincipalScope(req, {
      workspaceId: snapshot.workspaceId ?? undefined,
      profileId: snapshot.profileId,
    })) {
      sendError(res, 403, 'Delegated principal does not allow this run', 'principal_scope_denied', 'auth')
      return
    }
    const currentEnd = snapshot.endSeq ?? state.getAgentEventMaxSeq(snapshot.threadId, 'root')
    const firstRetained = state.getAgentEventMinSeq(
      snapshot.threadId,
      'root',
      snapshot.startSeq,
      snapshot.endSeq ?? undefined,
    )
    const earliestRetainedCursor = firstRetained === null
      ? (currentEnd === snapshot.startSeq ? snapshot.startSeq : null)
      : firstRetained - 1
    sendJSON(res, 200, { ...snapshot, earliestRetainedCursor })
  }

  // GET /api/v1/runs/active
  async function listActiveRuns(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const active = runner.listActive()
    sendJSON(res, 200, {
      count: active.length,
      runs: active.map(r => ({
        threadId: r.threadId,
        profileId: r.profileId,
        model: r.model,
        status: r.status,
        startedAt: r.startedAt,
        lastSeq: r.lastSeq,
        turnCount: r.turnCount,
        costUsd: r.costUsd,
      })),
    })
  }

  // GET /api/v1/threads/:threadId/workspace-roots
  //
  // Lists active session-scope folder grants for the thread. Reads
  // from `companions.sessionAdditionalRoots` (Phase 2). When the
  // thread has no active runtime (run not started yet, or already
  // ended), returns an empty list with status 200 — this lets the
  // Settings → Permissions Folders tab render uniformly without the
  // UI having to special-case "no runtime".
  async function listWorkspaceRoots(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const threadId = params['threadId']!
    const thread = state.getThread(threadId)
    if (!thread) {
      sendError(res, 404, `Thread "${threadId}" not found`)
      return
    }
    const companions = state.getSessionCompanions(threadId)
    const roots = companions?.sessionAdditionalRoots ?? []
    sendJSON(res, 200, {
      threadId,
      workspaceId: thread.workspaceId ?? null,
      items: roots.map(path => ({ path })),
      total: roots.length,
    })
  }

  // DELETE /api/v1/threads/:threadId/workspace-roots
  //
  // Revokes a session-scope grant. Body: `{ path: string }`. Removes
  // the matching path (literal or canonical) from the session's
  // additionalRoots. Subsequent filesystem reads in that path will
  // re-prompt as MACHINE-zone.
  //
  // Idempotent: revoking a path that isn't granted returns 204 with
  // `{ removed: 0 }` so retries don't error.
  async function revokeWorkspaceRoot(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const threadId = params['threadId']!
    const body = await readJSON<{ path?: unknown }>(req)
    if (!body || typeof body.path !== 'string' || body.path.length === 0) {
      sendError(res, 400, 'Missing required field: path (string)')
      return
    }
    const targetLiteral = body.path
    let targetCanonical = targetLiteral
    try {
      const { realpath } = await import('node:fs/promises')
      targetCanonical = await realpath(targetLiteral)
    } catch {
      // Path no longer exists on disk — that's fine, we still remove
      // the literal from the in-memory list.
    }

    const thread = state.getThread(threadId)
    if (!thread) {
      sendError(res, 404, `Thread "${threadId}" not found`)
      return
    }
    const companions = state.getSessionCompanions(threadId)
    if (!companions) {
      // No active runtime — nothing to revoke. Idempotent: report 0 removals.
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ threadId, removed: 0 }))
      return
    }

    const before = companions.sessionAdditionalRoots.length
    // Mutate in place (the same array reference flows into LoomConfig
    // — splicing here is what makes the loop re-prompt on the next
    // outside-workspace read).
    for (let i = companions.sessionAdditionalRoots.length - 1; i >= 0; i--) {
      const r = companions.sessionAdditionalRoots[i]!
      if (r === targetLiteral || r === targetCanonical) {
        companions.sessionAdditionalRoots.splice(i, 1)
      }
    }
    const removed = before - companions.sessionAdditionalRoots.length
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ threadId, removed }))
  }

  /**
   * 8d-4 — re-execute a held (draft-approval) tool call EXACTLY as the user
   * reviewed it, with the user's credentials. The approve endpoint calls this
   * with the action + args from the STORED approval row (NEVER the request
   * body), so a caller can't approve-execute an arbitrary tool/input.
   *
   * One-shot ToolContext (no model loop, no streaming HITL):
   *   - requestPermission → true: the user already approved THIS exact action.
   *   - requestCredential → deny: an unattended approve has no human to prompt;
   *     the tool resolves its already-stored connector token via the credential
   *     layer (connector identity is baked into the tool at assembly time).
   * Returns the tool's ToolResult; the caller records approved/failed from it.
   */
  async function executeHeldTool(params: {
    readonly profileId: string
    readonly threadId: string | null
    readonly workspaceId?: string
    readonly toolName: string
    readonly toolInput: unknown
  }): Promise<ToolResult> {
    // The held tool belongs to THIS agent — resolve the profile.
    if (!registry.has(params.profileId)) {
      await registry.refreshUser()
      if (!registry.has(params.profileId)) {
        return { content: `The agent for this draft ("${params.profileId}") no longer exists.`, isError: true }
      }
    }
    const profile = await registry.get(params.profileId)

    // Filesystem tools need a real cwd boundary — resolve the workspace path.
    // Connector sends (gmail/slack) don't need a workspace; they resolve a token.
    let workspacePath: string | undefined
    if (params.workspaceId != null) {
      const ws = state.getWorkspace(params.workspaceId)
      if (ws == null || !existsSync(ws.path)) {
        return { content: 'This action needs its workspace, which no longer exists.', isError: true }
      }
      workspacePath = ws.path
    }

    // The SAME canonical credential runtime a normal run uses (shared builder).
    const credentialThreadId = params.threadId ?? `approve_${randomUUID().slice(0, 8)}`
    const { credentialRuntime, credentialConfigVars } =
      await buildThreadCredentialRuntime(credentialThreadId, workspacePath)

    const assembled = await assembleAgent(profile, {
      webSearchService: deps.webSearchService,
      ...(deps.toolProviders !== undefined ? { toolProviders: deps.toolProviders } : {}),
      credentialContext: {
        credentialHandles: credentialRuntime.listHandles(),
        configVars: credentialConfigVars,
      },
      // Same operator hook policy as a live run — approve-execute on a
      // profile that declares command hooks must not fail assembly just
      // because this path forgot the opt-in the run path honors. (No
      // hook RUNTIME is used here — this is a one-shot tool execution,
      // no session — but assembly must still succeed.)
      hooks: hookBindingOptionsFromEnv(),
      workspacePath: workspacePath ?? null,
    })

    const tool = assembled.tools.find((t) => t.name === params.toolName)
    if (tool == null) {
      return { content: `The "${params.toolName}" tool is no longer available for this agent.`, isError: true }
    }

    // Faithful one-shot ToolContext — mirrors loop.ts's per-call construction
    // (loop.ts:~1586), minus the streaming-only paths.
    const effectiveCwd = workspacePath ?? process.cwd()
    const context: ToolContext = {
      cwd: effectiveCwd,
      signal: new AbortController().signal,
      sessionId: credentialThreadId,
      rootSessionId: credentialThreadId,
      agentId: null,
      workspacePath: effectiveCwd,
      additionalWorkspaceRoots: [],
      config: assembled.config,
      requestPermission: async () => true,
      requestCredential: async () => null,
      resolveCredential: (id) => credentialRuntime.resolveValue(id),
      listEnvCredentials: () => credentialRuntime.listEnvCredentials(),
      listAllCredentialValues: () => credentialRuntime.listAllCredentialValues(),
    }

    const toolCall: ToolCall = {
      id: `approve_${randomUUID().slice(0, 8)}`,
      name: params.toolName,
      input: (params.toolInput ?? {}) as Record<string, unknown>,
    }
    const exec = await executeTool({
      tool,
      toolCall,
      context,
      config: assembled.config.toolExecution,
    })
    return exec.result
  }

  return {
    run, startProfileRun, resume, decidePermission, cancelRun, abort, getRun, listActiveRuns, listWorkspaceRoots, revokeWorkspaceRoot,
    executeHeldTool,
  }
}
