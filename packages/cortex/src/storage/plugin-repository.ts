import { createHash } from 'node:crypto'
import { z } from 'zod'

export const PluginSourceKindSchema = z.enum([
  'builtin',
  'local',
  'marketplace',
])

export const PluginTrustKindSchema = z.enum([
  'builtin',
  'local',
  'verified',
  'unverified',
])

export const PluginGrantScopeKindSchema = z.enum([
  'global',
  'workspace',
  'agent',
])

export const PluginGrantDecisionSchema = z.enum(['allow', 'deny'])

export type PluginSourceKind = z.infer<typeof PluginSourceKindSchema>
export type PluginTrustKind = z.infer<typeof PluginTrustKindSchema>
export type PluginGrantScopeKind = z.infer<typeof PluginGrantScopeKindSchema>
export type PluginGrantDecision = z.infer<typeof PluginGrantDecisionSchema>

export interface PluginVersionIdentity {
  readonly pluginId: string
  readonly version: string
}

export interface RegisterPluginVersionInput extends PluginVersionIdentity {
  readonly manifest: Readonly<Record<string, unknown>>
  readonly manifestSha256: string
  readonly packageSha256: string
  /** Relative to the plugin package root owned by the lifecycle service. */
  readonly packageKey: string
  readonly sourceKind: PluginSourceKind
  readonly trustKind: PluginTrustKind
}

export interface PluginVersionRecord extends RegisterPluginVersionInput {
  readonly installedAt: string
}

export interface PluginGrantKey {
  readonly pluginId: string
  readonly scopeKind: PluginGrantScopeKind
  /** Null is valid only for the single global scope. */
  readonly scopeId: string | null
}

export interface PutPluginGrantInput extends PluginGrantKey {
  readonly decision: PluginGrantDecision
  /** Required for allow and forbidden for deny. */
  readonly version: string | null
}

export interface PluginGrantRecord extends PutPluginGrantInput {
  readonly revision: number
  readonly updatedAt: string
}

export interface RecordPluginMigrationInput extends PluginVersionIdentity {
  readonly migrationId: string
  readonly migrationSha256: string
}

export interface PluginMigrationReceipt extends RecordPluginMigrationInput {
  readonly appliedAt: string
}

export interface PluginRepository {
  registerVersion(input: RegisterPluginVersionInput): Promise<PluginVersionRecord>
  getVersion(pluginId: string, version: string): Promise<PluginVersionRecord | null>
  listVersions(pluginId: string): Promise<readonly PluginVersionRecord[]>
  putGrant(
    input: PutPluginGrantInput,
    expectedRevision: number | null,
  ): Promise<PluginGrantRecord>
  getGrant(key: PluginGrantKey): Promise<PluginGrantRecord | null>
  listGrants(pluginId?: string): Promise<readonly PluginGrantRecord[]>
  recordMigration(input: RecordPluginMigrationInput): Promise<PluginMigrationReceipt>
  listMigrations(identity: PluginVersionIdentity): Promise<readonly PluginMigrationReceipt[]>
}

export class PluginVersionConflictError extends Error {
  override readonly name = 'PluginVersionConflictError'
  constructor() {
    super('The plugin version identity is already bound to different content.')
  }
}

export class PluginVersionNotFoundError extends Error {
  override readonly name = 'PluginVersionNotFoundError'
  constructor() {
    super('The plugin version was not found.')
  }
}

export class PluginGrantConflictError extends Error {
  override readonly name = 'PluginGrantConflictError'
  constructor() {
    super('The plugin grant revision no longer matches.')
  }
}

export class PluginMigrationConflictError extends Error {
  override readonly name = 'PluginMigrationConflictError'
  constructor() {
    super('The plugin migration identity is already bound to different content.')
  }
}

const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/
const SHA256 = /^sha256:[0-9a-f]{64}$/
const MIGRATION_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/

function invalid(message: string): never {
  throw new TypeError(message)
}

export function normalizePluginId(value: string): string {
  if (typeof value !== 'string' || !PLUGIN_ID.test(value)) {
    return invalid('Plugin id is invalid.')
  }
  return value
}

export function normalizePluginVersion(value: string): string {
  if (typeof value !== 'string' || value.length > 128 || !STRICT_SEMVER.test(value)) {
    return invalid('Plugin version is invalid.')
  }
  return value
}

export function normalizePluginDigest(value: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    return invalid('Plugin digest is invalid.')
  }
  return value
}

export function normalizePluginPackageKey(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 1_024 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    return invalid('Plugin package key is invalid.')
  }
  return value
}

export function normalizePluginGrantKey(input: PluginGrantKey): PluginGrantKey {
  const pluginId = normalizePluginId(input.pluginId)
  const scopeKind = PluginGrantScopeKindSchema.parse(input.scopeKind)
  if (scopeKind === 'global') {
    if (input.scopeId !== null) return invalid('Global plugin scope id must be null.')
    return { pluginId, scopeKind, scopeId: null }
  }
  if (
    typeof input.scopeId !== 'string' ||
    input.scopeId.trim() !== input.scopeId ||
    input.scopeId.length < 1 ||
    input.scopeId.length > 256 ||
    input.scopeId.includes('\0')
  ) {
    return invalid('Plugin scope id is invalid.')
  }
  return { pluginId, scopeKind, scopeId: input.scopeId }
}

