/**
 * Pure builder for the MCP-client config Cortex hands to Loom's `MCPClient`.
 *
 * Replaces three near-identical inline implementations that lived in
 * `addMCPToProfile` (mcp.ts), `connectServer` (mcp.ts), and the smoke
 * test's `buildConfig`. Every call site now goes through one helper that
 * branches on the unified `transport` discriminator.
 *
 * Pure — no I/O, no env mutation. Caller passes in resolved env (already
 * fetched from the credential vault). Caller is responsible for the
 * `${VAR}` → value substitution if it cares about template resolution
 * (some callers do, others don't).
 *
 * Added 2026-04-30 (Milestone A Phase 6).
 */

import type { MCPServerConfig as LoomMCPServerConfig } from '@ownware/loom'
import type { FeaturedTransport } from './mcp/featured.js'

export interface BuildMCPClientConfigInputs {
  /** Logical server id — becomes `LoomMCPServerConfig.name`. */
  readonly name: string
  /** Transport contract from the featured catalog (or future overlay). */
  readonly transport: FeaturedTransport
  /**
   * Resolved environment values. Already-fetched from the vault by the
   * caller. Keys mirror the connector's `requiredEnv` names. Empty {} is
   * fine for `none`-auth servers.
   */
  readonly env: Record<string, string>
  /**
   * Optional arg transformer — runs over the final stdio argv. Used by
   * the gateway to apply `${VAR}` → vault-value substitution
   * (`resolveEnvStringWithFallback`). Identity transform is the safe
   * default for callers that don't care about template resolution.
   */
  readonly transformArg?: (arg: string, index: number) => string
}

/**
 * Build the `MCPServerConfig` that Loom's `MCPClient` expects, branching
 * on the unified transport discriminator.
 */
export function buildMCPClientConfig(inp: BuildMCPClientConfigInputs): LoomMCPServerConfig {
  const { name, transport: t, env, transformArg } = inp

  switch (t.kind) {
    case 'stdio': {
      const baseArgs = t.runtime === 'npx'
        ? ['-y', t.package, ...(t.args ?? [])]
        : [t.package, ...(t.args ?? [])]
      const args = transformArg
        ? baseArgs.map((a, i) => transformArg(a, i))
        : baseArgs
      return {
        name,
        transport: 'stdio',
        command: t.runtime,
        args,
        env,
      }
    }

    case 'http_remote':
      return { name, transport: 'http', url: t.url }

    case 'http_bridge':
      // The bridge file (~/.ownware/bridges/<bridgeId>.json) holds the
      // 127.0.0.1:<port> URL. Resolution happens at call time in the
      // bridge-catalog reader (Milestone B). Today, raw `http_bridge`
      // entries don't reach this builder — they flow through the
      // `mcp_servers` row path instead.
      throw new Error(
        `buildMCPClientConfig: bridge transport for "${name}" must be resolved to an http_remote URL by the bridge-catalog reader before spawn`,
      )
  }
}
