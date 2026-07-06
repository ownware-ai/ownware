/**
 * cortex.profile.json (marketplace manifest) parser tests.
 *
 * The manifest is the contract between the publisher and the install
 * pipeline. Any change to accepted shapes lands here first.
 */

import { describe, it, expect } from 'vitest'
import {
  parseManifest,
  MANIFEST_MAX_BYTES,
} from '../../../src/profile/install/manifest.js'
import type { MarketplaceManifest } from '../../../src/profile/install/manifest.js'
import { InstallError, isInstallError } from '../../../src/profile/install/errors.js'

function expectInvalid(raw: string, snippet?: string | RegExp): InstallError {
  let caught: unknown
  try { parseManifest(raw) } catch (err) { caught = err }
  expect(isInstallError(caught)).toBe(true)
  expect((caught as InstallError).code).toBe('invalid_manifest')
  if (snippet !== undefined) {
    const issues = ((caught as InstallError).detail as { issues: string[] }).issues
    const joined = issues.join('\n')
    if (snippet instanceof RegExp) expect(joined).toMatch(snippet)
    else expect(joined).toContain(snippet)
  }
  return caught as InstallError
}

const MINIMAL: MarketplaceManifest = {
  schema: 1,
  id: 'acme/finance',
  summary: 'Finance analyst with helpers',
  category: 'General',
  models: [],
  connectors: [],
  capabilities: [],
  profiles: [{ name: 'finance', path: 'profiles/finance' }],
}

describe('parseManifest: accepted shapes', () => {
  it('parses a minimal manifest', () => {
    const got = parseManifest(JSON.stringify(MINIMAL))
    expect(got).toEqual(MINIMAL)
  })

  it('parses a full manifest with multiple profiles + connectors', () => {
    const full = {
      schema: 1,
      id: 'ownware/builtins',
      summary: 'Built-in profiles',
      category: 'Engineering',
      models: ['anthropic:claude-sonnet-4-6', 'anthropic:claude-haiku-4-5'],
      connectors: [
        { id: 'sec-edgar', label: 'SEC EDGAR', auth: 'none' },
        { id: 'fred', label: 'FRED', auth: 'free-key', hint: 'https://fred.stlouisfed.org' },
        { id: 'factset', label: 'FactSet', auth: 'paid-key', required: false },
      ],
      capabilities: ['filesystem-rw', 'shell', 'web', 'subagents'],
      profiles: [
        { name: 'coder', path: 'profiles/coder' },
        { name: 'finance', path: 'profiles/finance' },
        { name: 'planner', path: 'profiles/planner' },
      ],
    }
    const got = parseManifest(JSON.stringify(full))
    expect(got.profiles).toHaveLength(3)
    expect(got.connectors).toHaveLength(3)
  })

  it('applies defaults for omitted optional fields', () => {
    const got = parseManifest(JSON.stringify({
      schema: 1,
      id: 'a/b',
      summary: 's',
      profiles: [{ name: 'p', path: 'p' }],
    }))
    expect(got.category).toBe('General')
    expect(got.models).toEqual([])
    expect(got.connectors).toEqual([])
    expect(got.capabilities).toEqual([])
  })

  it('connector defaults required to true', () => {
    const got = parseManifest(JSON.stringify({
      ...MINIMAL,
      connectors: [{ id: 'x', label: 'X', auth: 'none' }],
    }))
    expect(got.connectors[0]?.required).toBe(true)
  })
})

describe('parseManifest: structural rejections', () => {
  it('rejects empty input', () => expectInvalid(''))

  it('rejects malformed JSON', () => {
    expectInvalid('{ "id": "a/b", ', 'JSON parse')
  })

  it('rejects schema != 1', () => {
    expectInvalid(JSON.stringify({ ...MINIMAL, schema: 2 }), 'schema')
  })

  it('rejects missing id', () => {
    const { ...rest } = MINIMAL
    const bad = JSON.parse(JSON.stringify(rest)) as Record<string, unknown>
    delete bad['id']
    expectInvalid(JSON.stringify(bad), 'id')
  })

  it('rejects id not in owner/repo form', () => {
    expectInvalid(JSON.stringify({ ...MINIMAL, id: 'no-slash' }), 'id')
    expectInvalid(JSON.stringify({ ...MINIMAL, id: 'too/many/slashes' }), 'id')
    expectInvalid(JSON.stringify({ ...MINIMAL, id: '' }), 'id')
  })

  it('rejects empty profiles[]', () => {
    expectInvalid(JSON.stringify({ ...MINIMAL, profiles: [] }), 'profiles')
  })

  it('rejects unknown top-level field (strict)', () => {
    expectInvalid(JSON.stringify({ ...MINIMAL, extraField: 1 }), 'extra')
  })

  it('rejects duplicate profile name', () => {
    expectInvalid(JSON.stringify({
      ...MINIMAL,
      profiles: [
        { name: 'p', path: 'a' },
        { name: 'p', path: 'b' },
      ],
    }), 'duplicate profile name')
  })

  it('rejects duplicate profile path', () => {
    expectInvalid(JSON.stringify({
      ...MINIMAL,
      profiles: [
        { name: 'p1', path: 'same' },
        { name: 'p2', path: 'same' },
      ],
    }), 'duplicate profile path')
  })
})

describe('parseManifest: profile entry security', () => {
  it('rejects absolute path', () => {
    expectInvalid(JSON.stringify({
      ...MINIMAL,
      profiles: [{ name: 'p', path: '/etc/passwd' }],
    }), 'relative subpath')
  })

  it('rejects path with ..', () => {
    expectInvalid(JSON.stringify({
      ...MINIMAL,
      profiles: [{ name: 'p', path: '../../escape' }],
    }), 'relative subpath')
  })

  it('rejects Windows drive letter path', () => {
    expectInvalid(JSON.stringify({
      ...MINIMAL,
      profiles: [{ name: 'p', path: 'C:/evil' }],
    }), 'relative subpath')
  })

  it('rejects profile name with slash', () => {
    expectInvalid(JSON.stringify({
      ...MINIMAL,
      profiles: [{ name: 'a/b', path: 'p' }],
    }), 'profile name')
  })

  it('rejects profile name with space', () => {
    expectInvalid(JSON.stringify({
      ...MINIMAL,
      profiles: [{ name: 'a b', path: 'p' }],
    }), 'profile name')
  })
})

describe('parseManifest: connector validation', () => {
  it('rejects unknown auth value', () => {
    expectInvalid(JSON.stringify({
      ...MINIMAL,
      connectors: [{ id: 'x', label: 'X', auth: 'magic' }],
    }), 'auth')
  })

  it('rejects unknown capability', () => {
    expectInvalid(JSON.stringify({
      ...MINIMAL,
      capabilities: ['superpowers'],
    }), 'capabilities')
  })
})

describe('parseManifest: byte limit', () => {
  it('rejects payload larger than the byte cap', () => {
    const huge = JSON.stringify({
      ...MINIMAL,
      summary: 'x'.repeat(MANIFEST_MAX_BYTES),
    })
    expectInvalid(huge, /exceeds .* bytes/)
  })
})
