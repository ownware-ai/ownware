import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { SkillDefinition } from '@ownware/loom'
import { parseSkillFile } from '@ownware/loom'
import type {
  PluginRepository,
  PluginSourceKind,
  PluginTrustKind,
  PluginVersionRecord,
} from '../storage/plugin-repository.js'
import {
  canonicalPluginJson,
  sha256,
} from '../storage/plugin-repository.js'
import {
  parsePluginManifestJson,
  type PluginManifest,
} from './manifest.js'

const MANIFEST_FILE = 'ownware-plugin.json'
const MAX_FILES = 2_000
const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024
const MAX_SKILL_FILE_BYTES = 128 * 1024
const MAX_SKILL_DESCRIPTION_BYTES = 1_024
const MAX_SKILL_TRIGGER_BYTES = 512
const MAX_SKILL_INVOKED_BYTES = 128 * 1024
const MAX_SKILL_TOOL_RULES = 128

interface InspectedFile {
  readonly path: string
  readonly bytes: Buffer
}

interface InspectedPackage {
  readonly files: readonly InspectedFile[]
  readonly manifest: PluginManifest
  readonly packageSha256: string
}

type PluginTask = PluginManifest['tasks'][number]

async function statIfExists(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new PluginPackageIntegrityError('corrupt')
  }
}

function samePackageIdentity(left: InspectedPackage, right: InspectedPackage): boolean {
  return left.packageSha256 === right.packageSha256 &&
    left.manifest.id === right.manifest.id &&
    left.manifest.version === right.manifest.version
}

export interface InstalledPluginPackage {
  readonly manifest: PluginManifest
  readonly version: PluginVersionRecord
  readonly directory: string
}

export class PluginPackageIntegrityError extends Error {
  override readonly name = 'PluginPackageIntegrityError'
  constructor(readonly code: 'unsupported_entry' | 'limit_exceeded' | 'identity_conflict' | 'corrupt') {
    super(`Plugin package failed integrity validation (${code}).`)
  }
}

function contained(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep))
}

function packageDigest(files: readonly InspectedFile[]): string {
  const hash = createHash('sha256')
  hash.update('ownware-plugin-package-v1\0')
  for (const file of files) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(String(file.bytes.byteLength))
    hash.update('\0')
    hash.update(file.bytes)
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

function loadTaskSkill(
  task: PluginTask,
  files: readonly InspectedFile[],
): SkillDefinition {
  const skillFile = files.find(file => file.path === `${task.skill}/SKILL.md`)
  if (skillFile === undefined) throw new PluginPackageIntegrityError('corrupt')
  if (skillFile.bytes.byteLength > MAX_SKILL_FILE_BYTES) {
    throw new PluginPackageIntegrityError('limit_exceeded')
  }
  let loaded: SkillDefinition | null
  try {
    loaded = parseSkillFile(decodeUtf8(skillFile.bytes))
  } catch (error) {
    if (error instanceof PluginPackageIntegrityError) throw error
    throw new PluginPackageIntegrityError('corrupt')
  }
  if (loaded === null || loaded.name !== task.id) {
    throw new PluginPackageIntegrityError('corrupt')
  }
  const trigger = loaded.trigger instanceof RegExp ? loaded.trigger.source : loaded.trigger
  if (
    Buffer.byteLength(loaded.description, 'utf8') > MAX_SKILL_DESCRIPTION_BYTES ||
    Buffer.byteLength(trigger, 'utf8') > MAX_SKILL_TRIGGER_BYTES ||
    (loaded.allowedTools?.length ?? 0) > MAX_SKILL_TOOL_RULES
  ) {
    throw new PluginPackageIntegrityError('limit_exceeded')
  }
  const references = task.references.map((path) => {
    const file = files.find(candidate => candidate.path === path)
    if (file === undefined) throw new PluginPackageIntegrityError('corrupt')
    const content = decodeUtf8(file.bytes)
    return `### ${path}\n\n${content.trim()}`
  })
  const content = references.length === 0
    ? loaded.content
    : `${loaded.content.trim()}\n\n## Bundled references\n\n${references.join('\n\n')}`
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_INVOKED_BYTES) {
    throw new PluginPackageIntegrityError('limit_exceeded')
  }
  return references.length === 0 ? loaded : { ...loaded, content }
}

