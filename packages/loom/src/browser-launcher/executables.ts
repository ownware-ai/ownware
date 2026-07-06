/**
 * Browser executable detection.
 *
 * Finds a Chromium-family browser (Chrome, Brave, Edge, Chromium, Canary) on
 * the current platform. Two strategies, tried in order:
 *
 *   1. System default browser (macOS plutil/osascript, Linux xdg-settings,
 *      Windows registry) — honours the user's chosen browser.
 *   2. Well-known install paths — falls back when no Chromium-family default
 *      is set.
 *
 * This module is deliberately free of runtime dependencies; everything uses
 * node built-ins. It is safe to call on startup, before any child process
 * has been spawned.
 *
 * Portions derived from openclaw/extensions/browser
 * (https://github.com/openclaw, MIT, Copyright (c) 2025 Peter Steinberger).
 * The MIT license permits this use; attribution is retained above.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BrowserKind =
  | 'chrome'
  | 'canary'
  | 'brave'
  | 'edge'
  | 'chromium'
  | 'custom'

export interface BrowserExecutable {
  readonly kind: BrowserKind
  readonly path: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHROME_VERSION_RE = /(\d+)(?:\.\d+){0,3}/

/** macOS bundle identifiers for Chromium-family browsers. */
const CHROMIUM_BUNDLE_IDS: ReadonlySet<string> = new Set([
  'com.google.Chrome',
  'com.google.Chrome.beta',
  'com.google.Chrome.canary',
  'com.google.Chrome.dev',
  'com.brave.Browser',
  'com.brave.Browser.beta',
  'com.brave.Browser.nightly',
  'com.microsoft.Edge',
  'com.microsoft.EdgeBeta',
  'com.microsoft.EdgeDev',
  'com.microsoft.EdgeCanary',
  // Edge LaunchServices identifiers — these differ from CFBundleIdentifier
  // and are what plutil returns when querying the default-browser plist.
  'com.microsoft.edgemac',
  'com.microsoft.edgemac.beta',
  'com.microsoft.edgemac.dev',
  'com.microsoft.edgemac.canary',
  'org.chromium.Chromium',
  'com.vivaldi.Vivaldi',
  'com.operasoftware.Opera',
  'com.operasoftware.OperaGX',
  'com.yandex.desktop.yandex-browser',
  'company.thebrowser.Browser', // Arc
])

/** Linux .desktop file identifiers. */
const CHROMIUM_DESKTOP_IDS: ReadonlySet<string> = new Set([
  'google-chrome.desktop',
  'google-chrome-beta.desktop',
  'google-chrome-unstable.desktop',
  'brave-browser.desktop',
  'microsoft-edge.desktop',
  'microsoft-edge-beta.desktop',
  'microsoft-edge-dev.desktop',
  'microsoft-edge-canary.desktop',
  'chromium.desktop',
  'chromium-browser.desktop',
  'vivaldi.desktop',
  'vivaldi-stable.desktop',
  'opera.desktop',
  'opera-gx.desktop',
  'yandex-browser.desktop',
  'org.chromium.Chromium.desktop',
])

/** Executable basenames that indicate a Chromium-family browser. */
const CHROMIUM_EXE_NAMES: ReadonlySet<string> = new Set([
  // Windows
  'chrome.exe',
  'msedge.exe',
  'brave.exe',
  'brave-browser.exe',
  'chromium.exe',
  'vivaldi.exe',
  'opera.exe',
  'launcher.exe',
  'yandex.exe',
  'yandexbrowser.exe',
  // macOS / Linux
  'google chrome',
  'google chrome canary',
  'brave browser',
  'microsoft edge',
  'chromium',
  'chrome',
  'brave',
  'msedge',
  'brave-browser',
  'google-chrome',
  'google-chrome-stable',
  'google-chrome-beta',
  'google-chrome-unstable',
  'microsoft-edge',
  'microsoft-edge-beta',
  'microsoft-edge-dev',
  'microsoft-edge-canary',
  'chromium-browser',
  'vivaldi',
  'vivaldi-stable',
  'opera',
  'opera-stable',
  'opera-gx',
  'yandex-browser',
])

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function exists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath)
  } catch {
    return false
  }
}

/**
 * Run a command and capture its trimmed stdout. Returns null on any error
 * (non-zero exit, timeout, ENOENT). Never throws. Used only for best-effort
 * system probes (plutil, osascript, xdg-settings, reg); a null result means
 * "could not determine," which every caller handles.
 */
function execText(
  command: string,
  args: readonly string[],
  timeoutMs = 1200,
  maxBuffer = 1024 * 1024,
): string | null {
  try {
    const output = execFileSync(command, [...args], {
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer,
    })
    return String(output ?? '').trim() || null
  } catch {
    return null
  }
}

