/**
 * InstallIdentity — single source of truth for the install's user id.
 *
 * Pre-v19 the literal `'cortex-default-user'` and the env var
 * `OWNWARE_COMPOSIO_USER_ID` appeared in four code paths that drifted out
 * of sync, producing the "modal says ready but agent says not_connected"
 * bug. These tests pin down resolution rules so any future reintroduction
 * of a parallel default fails here first.
 */

import { describe, it, expect } from 'vitest'
import { InstallIdentity } from '../../../src/identity/install-identity.js'

describe('InstallIdentity.resolve', () => {
  it('returns the default literal when env is missing', () => {
    expect(InstallIdentity.resolve({}).id).toBe('cortex-default-user')
  })

  it('returns the default when env var is the empty string', () => {
    expect(
      InstallIdentity.resolve({ OWNWARE_COMPOSIO_USER_ID: '' }).id,
    ).toBe('cortex-default-user')
  })

  it('returns the default when env var is whitespace-only', () => {
    expect(
      InstallIdentity.resolve({ OWNWARE_COMPOSIO_USER_ID: '   ' }).id,
    ).toBe('cortex-default-user')
  })

  it('uses the env value when set, trimmed', () => {
    expect(
      InstallIdentity.resolve({ OWNWARE_COMPOSIO_USER_ID: '  team-42  ' }).id,
    ).toBe('team-42')
  })

  it('id is always a non-empty string', () => {
    const a = InstallIdentity.resolve({})
    const b = InstallIdentity.resolve({ OWNWARE_COMPOSIO_USER_ID: 'x' })
    for (const i of [a, b]) {
      expect(typeof i.id).toBe('string')
      expect(i.id.length).toBeGreaterThan(0)
    }
  })
})

describe('InstallIdentity.fromString', () => {
  it('accepts a non-empty string', () => {
    expect(InstallIdentity.fromString('alice').id).toBe('alice')
  })

  it('rejects empty', () => {
    expect(() => InstallIdentity.fromString('')).toThrow()
  })
})
