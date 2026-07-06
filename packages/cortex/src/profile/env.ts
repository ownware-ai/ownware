/**
 * Environment Variable Resolution
 *
 * Resolves ${VAR_NAME} patterns in config values.
 *
 * Two modes:
 *  - `resolveEnvVars` / `resolveEnvString` — process.env only. Used by
 *    non-MCP callers and as the legacy default. Throws on missing vars.
 *  - `resolveEnvVarsWithFallback` / `resolveEnvStringWithFallback` —
 *    consults a `fallback` map first (typically a per-server credential
 *    bag from `connector/mcp/credentials`), then process.env. Lets the
 *    MCP assembly path use credentials saved via the UI without
 *    requiring them to be in the gateway's shell environment.
 *
 * Both throw with the same clear message on a truly missing variable.
 */

const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g

/**
 * Resolve all ${VAR_NAME} references in a string-valued record (process.env only).
 *
 * @param config - Key-value pairs potentially containing ${VAR} references
 * @param context - Human-readable context for error messages (e.g., "MCP server 'chrome'")
 * @returns A new record with all env vars resolved to their values
 * @throws Error if any referenced env var is not set
 */
export function resolveEnvVars(
  config: Record<string, string>,
  context?: string,
): Record<string, string> {
  return resolveEnvVarsWithFallback(config, undefined, context)
}

/**
 * Resolve all ${VAR_NAME} references in a single string (process.env only).
 *
 * @param value - String potentially containing ${VAR} references
 * @param context - Human-readable context for error messages
 * @returns The string with all env vars resolved
 * @throws Error if any referenced env var is not set
 */
export function resolveEnvString(value: string, context?: string): string {
  return resolveEnvStringWithFallback(value, undefined, context)
}

/**
 * Resolve env refs against a per-call `fallback` map first, then process.env.
 *
 * The fallback is the layer where stored credentials live. The MCP profile
 * assembler loads `~/.ownware/credentials/<serverId>.json` for each server
 * and passes it here so the user's saved tokens reach the spawned MCP
 * child process WITHOUT being injected into the gateway's shell env.
 *
 * Order: fallback (stored creds) → process.env → throw.
 */
export function resolveEnvVarsWithFallback(
  config: Record<string, string>,
  fallback: Record<string, string> | undefined,
  context?: string,
): Record<string, string> {
  const resolved: Record<string, string> = {}
  for (const [key, value] of Object.entries(config)) {
    resolved[key] = resolveEnvStringWithFallback(
      value,
      fallback,
      context ? `${context}.${key}` : key,
    )
  }
  return resolved
}

/** Single-string variant of `resolveEnvVarsWithFallback`. */
export function resolveEnvStringWithFallback(
  value: string,
  fallback: Record<string, string> | undefined,
  context?: string,
): string {
  return value.replace(ENV_VAR_PATTERN, (_match, varName: string) => {
    const fromFallback = fallback?.[varName]
    if (fromFallback !== undefined && fromFallback !== '') return fromFallback

    const envValue = process.env[varName]
    if (envValue !== undefined) return envValue

    const where = context ? ` (in ${context})` : ''
    throw new Error(
      `Environment variable \${${varName}} is not set${where}. ` +
      `Save it via the Tools page (Settings → Connect), export it in your ` +
      `shell, or add it to a .env file before starting the gateway.`,
    )
  })
}
