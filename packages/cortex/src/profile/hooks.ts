/**
 * Profile Hook Binding
 *
 * Compiles the profile's declarative `hooks` config (agent.json) into a
 * running Loom `HookRuntime` plus the `ReminderInjector` that makes hook
 * outcomes model-visible. This is the bridge between the profile surface
 * (portable, Builder-writable, marketplace-safe) and the engine's
 * lifecycle hook subsystem.
 *
 * Bucket → engine event mapping:
 *
 *   onStart     → session.start
 *   onToolCall  → tool.pre
 *   onToolEnd   → tool.post
 *   onModelCall → model.pre     (before each provider call, incl. retries;
 *                                observe/inject only — cannot block)
 *   onModelEnd  → model.post    (after each successful model response —
 *                                per-call metering: usage, cost, stop
 *                                reason, tool-call count; cannot block)
 *   onComplete  → session.end   (fires on EVERY terminal state — normal
 *                                end, abort, limits, error; the payload's
 *                                `reason` distinguishes them)
 *   onError     → error         (fires only on unrecoverable failure)
 *
 * Action semantics (all compiled to in-process `fn` hook specs):
 *
 *   log        — console line at the configured level. Summary ONLY
 *                (event, tool name, sizes) — never full inputs/results;
 *                a log line must not become a secret sink.
 *   webhook    — POST {v, ts, profile, event, context} to the URL.
 *                Own 3.5s timeout (below the executor's 5s default so
 *                the spec always resolves before the executor would
 *                convert a timeout into a block). Failures warn and
 *                continue — observe actions never block by construction.
 *   save_json  — append one JSON line (JSONL) to a path confined to the
 *                profile directory. Same non-blocking posture.
 *   command    — the standard Unix hook convention (context as JSON on
 *                stdin, exit code decides, stdout JSON as structured
 *                result). DISABLED unless the operator opts in: a
 *                profile is a portable artifact, and a downloaded
 *                profile must never mean shell execution on this host.
 *   approve    — PAUSE the run and ask a human (onToolCall only; you
 *                cannot approve what already happened). Optional `tools`
 *                globs scope which tool calls pause. The decision comes
 *                through the injected `requestHookApproval` channel —
 *                the gateway wires it to the thread's HITL, so the
 *                answer can arrive from the web UI or a chat channel.
 *                No channel wired → FAIL CLOSED (deny with an honest
 *                reason the model sees). Timeout (hitlTimeoutMs) → deny.
 *
 * Validation is loud-or-dead at assembly time: a malformed hook
 * (unparseable URL, non-https remote, path escape, missing field) fails
 * `assembleAgent()` with a precise error — never a silently-dead hook
 * at runtime. A safety layer that fails silently is worse than none.
 *
 * @security
 *   - `command` actions require `allowCommandHooks` (operator policy,
 *     lives OUTSIDE the profile artifact — gateway config / env), and
 *     the kill switch `OWNWARE_DISABLE_HOOKS=1` disables all hooks.
 *   - Webhook URLs must be https, or http only for loopback hosts.
 *     An optional allowlist narrows egress further.
 *   - `save_json` paths resolve inside the profile directory only.
 *   - `redactValues` lets the caller scrub credential values from
 *     webhook / save_json payloads before egress.
 */

import { resolve, sep, isAbsolute, dirname } from 'node:path'
import { appendFile, mkdir } from 'node:fs/promises'
import {
  HookRegistry,
  HookRuntime,
  ReminderInjector,
  createDefaultRegistry,
} from '@ownware/loom'
import type { HookContext, HookEvent, HookSpec } from '@ownware/loom'
import type { LoadedProfile } from './loader.js'
import type { HookConfig, HooksConfig } from './schema.js'
import { matchesGlob } from './tool-policy.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The compiled hook surface for one session. */
export interface HookBinding {
  /** Runtime to pass to `new Session({ hooks })`. */
  readonly runtime: HookRuntime
  /**
   * Injector to pass to `new Session({ reminders })` — the SAME
   * instance the runtime emits into. Passing one without the other
   * silently drops the model-visible loop-back.
   */
  readonly reminders: ReminderInjector
}

