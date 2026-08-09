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

  it('accepts bounded v2 display metadata while preserving v1 compatibility', () => {
    expect(parsePluginManifest({
      ...manifest(),
      schemaVersion: 2,
      display: {
        category: 'documents-files',
        icon: 'display/icon.svg',
        accent: 'blue',
      },
    })).toMatchObject({
      schemaVersion: 2,
      display: { icon: 'display/icon.svg', accent: 'blue' },
    })
    expect(() => parsePluginManifest({
      ...manifest(),
      schemaVersion: 2,
      display: { category: 'documents-files', icon: '../icon.svg', accent: 'blue' },
    })).toThrow()
  })

  it('accepts typed schema-v3 resources and rejects misplaced resource kinds', () => {
    const v3 = {
      ...manifest(),
      schemaVersion: 3,
      display: {
        category: 'documents-files',
        icon: 'display/icon.svg',
        composerIcon: 'display/icon.png',
        accent: 'blue',
      },
      tasks: [{
        ...manifest().tasks[0],
        references: ['references/workflow.md'],
        resources: [
          { kind: 'script', path: 'scripts/inspect.py', description: 'Inspect a document.' },
          { kind: 'template', path: 'assets/templates/brief.md', description: 'Brief outline.' },
          { kind: 'schema', path: 'schemas/plan.json', description: 'Plan schema.' },
        ],
      }],
    }
    expect(parsePluginManifest(v3)).toMatchObject({
      schemaVersion: 3,
      tasks: [expect.objectContaining({
        resources: expect.arrayContaining([
          expect.objectContaining({ kind: 'script', path: 'scripts/inspect.py' }),
        ]),
      })],
    })
    expect(() => parsePluginManifest({
      ...v3,
      tasks: [{
        ...v3.tasks[0],
        resources: [{ kind: 'script', path: 'assets/inspect.py', description: 'Wrong root.' }],
      }],
    })).toThrow()
  })
})
