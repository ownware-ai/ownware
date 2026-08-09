import { describe, expect, it } from 'vitest'
import {
  parsePluginManifest,
  pluginManifestDigest,
} from '../../../src/plugin/manifest.js'

function manifest() {
  return {
    schemaVersion: 1 as const,
    id: 'documents',
    version: '1.0.0',
    name: 'Documents',
    description: 'Create and revise structured documents.',
    tasks: [{
      id: 'create-document',
      label: 'Create a document',
      description: 'Plan, draft, and verify a structured document.',
      skill: 'skills/create-document',
      examples: ['Create a project brief.'],
    }],
    permissions: { tools: ['filesystem_*'], network: [] },
    migrations: [],
  }
}

describe('plugin manifest', () => {
  it('validates the bounded task-oriented manifest and gives it stable identity', () => {
    const parsed = parsePluginManifest(manifest())
    expect(parsed.tasks[0]?.label).toBe('Create a document')
    expect(pluginManifestDigest(parsed)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('rejects path traversal, duplicate task ids and unknown fields', () => {
    expect(() => parsePluginManifest({
      ...manifest(),
      tasks: [{ ...manifest().tasks[0], skill: '../escape' }],
    })).toThrow()
    expect(() => parsePluginManifest({
      ...manifest(),
      tasks: [manifest().tasks[0], manifest().tasks[0]],
    })).toThrow()
    expect(() => parsePluginManifest({ ...manifest(), executable: 'install.sh' })).toThrow()
  })
})
