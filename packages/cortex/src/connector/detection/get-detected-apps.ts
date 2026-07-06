/**
 * Detected-apps reader — produces the rich `DetectedApp` shape
 * consumed by a client's tools lobby for "Found on your Mac" hint
 * cards.
 *
 * Phase 3a (2026-05-06) of the connector production rebuild.
 *
 * Why this lives in cortex and not the client:
 *   The desktop client used to carry its own scanner in its electron
 *   main process with a different filter than cortex's
 *   `auto-register.ts`. The two diverged silently and let junk
 *   (Chrome, Todoist-without-recipe, etc.) leak into the UI. Phase 3
 *   unifies on ONE scanner, owned by cortex, exposed via the gateway.
 *   The client's renderer fetches from the gateway instead of running
 *   its own `mdfind`.
 *
 * Sources scanned (each one independent, failures isolated):
 *   1. Spotlight (`mdfind`, macOS only) — installed `.app` bundles
 *      cross-referenced against `known-apps.json` for friendly
 *      metadata.
 *   2. Bridge folder (`~/.ownware/bridges/*.json`) — desktop apps
 *      that announce their MCP server to us. (See
 *      `connector/bridge-catalog.ts` for the canonical reader; this
 *      function only emits the detected-app HINT shape.)
 *   3. Claude Desktop config — already-configured MCP servers we
 *      can offer to import.
 *   4. Claude Code settings + plugin cache — same.
 *
 * Output is sorted: spotlight first (most useful for non-tech
 * users), then bridge, then claude-desktop, then claude-code. Within
 * each source, alphabetical by name.
 */

import { execFile } from 'node:child_process'
import { readdir, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { loadKnownApps } from '../known-apps.js'
import { DEFAULT_DATA_DIR_NAME } from '../../constants.js'

// ---------------------------------------------------------------------------
// Public type — matches the wire format consumed by UI clients
// ---------------------------------------------------------------------------

export type DetectedAppSource =
  | 'spotlight'
  | 'bridge'
  | 'claude-code'
  | 'claude-desktop'

export interface DetectedAppTransport {
  readonly type: 'http' | 'sse' | 'stdio'
  readonly url?: string
  readonly command?: string
  readonly args?: readonly string[]
}

export interface DetectedApp {
  /** Stable identifier — bundle id, plugin path, or settings key. */
  readonly platformId: string
  /** Display name. */
  readonly name: string
  /** `<source>:<id>` — e.g. `mcp:slack`, `claude-code:my-server`. */
  readonly via: string
  /** Filesystem path to the source artifact (.app, JSON, config). */
  readonly path: string
  /** Display category. */
  readonly category: string
  /** Where this row was discovered. */
  readonly detectedFrom: DetectedAppSource
  /** Optional: how to spawn/connect the MCP server. */
  readonly transport?: DetectedAppTransport
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run every scanner, dedupe, return the rich DetectedApp list.
 *
 * Failures in one scanner do NOT abort the others — each scanner
 * returns `[]` on error. The aggregate list is deduped by transport
 * URL/command first, then by case-insensitive name, so the same MCP
 * server discovered via two sources only appears once.
 */
export async function getDetectedApps(): Promise<readonly DetectedApp[]> {
  const scanners: Array<Promise<readonly DetectedApp[]>> = [
    scanClaudeCodePlugins(),
    scanClaudeCodeSettings(),
    scanClaudeDesktopConfig(),
    scanBridgeFolder(),
  ]

  if (process.platform === 'darwin') {
    scanners.push(scanSpotlight())
  }

  const results = await Promise.all(scanners)
  const all = results.flat()

  const seen = new Set<string>()
  const deduped: DetectedApp[] = []
  for (const app of all) {
    const nameKey = app.name.toLowerCase()
    const urlKey = app.transport?.url ?? app.transport?.command ?? ''
    const dedupeKey = urlKey.length > 0 ? `url:${urlKey}` : `name:${nameKey}`
    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey)
      seen.add(`name:${nameKey}`)
      deduped.push(app)
    }
  }

  return sortDetectedApps(deduped)
}

