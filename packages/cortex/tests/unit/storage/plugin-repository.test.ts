import { describe, expect, it } from 'vitest'
import {
  canonicalPluginJson,
  comparePluginVersionsDescending,
  normalizePluginGrantKey,
  normalizePluginPackageKey,
  normalizePluginVersion,
} from '../../../src/storage/plugin-repository.js'

describe('plugin repository value boundary', () => {
  it('canonicalizes manifest objects independent of property insertion order', () => {
    expect(canonicalPluginJson({ z: [2, 1], a: { y: true, x: null } }))
      .toBe('{"a":{"x":null,"y":true},"z":[2,1]}')
  })

  it('accepts strict semantic versions and sorts release before prerelease', () => {
    expect(normalizePluginVersion('2.1.0-beta.2+build.7')).toBe('2.1.0-beta.2+build.7')
    expect(['1.0.0-beta.10', '1.0.0', '1.0.0-beta.2'].sort(
      comparePluginVersionsDescending,
    )).toEqual(['1.0.0', '1.0.0-beta.10', '1.0.0-beta.2'])
    expect(() => normalizePluginVersion('01.0.0')).toThrow(TypeError)
  })

  it('rejects escaping package keys and malformed scope shapes', () => {
    expect(() => normalizePluginPackageKey('../documents')).toThrow(TypeError)
    expect(() => normalizePluginPackageKey('/documents')).toThrow(TypeError)
    expect(() => normalizePluginGrantKey({
      pluginId: 'documents',
      scopeKind: 'global',
      scopeId: 'not-global',
    })).toThrow(TypeError)
  })
})
