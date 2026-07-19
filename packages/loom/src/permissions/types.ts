/**
 * Permissions System Types
 *
 * Controls which tool calls an agent can make autonomously,
 * which require human approval, and which are blocked outright.
 */

// ---------------------------------------------------------------------------
// Permission modes
// ---------------------------------------------------------------------------

/**
 * The top-level permission policy for a session.
 *
 * - 'auto': Default unclassified tool calls to 'allow'. Configured safety
 *           rules and a host's `checkPermission` callback still run first;
 *           an explicit `ask` still requires approval. This keeps unattended
 *           runs automatic inside their configured operating policy without
 *           turning autonomy into authority.
 * - 'ask': Default interactive mode. The session-stored grants are
 *          consulted, then the host's `checkPermission` (zone
 *          classifier, etc.) decides whether to allow or ask. The user
 *          sees a prompt for everything not pre-authorised.
 * - 'deny': **Deprecated** — pre-redesign meant "default deny all".
 *           Now coerced to 'ask': the user always decides. The variant
 *           is retained so existing on-disk profiles keep loading.
 * - 'allowlist': Only auto-allow tool calls matching explicit rules;
 *                everything else asks the user.
 */
export type PermissionMode = 'auto' | 'ask' | 'deny' | 'allowlist'

// ---------------------------------------------------------------------------
// Policy decisions
// ---------------------------------------------------------------------------

/**
 * The result of evaluating a tool call against the permission policy.
 *
 * - 'allow': Proceed without asking
 * - 'ask': Request human approval before proceeding
 *
 * Note: there is no 'deny' verdict. By design (permission redesign
 * 2026-05-14) the policy layer never silently denies — every risky
 * call surfaces to the user via 'ask', who reads the context and
 * decides. The user can still deny their own prompt; that's a
 * different code path (`requestApproval` returning false) and is
 * not represented in PolicyDecision.
 */
export type PolicyDecision = 'allow' | 'ask'

// ---------------------------------------------------------------------------
// Permission rules
// ---------------------------------------------------------------------------

/**
 * A permission rule that matches tool names against a pattern
 * and returns a decision.
 *
 * Rules are evaluated in order — first match wins.
 * Patterns support glob syntax (e.g., "filesystem.*" matches "filesystem.readFile").
 */
export interface PermissionRule {
  /** Glob pattern to match against tool names */
  readonly pattern: string
  /** Decision when the pattern matches */
  readonly decision: PolicyDecision
  /** Human-readable reason for this rule */
  readonly reason?: string
}

// ---------------------------------------------------------------------------
// Security context
// ---------------------------------------------------------------------------

/**
 * Security context for a permission evaluation.
 * Carries identity and session info to inform policy decisions.
 */
export interface SecurityContext {
  /** Optional user identifier */
  readonly userId?: string
  /** Session identifier (always present) */
  readonly sessionId: string
  /** Agent identifier (null = root agent) */
  readonly agentId?: string
  /** The permission mode governing this context */
  readonly mode: PermissionMode
}

// ---------------------------------------------------------------------------
// Safety rule function signature
// ---------------------------------------------------------------------------

/**
 * A safety rule is a function that inspects a tool call and returns
 * a decision. Returns null if the rule doesn't apply (no opinion).
 *
 * Safety rules are checked before user-defined permission rules.
 */
export type SafetyRule = (
  toolName: string,
  input: Record<string, unknown>,
) => PolicyDecision | null

/**
 * Rich result from a host-supplied `checkPermission` callback. Carries
 * the verdict plus classification metadata that the loop attaches to
 * the `permission.request` event for the UI/audit log.
 *
 * Hosts may still return the bare verdict (`'allow' | 'ask'`) for
 * back-compat; the loop normalizes both shapes. Cortex's zone-manager
 * wiring uses the rich form so a client's permission card can render a
 * severity badge + reason copy without re-running policy on the wire.
 */
export interface CheckPermissionResult {
  readonly decision: PolicyDecision
  /** Zone level (0-6) for the call, if zone security is active. */
  readonly zoneLevel?: number
  /** Zone name (safe | workspace | build | network | external | machine | never). */
  readonly zoneName?: string
  /** Human-readable explanation from the zone explainer. */
  readonly explanation?: string
  /** UI severity tag set by the classifier (S3). */
  readonly severityTag?: 'info' | 'warn' | 'critical'
  /** Human-readable detail for the severity tag. */
  readonly severityReason?: string
}