// ---------------------------------------------------------------------------
// Source 1: Spotlight (macOS) ──────────────────────────────────────────────
// ---------------------------------------------------------------------------

async function scanSpotlight(): Promise<readonly DetectedApp[]> {
  const knownApps = await loadKnownApps()
  if (knownApps.byPlatformId.size === 0) return []

  const appPaths = await mdfindApplications()
  const detected: DetectedApp[] = []

  for (const appPath of appPaths) {
    const bundleId = await readBundleId(appPath)
    if (bundleId == null) continue

    const entry = knownApps.byPlatformId.get(bundleId)
    if (entry == null) continue

    detected.push({
      platformId: bundleId,
      name: entry.name,
      via: entry.via,
      path: appPath,
      category: entry.category,
      detectedFrom: 'spotlight',
      ...(entry.mcpInstall != null
        ? { transport: mcpInstallToTransport(entry.mcpInstall) }
        : {}),
    })
  }

  return detected
}

interface MCPInstallRecipe {
  readonly runtime?: 'npx' | 'uvx'
  readonly package?: string
  readonly transport?: 'http' | 'sse'
  readonly url?: string
  readonly args?: readonly string[]
  readonly authType: 'none' | 'api-key' | 'oauth2'
}

function mcpInstallToTransport(recipe: MCPInstallRecipe): DetectedAppTransport | undefined {
  if (recipe.transport === 'http' || recipe.transport === 'sse') {
    if (recipe.url == null) return undefined
    return { type: recipe.transport, url: recipe.url }
  }
  if (recipe.runtime != null && recipe.package != null) {
    return {
      type: 'stdio',
      command: recipe.runtime,
      args: [
        ...(recipe.runtime === 'npx' ? ['-y'] : []),
        recipe.package,
        ...(recipe.args ?? []),
      ],
    }
  }
  return undefined
}