function inferKindFromIdentifier(identifier: string): BrowserKind {
  const id = identifier.toLowerCase()
  if (id.includes('brave')) return 'brave'
  if (id.includes('edge')) return 'edge'
  if (id.includes('chromium')) return 'chromium'
  if (id.includes('canary')) return 'canary'
  if (
    id.includes('opera') ||
    id.includes('vivaldi') ||
    id.includes('yandex') ||
    id.includes('thebrowser')
  ) {
    return 'chromium'
  }
  return 'chrome'
}

function inferKindFromExecutableName(name: string): BrowserKind {
  const lower = name.toLowerCase()
  if (lower.includes('brave')) return 'brave'
  if (lower.includes('edge') || lower.includes('msedge')) return 'edge'
  if (lower.includes('chromium')) return 'chromium'
  if (lower.includes('canary') || lower.includes('sxs')) return 'canary'
  if (
    lower.includes('opera') ||
    lower.includes('vivaldi') ||
    lower.includes('yandex')
  ) {
    return 'chromium'
  }
  return 'chrome'
}

// ---------------------------------------------------------------------------
// macOS default-browser detection
// ---------------------------------------------------------------------------

function detectDefaultChromiumExecutableMac(): BrowserExecutable | null {
  const bundleId = detectDefaultBrowserBundleIdMac()
  if (!bundleId || !CHROMIUM_BUNDLE_IDS.has(bundleId)) return null

  const appPathRaw = execText('/usr/bin/osascript', [
    '-e',
    `POSIX path of (path to application id "${bundleId}")`,
  ])
  if (!appPathRaw) return null

  const appPath = appPathRaw.trim().replace(/\/$/, '')
  const exeName = execText('/usr/bin/defaults', [
    'read',
    path.join(appPath, 'Contents', 'Info'),
    'CFBundleExecutable',
  ])
  if (!exeName) return null

  const exePath = path.join(appPath, 'Contents', 'MacOS', exeName.trim())
  if (!exists(exePath)) return null

  return { kind: inferKindFromIdentifier(bundleId), path: exePath }
}

function detectDefaultBrowserBundleIdMac(): string | null {
  const plistPath = path.join(
    os.homedir(),
    'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist',
  )
  if (!exists(plistPath)) return null

  const handlersRaw = execText(
    '/usr/bin/plutil',
    ['-extract', 'LSHandlers', 'json', '-o', '-', '--', plistPath],
    2000,
    5 * 1024 * 1024,
  )
  if (!handlersRaw) return null

  let handlers: unknown
  try {
    handlers = JSON.parse(handlersRaw)
  } catch {
    return null
  }
  if (!Array.isArray(handlers)) return null

  const resolveScheme = (scheme: string): string | null => {
    let candidate: string | null = null
    for (const entry of handlers) {
      if (!entry || typeof entry !== 'object') continue
      const record = entry as Record<string, unknown>
      if (record.LSHandlerURLScheme !== scheme) continue
      const role =
        (typeof record.LSHandlerRoleAll === 'string' && record.LSHandlerRoleAll) ||
        (typeof record.LSHandlerRoleViewer === 'string' && record.LSHandlerRoleViewer) ||
        null
      if (role) candidate = role
    }
    return candidate
  }

  return resolveScheme('http') ?? resolveScheme('https')
}

// ---------------------------------------------------------------------------
// Linux default-browser detection
// ---------------------------------------------------------------------------

function detectDefaultChromiumExecutableLinux(): BrowserExecutable | null {
  const desktopId =
    execText('xdg-settings', ['get', 'default-web-browser']) ||
    execText('xdg-mime', ['query', 'default', 'x-scheme-handler/http'])
  if (!desktopId) return null

  const trimmed = desktopId.trim()
  if (!CHROMIUM_DESKTOP_IDS.has(trimmed)) return null

  const desktopPath = findDesktopFilePath(trimmed)
  if (!desktopPath) return null

  const execLine = readDesktopExecLine(desktopPath)
  if (!execLine) return null

  const command = extractExecutableFromExecLine(execLine)
  if (!command) return null

  const resolved = resolveLinuxExecutablePath(command)
  if (!resolved) return null

  const exeName = path.posix.basename(resolved).toLowerCase()
  if (!CHROMIUM_EXE_NAMES.has(exeName)) return null

  return { kind: inferKindFromExecutableName(exeName), path: resolved }
}

function findDesktopFilePath(desktopId: string): string | null {
  const candidates = [
    path.join(os.homedir(), '.local', 'share', 'applications', desktopId),
    path.join('/usr/local/share/applications', desktopId),
    path.join('/usr/share/applications', desktopId),
    path.join('/var/lib/snapd/desktop/applications', desktopId),
  ]
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return null
}

