import { z } from 'zod'
import {
  canonicalPluginJson,
  normalizePluginDigest,
  normalizePluginId,
  normalizePluginVersion,
  sha256,
} from '../storage/plugin-repository.js'

const RelativePluginPathSchema = z.string().min(1).max(512).refine((value) => (
  !value.startsWith('/') &&
  !value.includes('\\') &&
  !value.includes('\0') &&
  value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
), 'Plugin path must be a contained relative path.')

const PluginTaskFields = {
  id: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
  skill: RelativePluginPathSchema,
  references: z.array(RelativePluginPathSchema).max(16).default([]),
  examples: z.array(z.string().trim().min(1).max(300)).max(8),
}

const PluginTaskSchema = z.object(PluginTaskFields).strict()

const PluginResourceSchema = z.object({
  kind: z.enum(['script', 'template', 'schema', 'asset']),
  path: RelativePluginPathSchema,
  description: z.string().trim().min(1).max(200),
}).strict()

const PluginTaskV3Schema = z.object({
  ...PluginTaskFields,
  resources: z.array(PluginResourceSchema).max(24),
}).strict()

const PluginMigrationSchema = z.object({
  id: z.string().regex(/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/),
  path: RelativePluginPathSchema,
  sha256: z.string().refine(value => {
    try {
      normalizePluginDigest(value)
      return true
    } catch {
      return false
    }
  }, 'Migration digest must be sha256:<lowercase hex>.'),
}).strict()

const PluginDisplaySchema = z.object({
  category: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  icon: RelativePluginPathSchema,
  accent: z.enum(['blue', 'red', 'green', 'amber', 'violet', 'slate']),
}).strict()

const PluginDisplayV3Schema = PluginDisplaySchema.extend({
  composerIcon: RelativePluginPathSchema,
}).strict()

const PluginManifestFields = {
  id: z.string().refine(value => {
    try {
      normalizePluginId(value)
      return true
    } catch {
      return false
    }
  }, 'Plugin id is invalid.'),
  version: z.string().refine(value => {
    try {
      normalizePluginVersion(value)
      return true
    } catch {
      return false
    }
  }, 'Plugin version must be strict semantic version.'),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(1_000),
  permissions: z.object({
    tools: z.array(z.string().regex(/^[a-zA-Z0-9_*.-]{1,128}$/)).max(128),
    network: z.array(z.string().trim().min(1).max(253)).max(64),
  }).strict(),
  migrations: z.array(PluginMigrationSchema).max(128),
}

const PluginManifestV1Schema = z.object({
  schemaVersion: z.literal(1),
  ...PluginManifestFields,
  tasks: z.array(PluginTaskSchema).min(1).max(64),
}).strict()

const PluginManifestV2Schema = z.object({
  schemaVersion: z.literal(2),
  ...PluginManifestFields,
  tasks: z.array(PluginTaskSchema).min(1).max(64),
  display: PluginDisplaySchema,
}).strict()

const PluginManifestV3Schema = z.object({
  schemaVersion: z.literal(3),
  ...PluginManifestFields,
  tasks: z.array(PluginTaskV3Schema).min(1).max(64),
  display: PluginDisplayV3Schema,
}).strict()

export const PluginManifestSchema = z.discriminatedUnion('schemaVersion', [
  PluginManifestV1Schema,
  PluginManifestV2Schema,
  PluginManifestV3Schema,
]).superRefine((manifest, context) => {
  const taskIds = new Set<string>()
  const skillPaths = new Set<string>()
  for (const task of manifest.tasks) {
    if (taskIds.has(task.id)) {
      context.addIssue({ code: 'custom', message: 'Plugin task ids must be unique.' })
    }
    if (skillPaths.has(task.skill)) {
      context.addIssue({ code: 'custom', message: 'Plugin task skill paths must be unique.' })
    }
    taskIds.add(task.id)
    skillPaths.add(task.skill)
    if (new Set(task.references).size !== task.references.length) {
      context.addIssue({ code: 'custom', message: 'Plugin task references must be unique.' })
    }
    if ('resources' in task) {
      if (task.references.some(path => !path.startsWith('references/') || !path.endsWith('.md'))) {
        context.addIssue({
          code: 'custom',
          message: 'Schema-v3 task references must be Markdown files below references/.',
        })
      }
      const resourcePaths = new Set<string>()
      for (const resource of task.resources) {
        if (resourcePaths.has(resource.path) || task.references.includes(resource.path)) {
          context.addIssue({ code: 'custom', message: 'Plugin task resource paths must be unique.' })
        }
        resourcePaths.add(resource.path)
        const expectedPrefix = resource.kind === 'script'
          ? 'scripts/'
          : resource.kind === 'schema'
            ? 'schemas/'
            : 'assets/'
        if (!resource.path.startsWith(expectedPrefix)) {
          context.addIssue({
            code: 'custom',
            message: `Plugin ${resource.kind} resources must be below ${expectedPrefix}.`,
          })
        }
      }
    }
  }
  const migrationIds = new Set<string>()
  for (const migration of manifest.migrations) {
    if (migrationIds.has(migration.id)) {
      context.addIssue({ code: 'custom', message: 'Plugin migration ids must be unique.' })
    }
    migrationIds.add(migration.id)
  }
})

export type PluginManifest = z.infer<typeof PluginManifestSchema>

export function parsePluginManifest(value: unknown): PluginManifest {
  const manifest = PluginManifestSchema.parse(value)
  return {
    ...manifest,
    id: normalizePluginId(manifest.id),
    version: normalizePluginVersion(manifest.version),
  }
}

export function parsePluginManifestJson(value: string): PluginManifest {
  if (Buffer.byteLength(value, 'utf8') > 1_048_576) {
    throw new TypeError('Plugin manifest is too large.')
  }
  return parsePluginManifest(JSON.parse(value) as unknown)
}

export function pluginManifestDigest(manifest: PluginManifest): string {
  return sha256(canonicalPluginJson(manifest))
}