export interface HookBindingOptions {
  /**
   * Operator opt-in for `command` hook actions. Default false — the
   * policy deliberately lives outside the profile artifact. Wire from
   * gateway config or `OWNWARE_ALLOW_COMMAND_HOOKS=1`.
   */
  readonly allowCommandHooks?: boolean
  /**
   * Optional URL-prefix allowlist for `webhook` actions. When set, a
   * webhook whose URL matches no prefix fails assembly.
   */
  readonly webhookAllowlist?: readonly string[]
  /**
   * Credential values to scrub from webhook / save_json payloads.
   * Called once per hook fire; values are replaced with [REDACTED].
   */
  readonly redactValues?: () => readonly string[]
  /**
   * The approval channel for `approve` hook actions. The gateway wires
   * this to the thread's permission HITL (emitting a
   * `permission.request` event so the web UI and chat channels can
   * answer via `POST /threads/:id/resume`). When absent (CLI, tests,
   * embedders without HITL), approve hooks FAIL CLOSED — the matching
   * tool call is denied with an honest reason.
   */
  readonly requestHookApproval?: (
    req: HookApprovalRequest,
  ) => Promise<HookApprovalDecision>
}

/** What an `approve` hook asks the host to decide. */
export interface HookApprovalRequest {
  readonly toolName: string
  readonly toolInput: Record<string, unknown>
  readonly turnIndex: number
  /** Human-readable "why you are being asked" line. */
  readonly reason: string
}

/** The host's verdict on a {@link HookApprovalRequest}. */
export interface HookApprovalDecision {
  readonly approved: boolean
  /** Shown to the model on deny (via the denied tool_result + reminder). */
  readonly reason?: string
}

/**
 * Resolve operator-level hook policy from the environment. Shared by
 * the gateway run path and the CLI so the opt-ins behave identically
 * everywhere a profile is assembled:
 *
 *   OWNWARE_ALLOW_COMMAND_HOOKS=1          — enable `command` hook actions
 *                                         (default off: a downloaded
 *                                         profile must never mean shell
 *                                         execution on this host)
 *   OWNWARE_HOOK_WEBHOOK_ALLOWLIST=a,b     — comma-separated URL prefixes;
 *                                         when set, webhook hooks must
 *                                         match one or assembly fails
 *
 * (`OWNWARE_DISABLE_HOOKS=1` — the global kill switch — is read directly
 * by `buildHookBinding`, not here, so it also covers programmatic
 * callers that never consult the env for policy.)
 */
export function hookBindingOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HookBindingOptions {
  const allowlistRaw = env.OWNWARE_HOOK_WEBHOOK_ALLOWLIST
  const allowlist = allowlistRaw
    ? allowlistRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : []
  return {
    allowCommandHooks: env.OWNWARE_ALLOW_COMMAND_HOOKS === '1',
    ...(allowlist.length > 0 ? { webhookAllowlist: allowlist } : {}),
  }
}

/** Loud validation failure for a declared hook. */
export class HookConfigError extends Error {
  constructor(
    readonly profileName: string,
    readonly field: string,
    detail: string,
  ) {
    super(`Profile "${profileName}": ${field} — ${detail}`)
    this.name = 'HookConfigError'
  }
}

// ---------------------------------------------------------------------------
// Bucket → event mapping
// ---------------------------------------------------------------------------

const BUCKET_TO_EVENT = {
  onStart: 'session.start',
  onToolCall: 'tool.pre',
  onToolEnd: 'tool.post',
  onModelCall: 'model.pre',
  onModelEnd: 'model.post',
  onComplete: 'session.end',
  onError: 'error',
} as const satisfies Partial<Record<keyof HooksConfig, HookEvent>>

type WiredBucket = keyof typeof BUCKET_TO_EVENT

