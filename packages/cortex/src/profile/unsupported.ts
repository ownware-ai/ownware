/**
 * Supported-field guard for profile assembly.
 *
 * The schema in `schema.ts` declares a number of fields that have no
 * runtime consumer today (hooks, workspace isolation, docker sandbox,
 * non-default memory isolation, postgres checkpoints, etc.). Silently
 * accepting them is worse than rejecting — an operator who sets
 * `security.sandbox.enabled: true` expecting container isolation is
 * owed a clear error, not a false sense of security.
 *
 * This module runs at the top of `assembleAgent()` and throws when a
 * profile opts into a field whose runtime wiring is not yet shipped.
 * Fields that are wired — or that have a default value which IS the
 * only shipped behaviour — pass through.
 *
 * Policy (strictly observable from the code as of this audit):
 *
 *   - `workspace.mode` other than `"cwd"` → unsupported
 *   - `workspace.isolation` other than `"shared"` → unsupported
 *   - `workspace.dirs` non-empty → unsupported
 *   - any `hooks.*` array non-empty → unsupported
 *   - `security.sandbox.enabled === true` → unsupported
 *   - `security.permissionMode` other than `"ask"` → unsupported
 *     (the zones system has superseded this knob without re-wiring it;
 *      silently honoring a non-default here would mislead operators)
 *   - `memory.sources` that is not exactly `["AGENTS.md"]` → unsupported
 *   - `memory.isolation` other than `"shared"` → unsupported
 *   - `checkpoint.store === "postgres"` → unsupported
 *
 * Notes on fields explicitly NOT rejected:
 *
 *   - `memory.enabled` — wired: `false` suppresses memories + identity
 *     + the `remember` tool. `true` (default) loads top-N memories +
 *     identity into the system prompt.
 *   - `memory.autoLearn` — wired (2026-04-26): when `true` (default)
 *     the assembler injects the `remember` tool bound to the current
 *     (profileId, threadId). When `false`, the agent reads memories
 *     from the prompt but cannot propose new ones. Loom's
 *     `memory_store / memory_search / memory_forget` are denied
 *     whenever autoLearn is on (the propose-then-accept Cortex
 *     contract replaces the write-through Loom contract). Closes
 *     F-01 in the 2026-04-16 audit findings.
 *   - `execution.timeout` — newly wired: enforced as a wall-clock abort
 *     by SessionRunner.
 *   - `execution.maxCostUsd` — wired via LoomConfig.maxBudgetUsd.
 *   - `context.contextUsage` — inert (F-03). A boolean flag whose
 *     default is `false`; rejecting `true` would surprise authors
 *     using the field for documentation. Tracked as a separate fix.
 *
 * When the Planned modules (hooks/, workspace/, sandbox/, memory
 * persistence, postgres checkpoint store) ship, their entries below
 * become one-line deletes — the schema is already correct.
 */

import type { LoadedProfile } from './loader.js'

/**
 * Thrown when a profile opts into a field whose runtime wiring is not
 * implemented. The message names the field with its dotted path and
 * explains why the request could not be honored, so an operator can
 * act (remove the field, pick a supported value) without guessing.
 */
export class UnsupportedProfileFieldError extends Error {
  public override readonly name = 'UnsupportedProfileFieldError'
  public readonly field: string
  public readonly profileName: string

  constructor(profileName: string, field: string, reason: string) {
    super(
      `Profile "${profileName}" sets "${field}", which is declared in the ` +
        `schema but not yet enforced by the runtime. ${reason} Either remove ` +
        `the field or wait for runtime support.`,
    )
    this.profileName = profileName
    this.field = field
  }
}

/**
 * Validate that the profile only uses fields whose runtime wiring
 * exists. Throws the first UnsupportedProfileFieldError encountered —
 * one clear error beats a flood, and the ordering is stable so tests
 * can assert against a single message.
 *
 * Pure, synchronous, side-effect-free. Called from `assembleAgent()`
 * before any work is done.
 */
