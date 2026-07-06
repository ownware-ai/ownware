/**
 * InstallIdentity — single source of truth for "who is this gateway's user?"
 *
 * Cortex is local-first and single-user in v1. Every per-user piece of state
 * (connector connections, future preferences, future audit attribution) is
 * scoped by a stable identity string. Historically this string had three
 * defaults scattered across the codebase (the connect handler used `null`,
 * the connector source used `null`, the tool-adapter used
 * `'cortex-default-user'`), which let connection rows be written under one
 * identity and read under another — surfacing as "Gmail looks connected in
 * the modal but the agent says not_connected." This module exists so that
 * drift cannot happen again.
 *
 * Rules:
 *
 *   - Resolve once at gateway boot via `InstallIdentity.resolve()`.
 *   - The resolved value is a non-empty string. There is no "null identity."
 *     Any code path that needs the install identity takes it as a parameter;
 *     no defaults at call sites.
 *   - The literal `'cortex-default-user'` and the env-var name
 *     `OWNWARE_COMPOSIO_USER_ID` appear in EXACTLY this file. Lint/grep can
 *     enforce the invariant: any occurrence elsewhere is a bug.
 *
 * When multi-user / cloud auth ships, identity will come from the
 * authenticated session (JWT, cookie, etc.) — replace the resolver, keep
 * every consumer unchanged.
 */

const ENV_VAR = 'OWNWARE_COMPOSIO_USER_ID'
const DEFAULT_ID = 'cortex-default-user'

export class InstallIdentity {
  private constructor(public readonly id: string) {}

  /**
   * Resolve the install's identity. Reads `OWNWARE_COMPOSIO_USER_ID` (trimmed,
   * non-empty wins) and otherwise returns the default. Always non-empty.
   */
  static resolve(env: NodeJS.ProcessEnv = process.env): InstallIdentity {
    const raw = env[ENV_VAR]?.trim()
    const id = raw && raw.length > 0 ? raw : DEFAULT_ID
    return new InstallIdentity(id)
  }

  /** For tests that need a specific identity without touching env. */
  static fromString(id: string): InstallIdentity {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('InstallIdentity.fromString: id must be a non-empty string')
    }
    return new InstallIdentity(id)
  }

  toString(): string {
    return this.id
  }
}