const WIRED_BUCKETS = Object.keys(BUCKET_TO_EVENT) as readonly WiredBucket[]

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Compile `profile.config.hooks` into a HookBinding.
 *
 * Returns null when the profile declares no hooks (the no-hook loop
 * path stays byte-identical) or when `OWNWARE_DISABLE_HOOKS=1`.
 * Throws `HookConfigError` on any invalid declaration.
 */
export function buildHookBinding(
  profile: LoadedProfile,
  options: HookBindingOptions = {},
): HookBinding | null {
  const hooks = profile.config.hooks
  const declaredCount = WIRED_BUCKETS.reduce(
    (n, bucket) => n + hooks[bucket].length,
    0,
  )
  if (declaredCount === 0) return null

  if (process.env.OWNWARE_DISABLE_HOOKS === '1') {
    console.warn(
      `[ownware] OWNWARE_DISABLE_HOOKS=1 — ${declaredCount} declared hook(s) on ` +
        `profile "${profile.config.name}" will NOT run.`,
    )
    return null
  }

  const registry = new HookRegistry()
  const reminders = new ReminderInjector(createDefaultRegistry())

  for (const bucket of WIRED_BUCKETS) {
    const event = BUCKET_TO_EVENT[bucket]
    hooks[bucket].forEach((config, i) => {
      const spec = compileAction(profile, bucket, `hooks.${bucket}[${i}]`, config, options)
      registry.register(event, spec)
    })
  }

  return {
    runtime: new HookRuntime({ registry, reminders }),
    reminders,
  }
}

// ---------------------------------------------------------------------------
// Action compilers
// ---------------------------------------------------------------------------

function compileAction(
  profile: LoadedProfile,
  bucket: WiredBucket,
  field: string,
  config: HookConfig,
  options: HookBindingOptions,
): HookSpec {
  const name = `${field}:${config.action}`
  switch (config.action) {
    case 'log':
      return compileLog(profile.config.name, name, config)
    case 'webhook':
      return compileWebhook(profile.config.name, field, name, config, options)
    case 'save_json':
      return compileSaveJson(profile, field, name, config, options)
    case 'command':
      return compileCommand(profile.config.name, field, name, config, options)
    case 'approve':
      return compileApprove(profile, bucket, field, name, config, options)
  }
}

// ── log ────────────────────────────────────────────────────────────────

function compileLog(
  profileName: string,
  name: string,
  config: HookConfig,
): HookSpec {
  const level = config.level
  return {
    type: 'fn',
    name,
    fn: (ctx) => {
      const line = `[ownware:hook:${profileName}] ${summarize(ctx)}`
      if (level === 'error') console.error(line)
      else if (level === 'warn') console.warn(line)
      else console.log(line)
      return { continue: true }
    },
  }
}

/**
 * One-line, secret-safe summary of a hook context. Names and sizes
 * only — tool inputs and results never reach the log line.
 */
function summarize(ctx: HookContext): string {
  switch (ctx.event) {
    case 'session.start':
      return `session.start model=${ctx.model} session=${ctx.sessionId}`
    case 'user.prompt.submit': {
      const size =
        typeof ctx.prompt === 'string' ? ctx.prompt.length : ctx.prompt.length
      return `user.prompt.submit size=${size}`
    }
    case 'tool.pre':
      return `tool.pre tool=${ctx.toolName} turn=${ctx.turnIndex}`
    case 'tool.post':
      return (
        `tool.post tool=${ctx.toolName} turn=${ctx.turnIndex} ` +
        `error=${ctx.isError} resultChars=${ctx.result.length}`
      )
    case 'model.pre':
      return `model.pre model=${ctx.model} turn=${ctx.turnIndex} messages=${ctx.messageCount}`
    case 'model.post':
      return (
        `model.post model=${ctx.model} turn=${ctx.turnIndex} stop=${ctx.stopReason} ` +
        `in=${ctx.inputTokens} out=${ctx.outputTokens} cost=$${ctx.costUsd.toFixed(4)} tools=${ctx.toolCallCount}`
      )
    case 'session.end':
      return `session.end reason=${ctx.reason} session=${ctx.sessionId}`
    case 'error':
      return `error code=${ctx.code} message=${ctx.message}`
  }
}