export function assertProfileIsSupported(profile: LoadedProfile): void {
  const { config } = profile
  const name = config.name

  // Workspace — the whole block is declarative today.
  if (config.workspace.mode !== 'cwd') {
    throw new UnsupportedProfileFieldError(
      name,
      `workspace.mode (="${config.workspace.mode}")`,
      'Only "cwd" is honored; the workspace-isolation module is not yet implemented.',
    )
  }
  if (config.workspace.isolation !== 'shared') {
    throw new UnsupportedProfileFieldError(
      name,
      `workspace.isolation (="${config.workspace.isolation}")`,
      'Only "shared" is honored; per-profile / per-run isolation is not yet implemented.',
    )
  }
  if (config.workspace.dirs.length > 0) {
    throw new UnsupportedProfileFieldError(
      name,
      'workspace.dirs',
      'Workspace directory allowlists are not yet enforced; the agent currently has no filesystem jail beyond OS permissions.',
    )
  }

  // Hooks — all five buckets are wired: profile/hooks.ts compiles them
  // into the engine's HookRuntime (onStart→session.start,
  // onToolCall→tool.pre, onToolEnd→tool.post, onComplete→session.end,
  // onError→error). Action-level validation — URLs, path confinement,
  // the command-hook opt-in — is enforced loudly there at assembly, so
  // this guard has nothing left to reject.

  // Sandbox — security-posture promise we cannot keep today.
  if (config.security.sandbox.enabled) {
    throw new UnsupportedProfileFieldError(
      name,
      `security.sandbox.enabled (with provider="${config.security.sandbox.provider}")`,
      'No sandbox runtime (docker/modal/anthropic) is integrated. Tool calls execute in-process regardless of this flag, which would mislead any operator relying on it for isolation.',
    )
  }

  // permissionMode: 'ask' and 'auto' are both supported. 'ask' is the
  // interactive default; 'auto' allows only when configured safety and zone
  // policy has no stronger decision. 'deny' and 'allowlist' are
  // semantically dead — kept in the schema enum so old profiles load,
  // but they fall through to 'ask' at runtime. Reject them here so
  // operators don't think they're getting blocking behaviour.
  if (
    config.security.permissionMode !== 'ask' &&
    config.security.permissionMode !== 'auto'
  ) {
    throw new UnsupportedProfileFieldError(
      name,
      `security.permissionMode (="${config.security.permissionMode}")`,
      'Only "ask" (interactive, default) and "auto" (automatic inside configured policy) are honored. "deny" and "allowlist" were deprecated by the 2026-05-14 permission redesign.',
    )
  }

  // Memory — enabled is wired; sources / isolation are not.
  if (!isDefaultMemorySources(config.memory.sources)) {
    throw new UnsupportedProfileFieldError(
      name,
      `memory.sources (=${JSON.stringify(config.memory.sources)})`,
      'The loader hardcodes AGENTS.md today; custom memory source lists are not yet honored.',
    )
  }
  if (config.memory.isolation !== 'shared') {
    throw new UnsupportedProfileFieldError(
      name,
      `memory.isolation (="${config.memory.isolation}")`,
      'Per-session / per-thread memory isolation is not yet implemented; memory is always shared across threads for a profile.',
    )
  }

  // Checkpoint — postgres path is declared but returns null at assembly.
  if (config.checkpoint.store === 'postgres') {
    throw new UnsupportedProfileFieldError(
      name,
      'checkpoint.store (="postgres")',
      'The postgres checkpoint store is not implemented; runs would silently lose state on gateway restart.',
    )
  }
}

/**
 * The schema default for `memory.sources` is exactly `["AGENTS.md"]`.
 * Anything else — different length, different value, different order —
 * is not honored by the loader and must be rejected.
 */
function isDefaultMemorySources(sources: readonly string[]): boolean {
  return sources.length === 1 && sources[0] === 'AGENTS.md'
}
