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

const PluginTaskSchema = z.object({
  id: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
  skill: RelativePluginPathSchema,
  references: z.array(RelativePluginPathSchema).max(16).default([]),
  examples: z.array(z.string().trim().min(1).max(300)).max(8),
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

export const PluginManifestSchema = z.object({
  schemaVersion: z.literal(1),
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
  tasks: z.array(PluginTaskSchema).min(1).max(64),
  permissions: z.object({
    tools: z.array(z.string().regex(/^[a-zA-Z0-9_*.-]{1,128}$/)).max(128),
    network: z.array(z.string().trim().min(1).max(253)).max(64),
  }).strict(),
  migrations: z.array(PluginMigrationSchema).max(128),
}).strict().superRefine((manifest, context) => {
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