// ── webhook ────────────────────────────────────────────────────────────

/**
 * Internal fetch timeout. Deliberately below the hook executor's 5s
 * default so this fn ALWAYS resolves (continue: true) before the
 * executor would convert a spec timeout into a block. Observe actions
 * must never block the loop.
 */
const WEBHOOK_TIMEOUT_MS = 3_500

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function compileWebhook(
  profileName: string,
  field: string,
  name: string,
  config: HookConfig,
  options: HookBindingOptions,
): HookSpec {
  if (!config.url) {
    throw new HookConfigError(profileName, field, `'webhook' requires a 'url' field.`)
  }
  let parsed: URL
  try {
    parsed = new URL(config.url)
  } catch {
    throw new HookConfigError(profileName, field, `'url' is not a valid URL: ${config.url}`)
  }
  const isLoopback = LOOPBACK_HOSTS.has(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new HookConfigError(
      profileName,
      field,
      `webhook URLs must be https (http is allowed only for localhost). Got: ${config.url}`,
    )
  }
  const allowlist = options.webhookAllowlist
  if (allowlist && allowlist.length > 0 && !allowlist.some((p) => config.url!.startsWith(p))) {
    throw new HookConfigError(
      profileName,
      field,
      `webhook URL is not covered by the operator's allowlist: ${config.url}`,
    )
  }

  const url = config.url
  return {
    type: 'fn',
    name,
    // Above the internal fetch timeout — the fn resolves on its own.
    timeoutMs: WEBHOOK_TIMEOUT_MS + 1_000,
    fn: async (ctx) => {
      try {
        const body = renderPayload(profileName, ctx, options.redactValues)
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'ownware-hook/1',
          },
          body,
          signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        })
        if (!res.ok) {
          console.warn(
            `[ownware:hook:${profileName}] ${name} → HTTP ${res.status} (run continues)`,
          )
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[ownware:hook:${profileName}] ${name} failed: ${msg} (run continues)`)
      }
      return { continue: true }
    },
  }
}

// ── save_json ──────────────────────────────────────────────────────────

function compileSaveJson(
  profile: LoadedProfile,
  field: string,
  name: string,
  config: HookConfig,
  options: HookBindingOptions,
): HookSpec {
  const profileName = profile.config.name
  if (!config.path) {
    throw new HookConfigError(profileName, field, `'save_json' requires a 'path' field.`)
  }
  if (isAbsolute(config.path)) {
    throw new HookConfigError(
      profileName,
      field,
      `'save_json' paths must be relative to the profile directory. Got absolute: ${config.path}`,
    )
  }
  const base = resolve(profile.basePath)
  const target = resolve(base, config.path)
  if (target !== base && !target.startsWith(base + sep)) {
    throw new HookConfigError(
      profileName,
      field,
      `'save_json' path escapes the profile directory: ${config.path}`,
    )
  }

  let dirReady: Promise<unknown> | null = null
  return {
    type: 'fn',
    name,
    fn: async (ctx) => {
      try {
        dirReady ??= mkdir(dirname(target), { recursive: true })
        await dirReady
        const line = renderPayload(profileName, ctx, options.redactValues)
        await appendFile(target, line + '\n', 'utf8')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[ownware:hook:${profileName}] ${name} failed: ${msg} (run continues)`)
      }
      return { continue: true }
    },
  }
}

// ── command ────────────────────────────────────────────────────────────