function readDesktopExecLine(desktopPath: string): string | null {
  try {
    const raw = fs.readFileSync(desktopPath, 'utf8')
    const lines = raw.split(/\r?\n/)
    for (const line of lines) {
      if (line.startsWith('Exec=')) return line.slice('Exec='.length).trim()
    }
  } catch {
    // Unreadable — treat as "no exec line".
  }
  return null
}

export function extractExecutableFromExecLine(execLine: string): string | null {
  const tokens = splitExecLine(execLine)
  for (const token of tokens) {
    if (!token) continue
    if (token === 'env') continue
    // Skip `KEY=value` environment assignments (but allow `/path/with=equals`).
    if (token.includes('=') && !token.startsWith('/') && !token.includes('\\')) {
      continue
    }
    return token.replace(/^["']|["']$/g, '')
  }
  return null
}

export function splitExecLine(line: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inQuotes = false
  let quoteChar = ''
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === undefined) continue
    if ((ch === '"' || ch === "'") && (!inQuotes || ch === quoteChar)) {
      if (inQuotes) {
        inQuotes = false
        quoteChar = ''
      } else {
        inQuotes = true
        quoteChar = ch
      }
      continue
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current) tokens.push(current)
  return tokens
}

function resolveLinuxExecutablePath(command: string): string | null {
  // Strip Freedesktop field codes (%U, %F, etc.) before resolving.
  const cleaned = command.trim().replace(/%[a-zA-Z]/g, '').trim()
  if (!cleaned) return null
  if (cleaned.startsWith('/')) return cleaned
  const resolved = execText('which', [cleaned], 800)
  return resolved ? resolved.trim() : null
}

// ---------------------------------------------------------------------------
// Windows default-browser detection
// ---------------------------------------------------------------------------

function detectDefaultChromiumExecutableWindows(): BrowserExecutable | null {
  const progId = readWindowsProgId()
  const command =
    (progId ? readWindowsCommandForProgId(progId) : null) ||
    readWindowsCommandForProgId('http')
  if (!command) return null

  const expanded = expandWindowsEnvVars(command)
  const exePath = extractWindowsExecutablePath(expanded)
  if (!exePath) return null
  if (!exists(exePath)) return null

  const exeName = path.win32.basename(exePath).toLowerCase()
  if (!CHROMIUM_EXE_NAMES.has(exeName)) return null

  return { kind: inferKindFromExecutableName(exeName), path: exePath }
}

function readWindowsProgId(): string | null {
  const output = execText('reg', [
    'query',
    'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
    '/v',
    'ProgId',
  ])
  if (!output) return null
  const match = output.match(/ProgId\s+REG_\w+\s+(.+)$/im)
  return match?.[1]?.trim() || null
}

function readWindowsCommandForProgId(progId: string): string | null {
  const key =
    progId === 'http'
      ? 'HKCR\\http\\shell\\open\\command'
      : `HKCR\\${progId}\\shell\\open\\command`
  const output = execText('reg', ['query', key, '/ve'])
  if (!output) return null
  const match = output.match(/REG_\w+\s+(.+)$/im)
  return match?.[1]?.trim() || null
}

export function expandWindowsEnvVars(value: string): string {
  return value.replace(/%([^%]+)%/g, (match, rawName) => {
    const key = String(rawName ?? '').trim()
    if (!key) return match
    return process.env[key] ?? `%${key}%`
  })
}

export function extractWindowsExecutablePath(command: string): string | null {
  const quoted = command.match(/"([^"]+\.exe)"/i)
  if (quoted?.[1]) return quoted[1]
  const unquoted = command.match(/(\S+\.exe)/i)
  if (unquoted?.[1]) return unquoted[1]
  return null
}

// ---------------------------------------------------------------------------
// Well-known install-path fallbacks
// ---------------------------------------------------------------------------

function findFirstExecutable(
  candidates: readonly BrowserExecutable[],
): BrowserExecutable | null {
  for (const candidate of candidates) {
    if (exists(candidate.path)) return candidate
  }
  return null
}

