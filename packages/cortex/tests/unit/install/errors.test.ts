/**
 * Tests for the InstallError discriminated union.
 *
 * The error class is the contract every later install component throws
 * against. We verify shape, type narrowing, and default messages here so
 * downstream code can rely on the contract without re-validating.
 */

import { describe, it, expect } from 'vitest'
import { InstallError, isInstallError } from '../../../src/profile/install/errors.js'

describe('InstallError', () => {
  it('captures code and detail', () => {
    const err = new InstallError('invalid_url', { url: 'foo' })
    expect(err.code).toBe('invalid_url')
    expect(err.detail).toEqual({ url: 'foo' })
  })

  it('is an Error instance for try/catch interop', () => {
    const err = new InstallError('network', { reason: 'down' })
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(InstallError)
  })

  it('exposes a default human-readable message per code', () => {
    expect(new InstallError('invalid_url', { url: 'x' }).message).toContain('Invalid GitHub URL')
    expect(new InstallError('clone_failed', { reason: 'r' }).message).toContain('git clone')
    expect(new InstallError('oversized', { limitBytes: 1, observedBytes: 2 }).message).toContain('exceeds size limit')
    expect(new InstallError('forbidden_custom_code', { files: ['tools/foo.ts'] }).message).toContain('tools/foo.ts')
    expect(new InstallError('path_escape', { files: ['../etc'] }).message).toContain('../etc')
    expect(new InstallError('invalid_manifest', { issues: ['name required'] }).message).toContain('name required')
    expect(new InstallError('name_collision', { existing: 'x' }).message).toContain('x')
    expect(new InstallError('network', { reason: 'enotfound' }).message).toContain('enotfound')
    expect(new InstallError('auth_required', { hint: 'pat' }).message).toContain('pat')
    expect(new InstallError('unsupported_helper', { helper: 'h', reason: 'r' }).message).toContain('h')
    expect(new InstallError('manifest_not_found', { path: '/a' }).message).toContain('/a')
    expect(new InstallError('profile_load_failed', { profile: 'p', reason: 'r' }).message).toContain('p')
  })

  it('accepts an explicit message override', () => {
    const err = new InstallError('network', { reason: 'r' }, 'custom message')
    expect(err.message).toBe('custom message')
  })
})

describe('isInstallError', () => {
  it('returns true for InstallError', () => {
    expect(isInstallError(new InstallError('network', { reason: 'r' }))).toBe(true)
  })
  it('returns false for plain Error', () => {
    expect(isInstallError(new Error('boom'))).toBe(false)
  })
  it('returns false for non-error values', () => {
    expect(isInstallError(undefined)).toBe(false)
    expect(isInstallError(null)).toBe(false)
    expect(isInstallError({ code: 'invalid_url' })).toBe(false)
    expect(isInstallError('string')).toBe(false)
  })
})