// ---------------------------------------------------------------------------
// Decision reasons (typed deny context for the model + audit log)
// ---------------------------------------------------------------------------

/**
 * Typed reason a tool call was not allowed to execute — a
 * discriminated union keyed on the deny source.
 * The model sees a human-readable summary built from this in the
 * tool result content; the structured payload travels on the
 * `permission.response` event for the UI and audit log.
 *
 * Post-2026-05-14 redesign there is no policy-level deny — the only
 * non-allow outcomes are user-driven (clicked Deny / no response
 * within timeout) or hook-blocked (tool.pre hook explicitly stopped
 * the call).
 */
export type DecisionReason =
  | {
      readonly type: 'user-denied'
      /** Tool the user declined */
      readonly toolName: string
      /** Tool input as submitted by the model */
      readonly toolInput: Readonly<Record<string, unknown>>
      /**
       * Optional severity tag from the zone classification. Lets the
       * model see whether the user denied a 'critical' action (likely
       * intentional friction) vs a routine 'info' one (maybe a misclick).
       */
      readonly severityTag?: 'info' | 'warn' | 'critical'
      /** Human-readable severity reason. */
      readonly severityReason?: string
      /** Optional free-text note from the user (added via the UI). */
      readonly note?: string
    }
  | {
      readonly type: 'timeout'
      readonly toolName: string
      readonly timeoutMs: number
    }
  | {
      readonly type: 'hook-blocked'
      readonly toolName: string
      /** Reason supplied by the blocking hook. */
      readonly reason: string
      /** Optional rule id from the hook for traceability. */
      readonly ruleId?: string
    }

/**
 * Format a `DecisionReason` as a model-readable tool-result string.
 *
 * The model receives this in the `tool_result` content; it's
 * deliberately written as prose with concrete fields (tool name,
 * input path/command, severity, optional user note) so the model
 * can extract them and either retry with a different shape or
 * surface the conflict back to the user in the next assistant turn.
 */
export function formatDecisionReason(reason: DecisionReason): string {
  switch (reason.type) {
    case 'user-denied': {
      const target = describeToolInput(reason.toolName, reason.toolInput)
      const severityBit = reason.severityTag
        ? ` (severity: ${reason.severityTag}${reason.severityReason ? ` — ${reason.severityReason}` : ''})`
        : ''
      const noteBit = reason.note ? ` User noted: "${reason.note}".` : ''
      return (
        `Permission denied: the user declined ${reason.toolName} on ${target}${severityBit}.` +
        `${noteBit}` +
        ` Do not retry this exact call. If the task still needs this action, ` +
        `ask the user in chat (or use ask_user) before attempting a different approach.`
      )
    }
    case 'timeout':
      return (
        `Permission timed out: ${reason.toolName} was not approved within ${reason.timeoutMs}ms ` +
        `(no user available). Stop the run and surface the pending action to the user, ` +
        `or re-run interactively / with an operating policy that explicitly allows it.`
      )
    case 'hook-blocked':
      return (
        `Permission denied by hook${reason.ruleId ? ` (${reason.ruleId})` : ''}: ${reason.reason}. ` +
        `Do not retry; the host environment has rejected this action. ` +
        `Surface the block to the user with the hook's reason verbatim.`
      )
  }
}

/**
 * Best-effort one-line description of what a tool call targets,
 * used in the model-readable deny message. Picks the most relevant
 * field from the input (file_path, path, command, url, query) so
 * the model sees "writeFile to ./foo.html" rather than
 * "writeFile with input {...}".
 */
function describeToolInput(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): string {
  const path = input.file_path ?? input.path ?? input.filePath
  if (typeof path === 'string') return `\`${path}\``
  const url = input.url ?? input.endpoint ?? input.target_url
  if (typeof url === 'string') return `\`${url}\``
  const command = input.command
  if (typeof command === 'string') {
    return `\`${command.length > 80 ? command.slice(0, 80) + '…' : command}\``
  }
  const query = input.query ?? input.pattern
  if (typeof query === 'string') return `\`${query}\``
  return `the proposed call (${toolName})`
}