function mdfindApplications(): Promise<readonly string[]> {
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
            .map(l => l.trim())
            .filter(l => l.length > 0),
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
// Source 2: Bridge folder (~/.ownware/bridges/*.json) ──────────────────────
// ---------------------------------------------------------------------------

async function scanBridgeFolder(): Promise<readonly DetectedApp[]> {
  const bridgesDir = join(homedir(), DEFAULT_DATA_DIR_NAME, 'bridges')
  const detected: DetectedApp[] = []

  let files: string[]
  try {
    files = await readdir(bridgesDir)
  } catch {
    return []
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const fullPath = join(bridgesDir, file)
    try {
      const raw = await readFile(fullPath, 'utf-8')
      const manifest = JSON.parse(raw) as {
        name?: string
        bundleId?: string
        via?: string
        category?: string
        transport?: { type?: string; url?: string; command?: string; args?: string[] }
      }
      if (manifest.name == null || manifest.via == null) continue
      detected.push({
        platformId: manifest.bundleId ?? `bridge:${file.replace(/\.json$/, '')}`,
        name: manifest.name,
        via: manifest.via,
        path: fullPath,
        category: manifest.category ?? 'tool',
        detectedFrom: 'bridge',
        ...(manifest.transport != null
          ? {
              transport: {
                type: (manifest.transport.type ?? 'http') as DetectedAppTransport['type'],
                ...(manifest.transport.url != null ? { url: manifest.transport.url } : {}),
                ...(manifest.transport.command != null
                  ? { command: manifest.transport.command }
                  : {}),
                ...(manifest.transport.args != null
                  ? { args: manifest.transport.args }
                  : {}),
              },
            }
          : {}),
      })
    } catch {
      // malformed manifest — skip
    }
  }

  return detected
}

// ---------------------------------------------------------------------------
// Source 3: Claude Desktop config ─────────────────────────────────────────
// ---------------------------------------------------------------------------

async function scanClaudeDesktopConfig(): Promise<readonly DetectedApp[]> {
  const configPaths = [
    join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    join(homedir(), '.config', 'Claude', 'claude_desktop_config.json'),
  ]

  for (const configPath of configPaths) {
    const detected = await readMCPConfigFile(configPath, 'claude-desktop', name =>
      `claude-desktop:${name}`,
    )
    if (detected.length > 0) return detected
  }

  return []
}

// ---------------------------------------------------------------------------
// Source 4: Claude Code settings + plugin cache ───────────────────────────
// ---------------------------------------------------------------------------

async function scanClaudeCodeSettings(): Promise<readonly DetectedApp[]> {
  const settingsPath = join(homedir(), '.claude', 'settings.local.json')
  return readMCPConfigFile(settingsPath, 'claude-code', name => `claude-code:${name}`)
}

async function scanClaudeCodePlugins(): Promise<readonly DetectedApp[]> {
  const cacheDir = join(homedir(), '.claude', 'plugins', 'cache')
  const detected: DetectedApp[] = []

  try {
    await access(cacheDir)
  } catch {
    return []
  }

  let marketplaces: string[]
  try {
    marketplaces = await readdir(cacheDir)
  } catch {
    return []
  }

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
          mcpServers?: Record<
            string,
            { type?: string; url?: string; command?: string; args?: string[] }
          >
        }
        if (config.mcpServers == null) continue
        for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
          const transportType = (serverConfig.type ?? 'stdio') as DetectedAppTransport['type']
          detected.push({
            platformId: `claude-code:${marketplace}/${plugin}/${serverName}`,
            name: formatPluginName(plugin, serverName),
            via: `claude-code:${serverName}`,
            path: mcpJsonPath,
            category: 'tool',
            detectedFrom: 'claude-code',
            transport: {
              type: transportType,
              ...(serverConfig.url != null ? { url: serverConfig.url } : {}),
              ...(serverConfig.command != null ? { command: serverConfig.command } : {}),
              ...(serverConfig.args != null ? { args: serverConfig.args } : {}),
            },
          })
        }
      } catch {
        // no mcp.json or malformed — skip
      }
    }
  }

  return detected
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function readMCPConfigFile(
  configPath: string,
  source: DetectedAppSource,
  viaFor: (name: string) => string,
): Promise<readonly DetectedApp[]> {
  let raw: string
  try {
    raw = await readFile(configPath, 'utf-8')
  } catch {
    return []
  }

  let config: {
    mcpServers?: Record<
      string,
      { command?: string; args?: string[]; url?: string; type?: string }
    >
  }
  try {
    config = JSON.parse(raw)
  } catch {
    return []
  }

  if (config.mcpServers == null) return []

  const detected: DetectedApp[] = []
  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    const transportType = (serverConfig.type ??
      (serverConfig.url != null ? 'http' : 'stdio')) as DetectedAppTransport['type']
    detected.push({
      platformId: `${source}:${serverName}`,
      name: formatServerName(serverName),
      via: viaFor(serverName),
      path: configPath,
      category: 'tool',
      detectedFrom: source,
      transport: {
        type: transportType,
        ...(serverConfig.url != null ? { url: serverConfig.url } : {}),
        ...(serverConfig.command != null ? { command: serverConfig.command } : {}),
        ...(serverConfig.args != null ? { args: serverConfig.args } : {}),
      },
    })
  }
  return detected
}

function formatPluginName(plugin: string, serverName: string): string {
  const clean = plugin.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  return clean.toLowerCase() === serverName.toLowerCase() ? clean : clean
}

function formatServerName(serverName: string): string {
  return serverName.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

const SOURCE_ORDER: Record<DetectedAppSource, number> = {
  spotlight: 0,
  bridge: 1,
  'claude-desktop': 2,
  'claude-code': 3,
}

function sortDetectedApps(apps: readonly DetectedApp[]): readonly DetectedApp[] {
  return [...apps].sort((a, b) => {
    const sourceDelta = SOURCE_ORDER[a.detectedFrom] - SOURCE_ORDER[b.detectedFrom]
    if (sourceDelta !== 0) return sourceDelta
    return a.name.localeCompare(b.name)
  })
}
