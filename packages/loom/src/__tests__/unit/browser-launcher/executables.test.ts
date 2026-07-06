/**
 * Unit tests for browser-launcher/executables.ts
 *
 * Covers: exec-line parsing helpers, Windows env-var expansion, Windows
 * executable extraction, version parsing, and the public resolver's
 * override / error paths. Platform-specific detection (plutil, xdg,
 * registry) is exercised indirectly — the helpers that feed it are
 * tested in isolation.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  splitExecLine,
  extractExecutableFromExecLine,
  expandWindowsEnvVars,
  extractWindowsExecutablePath,
  parseBrowserMajorVersion,
  resolveBrowserExecutableForPlatform,
  findBrowserExecutable,
} from '../../../browser-launcher/executables.js'

// ---------------------------------------------------------------------------
// splitExecLine
// ---------------------------------------------------------------------------

describe('splitExecLine', () => {
  it('splits whitespace-separated tokens', () => {
    expect(splitExecLine('/usr/bin/google-chrome --incognito %U')).toEqual([
      '/usr/bin/google-chrome',
      '--incognito',
      '%U',
    ])
  })

  it('keeps double-quoted segments intact', () => {
    expect(splitExecLine('"/path with space/bin" --flag')).toEqual([
      '/path with space/bin',
      '--flag',
    ])
  })

  it('keeps single-quoted segments intact', () => {
    expect(splitExecLine("'one token' second")).toEqual(['one token', 'second'])
  })

  it('collapses runs of whitespace', () => {
    expect(splitExecLine('a   b\tc')).toEqual(['a', 'b', 'c'])
  })

  it('returns empty array for empty line', () => {
    expect(splitExecLine('')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// extractExecutableFromExecLine
// ---------------------------------------------------------------------------

describe('extractExecutableFromExecLine', () => {
  it('skips leading env= assignments', () => {
    expect(
      extractExecutableFromExecLine('FOO=1 BAR=2 /usr/bin/chromium --flag'),
    ).toBe('/usr/bin/chromium')
  })

  it('skips a leading `env` command', () => {
    expect(extractExecutableFromExecLine('env FOO=1 /usr/bin/brave')).toBe(
      '/usr/bin/brave',
    )
  })

  it('strips surrounding quotes from the binary path', () => {
    expect(extractExecutableFromExecLine('"/path with space/chrome" --arg')).toBe(
      '/path with space/chrome',
    )
  })

  it('keeps absolute paths that happen to contain `=`', () => {
    expect(extractExecutableFromExecLine('/weird/name=bin --flag')).toBe(
      '/weird/name=bin',
    )
  })

  it('returns null for an empty exec line', () => {
    expect(extractExecutableFromExecLine('')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// expandWindowsEnvVars
// ---------------------------------------------------------------------------

describe('expandWindowsEnvVars', () => {
  it('expands a known env var', () => {
    const envKey = '__LOOM_TEST_BROWSER_LAUNCHER_ENV__'
    process.env[envKey] = 'C:\\Stub'
    try {
      expect(expandWindowsEnvVars(`%${envKey}%\\Chrome\\chrome.exe`)).toBe(
        'C:\\Stub\\Chrome\\chrome.exe',
      )
    } finally {
      delete process.env[envKey]
    }
  })

  it('leaves unknown %VAR% tokens as-is', () => {
    expect(expandWindowsEnvVars('%__LOOM_NOT_SET__%\\x.exe')).toBe(
      '%__LOOM_NOT_SET__%\\x.exe',
    )
  })

  it('is a no-op on strings without %VAR% tokens', () => {
    expect(expandWindowsEnvVars('C:\\plain\\path.exe')).toBe(
      'C:\\plain\\path.exe',
    )
  })
})

// ---------------------------------------------------------------------------
// extractWindowsExecutablePath
// ---------------------------------------------------------------------------

describe('extractWindowsExecutablePath', () => {
  it('extracts a quoted path', () => {
    expect(
      extractWindowsExecutablePath(
        '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --single-argument %1',
      ),
    ).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  })

  it('extracts an unquoted path', () => {
    expect(
      extractWindowsExecutablePath('C:\\Windows\\System32\\notepad.exe /flag'),
    ).toBe('C:\\Windows\\System32\\notepad.exe')
  })

  it('returns null when no .exe is present', () => {
    expect(extractWindowsExecutablePath('open %1')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// parseBrowserMajorVersion
// ---------------------------------------------------------------------------

describe('parseBrowserMajorVersion', () => {
  it('parses the major version from a Chrome version string', () => {
    expect(parseBrowserMajorVersion('Google Chrome 126.0.6478.127')).toBe(126)
  })

  it('parses a bare version', () => {
    expect(parseBrowserMajorVersion('119')).toBe(119)
  })

  it('returns null for garbage input', () => {
    expect(parseBrowserMajorVersion('no version here')).toBeNull()
  })

  it('returns null for null / undefined', () => {
    expect(parseBrowserMajorVersion(null)).toBeNull()
    expect(parseBrowserMajorVersion(undefined)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// resolveBrowserExecutableForPlatform — override path
// ---------------------------------------------------------------------------

describe('resolveBrowserExecutableForPlatform', () => {
  it('returns `custom` for an explicit executablePath that exists', () => {
    // Use a path we know exists on every test runner: this very test file.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-exec-test-'))
    const fakeBrowser = path.join(tmpDir, 'fake-chrome')
    fs.writeFileSync(fakeBrowser, '')
    try {
      const resolved = resolveBrowserExecutableForPlatform('darwin', {
        executablePath: fakeBrowser,
      })
      expect(resolved).toEqual({ kind: 'custom', path: fakeBrowser })
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('throws for an explicit executablePath that does not exist', () => {
    const missing = path.join(
      os.tmpdir(),
      `loom-missing-${Date.now()}-${Math.random()}`,
    )
    expect(() =>
      resolveBrowserExecutableForPlatform('darwin', { executablePath: missing }),
    ).toThrow(/executablePath not found/)
  })

  it('returns null on an unknown platform', () => {
    expect(
      resolveBrowserExecutableForPlatform('sunos' as NodeJS.Platform),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// findBrowserExecutable (wraps the current platform)
// ---------------------------------------------------------------------------

describe('findBrowserExecutable', () => {
  it('returns BrowserExecutable or null without throwing', () => {
    const result = findBrowserExecutable()
    // Either null (no Chrome installed) or a valid record. Never throws.
    if (result !== null) {
      expect(result).toHaveProperty('kind')
      expect(result).toHaveProperty('path')
      expect(typeof result.path).toBe('string')
      expect(result.path.length).toBeGreaterThan(0)
    }
  })
})
