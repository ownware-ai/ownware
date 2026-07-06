/**
 * Auto-register detected MCP servers at gateway boot.
 *
 * Scans local app sources (Claude Code plugins, Claude Code settings,
 * Claude Desktop config) and registers servers with transport info
 * into the mcp_servers table.
 * Zero-auth servers are auto-attached to all profiles.
 *
 * Spotlight (mdfind) scanning is intentionally deferred — it runs in
 * the background after the gateway is listening so the 10s mdfind
 * timeout doesn't block boot.
 */

import { execFile } from 'node:child_process'
import { readdir, readFile, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { DETECTED_REGISTRY_MARKER } from '../schema.js'
import type { ProfileRegistry } from '../../profile/registry.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MCPInstallRecipe {
  readonly runtime?: 'npx' | 'uvx'
  readonly package?: string
  readonly transport?: 'http' | 'sse'
  readonly url?: string
  readonly args?: readonly string[]
  readonly authType: 'none' | 'api-key' | 'oauth2'
}

interface KnownAppEntry {
  readonly name: string
  readonly via: string
  readonly category: string
  readonly mcpInstall?: MCPInstallRecipe
}

export interface DetectedServer {
  readonly id: string
  readonly name: string
  readonly transport: 'stdio' | 'http' | 'sse'
  readonly url?: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly authType: 'none' | 'api-key' | 'oauth2'
  readonly detectedFrom: string
}

/**
 * Minimal state interface so we don't import the full GatewayState.
 */
export interface AutoRegisterState {
  getMCPServer(id: string): unknown | undefined
  createMCPServer(server: {
    id: string
    name: string
    transport: string
    url?: string
    command?: string
    args?: readonly string[]
    registryId?: string
  }): unknown
  assignServerToProfile(serverId: string, profileId: string): void
}

let _knownAppsCache: Record<string, KnownAppEntry> | null = null

async function loadKnownApps(): Promise<Record<string, KnownAppEntry>> {
  if (_knownAppsCache) return _knownAppsCache
  // The cortex-internal catalog copy ships alongside the compiled module
  // (the build copies `src/connector/detection/known-apps.json` into dist).
  const thisDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [join(thisDir, 'known-apps.json')]
  for (const path of candidates) {
    try {
      const raw = await readFile(path, 'utf-8')
      _knownAppsCache = JSON.parse(raw)
      return _knownAppsCache!
    } catch {
      continue
    }
  }
  return {}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function autoRegisterDetectedApps(
  state: AutoRegisterState,
  registry: ProfileRegistry,
): Promise<{ registered: number; attached: number }> {
  const servers = await detectMCPServers()
  let registered = 0
  let attached = 0

  for (const server of servers) {
    if (state.getMCPServer(server.id)) continue

    state.createMCPServer({
      id: server.id,
      name: server.name,
      transport: server.transport,
      url: server.url,
      command: server.command,
      args: server.args,
      registryId: DETECTED_REGISTRY_MARKER,
    })
    registered++

    if (server.authType === 'none') {
      for (const { name: profileId } of registry.list()) {
        try {
          state.assignServerToProfile(server.id, profileId)
          attached++
        } catch {
          // Profile may already have this server
        }
      }
    }
  }

  return { registered, attached }
}

// ---------------------------------------------------------------------------
// Detection → MCP server list
// ---------------------------------------------------------------------------

async function detectMCPServers(): Promise<readonly DetectedServer[]> {
  // Bridge folder scanning was removed 2026-05-01 (Milestone B Phase 11
  // — connector architecture unification). Bridges now flow through
  // `connector/bridge-catalog.ts` as a runtime-augmented overlay on the
  // featured catalog instead of writing to the `mcp_servers` table.
  const scanners = [
    scanClaudeCodePlugins(),
    scanClaudeCodeSettings(),
    scanClaudeDesktopConfig(),
  ]

  if (process.platform === 'darwin') {
    scanners.push(scanSpotlightWithCatalog())
  }

  const results = await Promise.all(scanners)
  const all = results.flat()

  const seen = new Set<string>()
  const deduped: DetectedServer[] = []
  for (const server of all) {
    const endpointKey = server.url ?? server.command ?? ''
    const key = endpointKey.length > 0 ? `ep:${endpointKey}` : `id:${server.id}`
    if (!seen.has(key)) {
      seen.add(key)
      seen.add(`id:${server.id}`)
      deduped.push(server)
    }
  }

  return deduped
}

// ---------------------------------------------------------------------------
// Source 1: Spotlight + enriched catalog
// ---------------------------------------------------------------------------

async function scanSpotlightWithCatalog(): Promise<DetectedServer[]> {
  const knownApps = await loadKnownApps()
  const appPaths = await mdfindApplications()
  const detected: DetectedServer[] = []

  for (const appPath of appPaths) {
    const bundleId = await readBundleId(appPath)
    if (bundleId == null) continue

    const entry = knownApps[bundleId]
    if (entry?.mcpInstall == null) continue

    const recipe = entry.mcpInstall
    const [, serverId] = entry.via.split(':')
    if (!serverId) continue

    if (recipe.transport === 'http' || recipe.transport === 'sse') {
      if (recipe.url) {
        detected.push({
          id: serverId,
          name: entry.name,
          transport: recipe.transport,
          url: recipe.url,
          authType: recipe.authType,
          detectedFrom: 'spotlight',
        })
      }
    } else if (recipe.runtime && recipe.package) {
      detected.push({
        id: serverId,
        name: entry.name,
        transport: 'stdio',
        command: recipe.runtime,
        args: [
          ...(recipe.runtime === 'npx' ? ['-y'] : []),
          recipe.package,
          ...(recipe.args ?? []),
        ],
        authType: recipe.authType,
        detectedFrom: 'spotlight',
      })
    }
  }

  return detected
}

function mdfindApplications(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'mdfind',
      ["kMDItemContentType == 'com.apple.application-bundle'"],
      { timeout: 10_000, maxBuffer: 1024 * 1024 * 5 },
      (error, stdout) => {
        if (error != null) {
          resolve([])
          return
        }
        resolve(
          stdout
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0),
        )
      },
    )
  })
}