async function inspectPackage(directory: string): Promise<InspectedPackage> {
  const root = await realpath(directory)
  const rootStat = await stat(root)
  if (!rootStat.isDirectory()) throw new PluginPackageIntegrityError('unsupported_entry')
  const files: InspectedFile[] = []
  let totalBytes = 0

  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolute = join(current, entry.name)
      const fileStat = await lstat(absolute)
      if (fileStat.isSymbolicLink()) throw new PluginPackageIntegrityError('unsupported_entry')
      if (fileStat.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!fileStat.isFile()) throw new PluginPackageIntegrityError('unsupported_entry')
      if (fileStat.size > MAX_FILE_BYTES || files.length >= MAX_FILES) {
        throw new PluginPackageIntegrityError('limit_exceeded')
      }
      totalBytes += fileStat.size
      if (totalBytes > MAX_PACKAGE_BYTES) throw new PluginPackageIntegrityError('limit_exceeded')
      const path = relative(root, absolute).split(sep).join('/')
      files.push({ path, bytes: await readFile(absolute) })
    }
  }
  await walk(root)
  files.sort((left, right) => left.path.localeCompare(right.path))
  const manifestFile = files.find(file => file.path === MANIFEST_FILE)
  if (manifestFile === undefined) throw new PluginPackageIntegrityError('corrupt')
  let manifest: PluginManifest
  try {
    manifest = parsePluginManifestJson(decodeUtf8(manifestFile.bytes))
  } catch (error) {
    if (error instanceof PluginPackageIntegrityError) throw error
    throw new PluginPackageIntegrityError('corrupt')
  }
  for (const task of manifest.tasks) {
    loadTaskSkill(task, files)
  }
  for (const migration of manifest.migrations) {
    const file = files.find(candidate => candidate.path === migration.path)
    if (file === undefined || sha256(file.bytes) !== migration.sha256) {
      throw new PluginPackageIntegrityError('corrupt')
    }
  }
  return { files, manifest, packageSha256: packageDigest(files) }
}

async function materialize(directory: string, files: readonly InspectedFile[]): Promise<void> {
  await mkdir(directory, { recursive: false, mode: 0o700 })
  for (const file of files) {
    const target = join(directory, ...file.path.split('/'))
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, file.bytes, { flag: 'wx', mode: 0o600 })
  }
}

export class PluginPackageStore {
  private readonly root: string
  private readonly packagesRoot: string
  private readonly stagingRoot: string

  constructor(
    dataDir: string,
    private readonly repository: PluginRepository,
  ) {
    this.root = resolve(dataDir, 'plugins')
    this.packagesRoot = join(this.root, 'packages')
    this.stagingRoot = join(this.root, 'staging')
  }

  async initialize(): Promise<void> {
    await mkdir(this.packagesRoot, { recursive: true, mode: 0o700 })
    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 })
  }

  async installFromDirectory(
    sourceDirectory: string,
    sourceKind: PluginSourceKind,
    trustKind: PluginTrustKind,
  ): Promise<InstalledPluginPackage> {
    await this.initialize()
    const inspected = await inspectPackage(sourceDirectory)
    const packageKey = `packages/${inspected.manifest.id}/${inspected.manifest.version}`
    const finalDirectory = this.resolvePackageKey(packageKey)
    const stagingDirectory = join(this.stagingRoot, randomUUID())
    let staged = false
    try {
      const existing = await statIfExists(finalDirectory)
      if (existing !== null) {
        if (!existing.isDirectory()) throw new PluginPackageIntegrityError('identity_conflict')
        const installed = await inspectPackage(finalDirectory)
        if (!samePackageIdentity(installed, inspected)) {
          throw new PluginPackageIntegrityError('identity_conflict')
        }
      } else {
        await mkdir(dirname(finalDirectory), { recursive: true, mode: 0o700 })
        await materialize(stagingDirectory, inspected.files)
        staged = true
        try {
          await rename(stagingDirectory, finalDirectory)
          staged = false
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
          const concurrentlyInstalled = await inspectPackage(finalDirectory)
          if (!samePackageIdentity(concurrentlyInstalled, inspected)) {
            throw new PluginPackageIntegrityError('identity_conflict')
          }
        }
      }
      const version = await this.repository.registerVersion({
        pluginId: inspected.manifest.id,
        version: inspected.manifest.version,
        manifest: inspected.manifest,
        manifestSha256: sha256(canonicalPluginJson(inspected.manifest)),
        packageSha256: inspected.packageSha256,
        packageKey,
        sourceKind,
        trustKind,
      })
      return { manifest: inspected.manifest, version, directory: finalDirectory }
    } finally {
      if (staged) await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {})
    }
  }

  async verify(record: PluginVersionRecord): Promise<PluginManifest> {
    const inspected = await this.verifyInspection(record)
    return inspected.manifest
  }

  async loadSkills(record: PluginVersionRecord): Promise<readonly SkillDefinition[]> {
    const inspected = await this.verifyInspection(record)
    const manifest = inspected.manifest
    const skills: SkillDefinition[] = []
    for (const task of manifest.tasks) {
      skills.push(loadTaskSkill(task, inspected.files))
    }
    return skills
  }

  private async verifyInspection(record: PluginVersionRecord): Promise<InspectedPackage> {
    const inspected = await inspectPackage(this.resolvePackageKey(record.packageKey))
    if (
      inspected.packageSha256 !== record.packageSha256 ||
      inspected.manifest.id !== record.pluginId ||
      inspected.manifest.version !== record.version
    ) throw new PluginPackageIntegrityError('corrupt')
    return inspected
  }

  private resolvePackageKey(packageKey: string): string {
    const target = resolve(this.root, ...packageKey.split('/'))
    if (!contained(this.root, target) || !contained(this.packagesRoot, target)) {
      throw new PluginPackageIntegrityError('corrupt')
    }
    return target
  }
}