function compileCommand(
  profileName: string,
  field: string,
  name: string,
  config: HookConfig,
  options: HookBindingOptions,
): HookSpec {
  if (options.allowCommandHooks !== true) {
    throw new HookConfigError(
      profileName,
      field,
      `'command' hook actions are disabled by default: a profile is a portable ` +
        `artifact, and a downloaded profile must never mean shell execution on ` +
        `this host. If you authored this profile and accept that risk, opt in ` +
        `via the gateway's allowCommandHooks option (OWNWARE_ALLOW_COMMAND_HOOKS=1).`,
    )
  }
  if (!config.command || config.command.trim().length === 0) {
    throw new HookConfigError(profileName, field, `'command' requires a 'command' field.`)
  }
  return {
    type: 'command',
    name,
    command: config.command,
  }
}

// ── approve ────────────────────────────────────────────────────────────

/**
 * Extra budget past the human window so the hook executor never
 * converts a still-pending decision into a generic timeout-block before
 * the HITL's own timeout (which denies with a better reason) fires.
 */
const APPROVE_TIMEOUT_GRACE_MS = 60_000

function compileApprove(
  profile: LoadedProfile,
  bucket: WiredBucket,
  field: string,
  name: string,
  config: HookConfig,
  options: HookBindingOptions,
): HookSpec {
  const profileName = profile.config.name
  if (bucket !== 'onToolCall') {
    throw new HookConfigError(
      profileName,
      field,
      `'approve' is only valid in hooks.onToolCall — a ${bucket} hook fires ` +
        `when there is nothing left to approve.`,
    )
  }
  const globs = (config.tools ?? []).map((g) => g.trim()).filter((g) => g.length > 0)
  const approver = options.requestHookApproval
  const hitlTimeoutMs = profile.config.security.hitlTimeoutMs

  return {
    type: 'fn',
    name,
    // The wait IS the feature — budget past the HITL window (above).
    timeoutMs: hitlTimeoutMs + APPROVE_TIMEOUT_GRACE_MS,
    fn: async (ctx) => {
      if (ctx.event !== 'tool.pre') return { continue: true }
      // Scope: with globs, only matching tools pause; without, every
      // tool call in the bucket pauses (the author opted into that).
      if (globs.length > 0 && !globs.some((g) => matchesGlob(ctx.toolName, g))) {
        return { continue: true }
      }
      if (!approver) {
        // FAIL CLOSED, honestly: approval was declared but this host has
        // no approval channel (CLI `ownware run`, tests, bare embedders).
        // Silent-allow here would turn a declared safety gate into a
        // no-op — the exact silent-failure mode the field research
        // showed destroys trust in hook systems.
        return {
          continue: false,
          reason:
            `"${ctx.toolName}" requires operator approval, but no approval ` +
            `channel is wired on this host — denied (fail-closed). Run this ` +
            `profile through the gateway, or remove the approve hook.`,
        }
      }
      try {
        const decision = await approver({
          toolName: ctx.toolName,
          toolInput: ctx.toolInput,
          turnIndex: ctx.turnIndex,
          reason: `Profile "${profileName}" requires approval before running "${ctx.toolName}".`,
        })
        if (decision.approved) return { continue: true }
        return {
          continue: false,
          reason: decision.reason ?? `The operator denied "${ctx.toolName}".`,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // A broken approval channel is a deny, never an allow.
        return {
          continue: false,
          reason: `Approval channel failed (${msg}) — "${ctx.toolName}" denied (fail-closed).`,
        }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/**
 * Serialize the hook payload, scrubbing credential values when a
 * redactor is wired. Redaction runs on the serialized string so values
 * embedded anywhere in the context (inputs, results, prompt) are caught.
 */
function renderPayload(
  profileName: string,
  ctx: HookContext,
  redactValues?: () => readonly string[],
): string {
  let body = JSON.stringify({
    v: 1,
    ts: Date.now(),
    profile: profileName,
    event: ctx.event,
    context: ctx,
  })
  if (redactValues) {
    for (const value of redactValues()) {
      if (value.length >= 4) {
        // JSON-encode the secret so escaped forms inside the serialized
        // payload (quotes, backslashes) are matched exactly.
        const encoded = JSON.stringify(value).slice(1, -1)
        body = body.split(encoded).join('[REDACTED]')
      }
    }
  }
  return body
}