export function findChromeExecutableMac(): BrowserExecutable | null {
  const candidates: BrowserExecutable[] = [
    {
      kind: 'chrome',
      path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    },
    {
      kind: 'chrome',
      path: path.join(
        os.homedir(),
        'Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ),
    },
    {
      kind: 'brave',
      path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    },
    {
      kind: 'brave',
      path: path.join(
        os.homedir(),
        'Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      ),
    },
    {
      kind: 'edge',
      path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    },
    {
      kind: 'edge',
      path: path.join(
        os.homedir(),
        'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ),
    },
    {
      kind: 'chromium',
      path: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    },
    {
      kind: 'chromium',
      path: path.join(os.homedir(), 'Applications/Chromium.app/Contents/MacOS/Chromium'),
    },
    {
      kind: 'canary',
      path: '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    },
    {
      kind: 'canary',
      path: path.join(
        os.homedir(),
        'Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      ),
    },
  ]
  return findFirstExecutable(candidates)
}

export function findChromeExecutableLinux(): BrowserExecutable | null {
  const candidates: BrowserExecutable[] = [
    { kind: 'chrome', path: '/usr/bin/google-chrome' },
    { kind: 'chrome', path: '/usr/bin/google-chrome-stable' },
    { kind: 'chrome', path: '/usr/bin/chrome' },
    { kind: 'brave', path: '/usr/bin/brave-browser' },
    { kind: 'brave', path: '/usr/bin/brave-browser-stable' },
    { kind: 'brave', path: '/usr/bin/brave' },
    { kind: 'brave', path: '/snap/bin/brave' },
    { kind: 'edge', path: '/usr/bin/microsoft-edge' },
    { kind: 'edge', path: '/usr/bin/microsoft-edge-stable' },
    { kind: 'chromium', path: '/usr/bin/chromium' },
    { kind: 'chromium', path: '/usr/bin/chromium-browser' },
    { kind: 'chromium', path: '/snap/bin/chromium' },
  ]
  return findFirstExecutable(candidates)
}

export function findChromeExecutableWindows(): BrowserExecutable | null {
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  // Bracket notation is required: the key contains parentheses.
  const programFilesX86 =
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const joinWin = path.win32.join
  const candidates: BrowserExecutable[] = []

  if (localAppData) {
    candidates.push(
      {
        kind: 'chrome',
        path: joinWin(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      },
      {
        kind: 'brave',
        path: joinWin(
          localAppData,
          'BraveSoftware',
          'Brave-Browser',
          'Application',
          'brave.exe',
        ),
      },
      {
        kind: 'edge',
        path: joinWin(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      },
      {
        kind: 'chromium',
        path: joinWin(localAppData, 'Chromium', 'Application', 'chrome.exe'),
      },
      {
        kind: 'canary',
        path: joinWin(
          localAppData,
          'Google',
          'Chrome SxS',
          'Application',
          'chrome.exe',
        ),
      },
    )
  }

  candidates.push(
    {
      kind: 'chrome',
      path: joinWin(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    },
    {
      kind: 'chrome',
      path: joinWin(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    },
    {
      kind: 'brave',
      path: joinWin(
        programFiles,
        'BraveSoftware',
        'Brave-Browser',
        'Application',
        'brave.exe',
      ),
    },
    {
      kind: 'brave',
      path: joinWin(
        programFilesX86,
        'BraveSoftware',
        'Brave-Browser',
        'Application',
        'brave.exe',
      ),
    },
    {
      kind: 'edge',
      path: joinWin(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    },
    {
      kind: 'edge',
      path: joinWin(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    },
  )

  return findFirstExecutable(candidates)
}

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

export function readBrowserVersion(executablePath: string): string | null {
  const output = execText(executablePath, ['--version'], 2000)
  if (!output) return null
  return output.replace(/\s+/g, ' ').trim()
}

export function parseBrowserMajorVersion(
  rawVersion: string | null | undefined,
): number | null {
  const match = String(rawVersion ?? '').match(CHROME_VERSION_RE)
  const group = match?.[1]
  if (!group) return null
  const major = Number.parseInt(group, 10)
  return Number.isFinite(major) ? major : null
}

// ---------------------------------------------------------------------------
// Public resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a browser executable for the given platform.
 *
 * Resolution order:
 *   1. If `executablePath` is provided, validate and return it (as `custom`).
 *   2. Attempt system-default-browser detection (only accepts Chromium family).
 *   3. Fall back to well-known install paths.
 *   4. Return null if nothing is found.
 *
 * @throws Error if `executablePath` is supplied but does not exist.
 */
export function resolveBrowserExecutableForPlatform(
  platform: NodeJS.Platform,
  opts?: { executablePath?: string },
): BrowserExecutable | null {
  if (opts?.executablePath) {
    if (!exists(opts.executablePath)) {
      throw new Error(
        `browser executablePath not found: ${opts.executablePath}`,
      )
    }
    return { kind: 'custom', path: opts.executablePath }
  }

  if (platform === 'darwin') {
    return detectDefaultChromiumExecutableMac() ?? findChromeExecutableMac()
  }
  if (platform === 'linux') {
    return detectDefaultChromiumExecutableLinux() ?? findChromeExecutableLinux()
  }
  if (platform === 'win32') {
    return detectDefaultChromiumExecutableWindows() ?? findChromeExecutableWindows()
  }
  return null
}

/**
 * Convenience: resolve an executable for the current process's platform.
 */
export function findBrowserExecutable(opts?: {
  executablePath?: string
}): BrowserExecutable | null {
  return resolveBrowserExecutableForPlatform(process.platform, opts)
}