async function readBundleId(appPath: string): Promise<string | null> {
  try {
    const plistPath = join(appPath, 'Contents', 'Info.plist')
    const content = await readFile(plistPath, 'utf-8')
    const match = content.match(
      /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/,
    )
    return match?.[1] ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Source 2: Claude Code plugins (~/.claude/plugins/cache/)
// ---------------------------------------------------------------------------

async function scanClaudeCodePlugins(): Promise<DetectedServer[]> {
  const cacheDir = join(homedir(), '.claude', 'plugins', 'cache')
  const detected: DetectedServer[] = []

  try {
    await access(cacheDir)
  } catch {
    return []
  }

  try {
    const marketplaces = await readdir(cacheDir)
    for (const marketplace of marketplaces) {
      const marketplacePath = join(cacheDir, marketplace)
      let plugins: string[]
      try {
        plugins = await readdir(marketplacePath)
      } catch {
        continue
      }
      for (const plugin of plugins) {
        const pluginDir = join(marketplacePath, plugin)
        let versions: string[]
        try {
          versions = await readdir(pluginDir)
        } catch {
          continue
        }
        const latestVersion = versions.sort().at(-1)
        if (latestVersion == null) continue
        const mcpJsonPath = join(pluginDir, latestVersion, 'mcp.json')
        try {
          const raw = await readFile(mcpJsonPath, 'utf-8')
          const config = JSON.parse(raw) as {
            mcpServers?: Record<string, {
              type?: string; url?: string; command?: string; args?: string[]
            }>
          }
          if (config.mcpServers == null) continue
          for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
            const transportType = (serverConfig.type ?? 'stdio') as 'http' | 'sse' | 'stdio'
            detected.push({
              id: serverName,
              name: formatName(plugin, serverName),
              transport: transportType,
              url: serverConfig.url,
              command: serverConfig.command,
              args: serverConfig.args,
              authType: 'none',
              detectedFrom: 'claude-code-plugin',
            })
          }
        } catch {
          // no mcp.json or malformed
        }
      }
    }
  } catch {
    // cache dir unreadable
  }

  return detected
}

// ---------------------------------------------------------------------------
// Source 4: Claude Code settings (~/.claude/settings.local.json)
// ---------------------------------------------------------------------------

async function scanClaudeCodeSettings(): Promise<DetectedServer[]> {
  const settingsPath = join(homedir(), '.claude', 'settings.local.json')
  return scanMCPConfig(settingsPath, 'claude-code-settings')
}

// ---------------------------------------------------------------------------
// Source 5: Claude Desktop config
// ---------------------------------------------------------------------------

async function scanClaudeDesktopConfig(): Promise<DetectedServer[]> {
  const configPaths = [
    join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    join(homedir(), '.config', 'Claude', 'claude_desktop_config.json'),
  ]

  for (const configPath of configPaths) {
    const result = await scanMCPConfig(configPath, 'claude-desktop')
    if (result.length > 0) return result
  }

  return []
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function scanMCPConfig(
  configPath: string,
  source: string,
): Promise<DetectedServer[]> {
  try {
    const raw = await readFile(configPath, 'utf-8')
    const config = JSON.parse(raw) as {
      mcpServers?: Record<string, {
        command?: string; args?: string[]; url?: string; type?: string
      }>
    }
    if (config.mcpServers == null) return []

    const detected: DetectedServer[] = []
    for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
      const transportType = serverConfig.type ??
        (serverConfig.url != null ? 'http' : 'stdio')
      detected.push({
        id: serverName,
        name: formatName(serverName, serverName),
        transport: transportType as 'http' | 'sse' | 'stdio',
        url: serverConfig.url,
        command: serverConfig.command,
        args: serverConfig.args,
        authType: 'none',
        detectedFrom: source,
      })
    }
    return detected
  } catch {
    return []
  }
}

function formatName(plugin: string, serverName: string): string {
  const clean = plugin
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
  if (clean.toLowerCase() === serverName.toLowerCase()) return clean
  return clean
}