export function normalizeRegisterPluginVersionInput(
  input: RegisterPluginVersionInput,
): RegisterPluginVersionInput & { readonly manifestJson: string } {
  const manifestJson = canonicalPluginJson(input.manifest)
  if (manifestJson.length > 1_048_576) return invalid('Plugin manifest is too large.')
  const manifestSha256 = normalizePluginDigest(input.manifestSha256)
  if (sha256(manifestJson) !== manifestSha256) {
    return invalid('Plugin manifest digest does not match.')
  }
  return {
    pluginId: normalizePluginId(input.pluginId),
    version: normalizePluginVersion(input.version),
    manifest: JSON.parse(manifestJson) as Readonly<Record<string, unknown>>,
    manifestJson,
    manifestSha256,
    packageSha256: normalizePluginDigest(input.packageSha256),
    packageKey: normalizePluginPackageKey(input.packageKey),
    sourceKind: PluginSourceKindSchema.parse(input.sourceKind),
    trustKind: PluginTrustKindSchema.parse(input.trustKind),
  }
}

export function normalizePutPluginGrantInput(input: PutPluginGrantInput): PutPluginGrantInput {
  const key = normalizePluginGrantKey(input)
  const decision = PluginGrantDecisionSchema.parse(input.decision)
  if (decision === 'allow' && input.version === null) {
    return invalid('Allowed plugin grant requires a version.')
  }
  if (decision === 'deny' && input.version !== null) {
    return invalid('Denied plugin grant cannot select a version.')
  }
  return {
    ...key,
    decision,
    version: input.version === null ? null : normalizePluginVersion(input.version),
  }
}

export function normalizePluginMigrationInput(
  input: RecordPluginMigrationInput,
): RecordPluginMigrationInput {
  if (typeof input.migrationId !== 'string' || !MIGRATION_ID.test(input.migrationId)) {
    return invalid('Plugin migration id is invalid.')
  }
  return {
    pluginId: normalizePluginId(input.pluginId),
    version: normalizePluginVersion(input.version),
    migrationId: input.migrationId,
    migrationSha256: normalizePluginDigest(input.migrationSha256),
  }
}

export function validatePluginExpectedRevision(value: number | null): number | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || value < 1) {
    return invalid('Plugin grant revision is invalid.')
  }
  return value
}

export function canonicalPluginJson(value: unknown): string {
  const seen = new Set<object>()
  const visit = (item: unknown): string => {
    if (item === null) return 'null'
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) return invalid('Plugin manifest contains an invalid number.')
      return JSON.stringify(Object.is(item, -0) ? 0 : item)
    }
    if (Array.isArray(item)) {
      if (seen.has(item)) return invalid('Plugin manifest contains a cycle.')
      seen.add(item)
      const result = `[${item.map(visit).join(',')}]`
      seen.delete(item)
      return result
    }
    if (typeof item === 'object') {
      const prototype = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) {
        return invalid('Plugin manifest must contain only plain JSON values.')
      }
      if (seen.has(item)) return invalid('Plugin manifest contains a cycle.')
      seen.add(item)
      const record = item as Record<string, unknown>
      const properties = Object.keys(record).sort().map((key) => {
        const child = record[key]
        if (child === undefined) return invalid('Plugin manifest contains undefined.')
        return `${JSON.stringify(key)}:${visit(child)}`
      })
      seen.delete(item)
      return `{${properties.join(',')}}`
    }
    return invalid('Plugin manifest contains a non-JSON value.')
  }
  const result = visit(value)
  if (!result.startsWith('{')) return invalid('Plugin manifest must be an object.')
  return result
}

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export function parseStoredPluginManifest(value: string, expectedDigest: string) {
  if (sha256(value) !== expectedDigest) throw new PluginVersionConflictError()
  const parsed = JSON.parse(value) as unknown
  if (canonicalPluginJson(parsed) !== value) throw new PluginVersionConflictError()
  return parsed as Readonly<Record<string, unknown>>
}

export function comparePluginVersionsDescending(left: string, right: string): number {
  const parse = (value: string) => {
    const match = STRICT_SEMVER.exec(value)
    if (match === null) return invalid('Stored plugin version is invalid.')
    return {
      major: BigInt(match[1]!),
      minor: BigInt(match[2]!),
      patch: BigInt(match[3]!),
      prerelease: match[4]?.split('.') ?? [],
    }
  }
  const a = parse(left)
  const b = parse(right)
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? -1 : 1
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length
      ? left.localeCompare(right)
      : a.prerelease.length === 0 ? -1 : 1
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const av = a.prerelease[index]
    const bv = b.prerelease[index]
    if (av === undefined || bv === undefined) return av === undefined ? 1 : -1
    if (av === bv) continue
    const an = /^\d+$/.test(av)
    const bn = /^\d+$/.test(bv)
    if (an && bn) return BigInt(av) > BigInt(bv) ? -1 : 1
    if (an !== bn) return an ? 1 : -1
    return av > bv ? -1 : 1
  }
  return left.localeCompare(right)
}
