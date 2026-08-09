import { createHash, randomUUID } from 'node:crypto'
import { crc32, inflateSync } from 'node:zlib'
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
const MAX_ICON_BYTES = 32 * 1024
const MAX_COMPOSER_ICON_BYTES = 256 * 1024
const MAX_SCRIPT_BYTES = 256 * 1024
const MAX_SCHEMA_BYTES = 128 * 1024
const MAX_TASK_RESOURCE_BYTES = 8 * 1024 * 1024

const SVG_ATTRIBUTES = {
  svg: new Set(['xmlns', 'viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'opacity']),
  g: new Set(['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'opacity']),
  path: new Set(['d', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'opacity']),
  rect: new Set(['x', 'y', 'width', 'height', 'rx', 'ry', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'opacity']),
  circle: new Set(['cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width', 'opacity']),
  ellipse: new Set(['cx', 'cy', 'rx', 'ry', 'fill', 'stroke', 'stroke-width', 'opacity']),
  line: new Set(['x1', 'y1', 'x2', 'y2', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'opacity']),
  polyline: new Set(['points', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'opacity']),
  polygon: new Set(['points', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'opacity']),
} as const

type PassiveSvgElement = keyof typeof SVG_ATTRIBUTES

interface InspectedFile {
  readonly path: string
  readonly bytes: Buffer
}

interface InspectedPackage {
  readonly files: readonly InspectedFile[]
  readonly manifest: PluginManifest
  readonly packageSha256: string
}

export interface PluginPackageDisplay {
  readonly category: string
  readonly accent: 'blue' | 'red' | 'green' | 'amber' | 'violet' | 'slate'
  readonly iconSvg: string
  readonly composerIconDataUrl: string | null
}

type PluginTask = PluginManifest['tasks'][number]

type PluginTaskResource = {
  readonly kind: 'script' | 'template' | 'schema' | 'asset'
  readonly path: string
  readonly description: string
}

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

function taskResources(task: PluginTask): readonly PluginTaskResource[] {
  return 'resources' in task ? task.resources : []
}

function inspectTaskResources(
  task: PluginTask,
  files: readonly InspectedFile[],
): readonly PluginTaskResource[] {
  const resources = taskResources(task)
  for (const resource of resources) {
    const file = files.find(candidate => candidate.path === resource.path)
    if (file === undefined) throw new PluginPackageIntegrityError('corrupt')
    const limit = resource.kind === 'script'
      ? MAX_SCRIPT_BYTES
      : resource.kind === 'schema'
        ? MAX_SCHEMA_BYTES
        : MAX_TASK_RESOURCE_BYTES
    if (file.bytes.byteLength > limit) throw new PluginPackageIntegrityError('limit_exceeded')
    if (resource.kind === 'script') decodeUtf8(file.bytes)
    if (resource.kind === 'schema') {
      try {
        JSON.parse(decodeUtf8(file.bytes))
      } catch (error) {
        if (error instanceof PluginPackageIntegrityError) throw error
        throw new PluginPackageIntegrityError('corrupt')
      }
    }
  }
  return resources
}

function loadTaskSkill(
  task: PluginTask,
  files: readonly InspectedFile[],
  resourceRoot?: string,
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
  const resources = inspectTaskResources(task, files)
  const sections = [loaded.content.trim()]
  if (references.length > 0) {
    sections.push(`## Bundled references\n\n${references.join('\n\n')}`)
  }
  if (resources.length > 0 && resourceRoot !== undefined) {
    const lines = resources.map(resource => {
      const absolute = join(resourceRoot, ...resource.path.split('/'))
      return `- ${resource.kind}: ${JSON.stringify(absolute)} — ${resource.description}`
    })
    sections.push([
      '## Verified package resources',
      '',
      'These immutable files were verified with this task pack. Read or execute only the files needed for the request; never edit them in place.',
      '',
      ...lines,
    ].join('\n'))
  }
  const content = sections.join('\n\n')
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_INVOKED_BYTES) {
    throw new PluginPackageIntegrityError('limit_exceeded')
  }
  return sections.length === 1 ? loaded : { ...loaded, content }
}

function validSvgAttribute(name: string, value: string): boolean {
  if (name === 'xmlns') return value === 'http://www.w3.org/2000/svg'
  if (name === 'viewBox') return value === '0 0 24 24'
  if (name === 'd') return value.length > 0 && /^[MmLlHhVvCcSsQqTtAaZz0-9+.,\-\s]+$/.test(value)
  if (name === 'points') return value.length > 0 && /^[0-9+.,\-\s]+$/.test(value)
  if (name === 'fill' || name === 'stroke') {
    return value === 'none' || value === 'currentColor' || /^#[0-9a-fA-F]{3,8}$/.test(value)
  }
  if (name === 'stroke-linecap') return ['butt', 'round', 'square'].includes(value)
  if (name === 'stroke-linejoin') return ['arcs', 'bevel', 'miter', 'miter-clip', 'round'].includes(value)
  return /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)
}

/** Parse the deliberately tiny, geometry-only SVG subset accepted for catalog icons. */
function isPassiveIconSvg(svg: string): boolean {
  if (/[&\u0000]|[^\x09\x0a\x0d\x20-\x7e]/.test(svg)) return false
  const tags = /<[^>]*>/g
  const stack: PassiveSvgElement[] = []
  let cursor = 0
  let sawRoot = false
  let closedRoot = false
  let match: RegExpExecArray | null
  while ((match = tags.exec(svg)) !== null) {
    if (svg.slice(cursor, match.index).trim() !== '' || closedRoot) return false
    cursor = tags.lastIndex
    const token = match[0]
    const closing = /^<\/([a-z][a-z0-9]*)\s*>$/.exec(token)
    if (closing !== null) {
      const element = closing[1] as PassiveSvgElement
      if (stack.pop() !== element) return false
      if (element === 'svg') closedRoot = true
      continue
    }

    const opening = /^<([a-z][a-z0-9]*)([\s\S]*?)(\/?)>$/.exec(token)
    if (opening === null) return false
    const element = opening[1] as PassiveSvgElement
    if (!(element in SVG_ATTRIBUTES)) return false
    if (!sawRoot) {
      if (element !== 'svg') return false
      sawRoot = true
    } else if (stack.length === 0 || element === 'svg') {
      return false
    }

    const attributes = opening[2] ?? ''
    const allowed = SVG_ATTRIBUTES[element] as ReadonlySet<string>
    const seen = new Set<string>()
    const attributePattern = /([a-z][a-zA-Z0-9-]*)\s*=\s*(["'])([^"'<>]*)\2/g
    let attributeCursor = 0
    let attribute: RegExpExecArray | null
    while ((attribute = attributePattern.exec(attributes)) !== null) {
      if (attributes.slice(attributeCursor, attribute.index).trim() !== '') return false
      attributeCursor = attributePattern.lastIndex
      const name = attribute[1]!
      const value = attribute[3]!
      if (seen.has(name) || !allowed.has(name) || !validSvgAttribute(name, value)) return false
      seen.add(name)
    }
    if (attributes.slice(attributeCursor).trim() !== '') return false
    if (element === 'svg' && !seen.has('viewBox')) return false

    if (opening[3] === '/') {
      if (element === 'svg') closedRoot = true
    } else {
      stack.push(element)
    }
  }
  return sawRoot && closedRoot && stack.length === 0 && svg.slice(cursor).trim() === ''
}

function isCanonicalComposerPng(png: Buffer): boolean {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (png.byteLength < 57 || !png.subarray(0, 8).equals(signature)) return false
  let cursor = 8
  let sawHeader = false
  let sawData = false
  let sawEnd = false
  let sawPhysicalDimensions = false
  const compressed: Buffer[] = []
  while (cursor < png.byteLength) {
    if (png.byteLength - cursor < 12) return false
    const length = png.readUInt32BE(cursor)
    const end = cursor + 12 + length
    if (end > png.byteLength) return false
    const type = png.subarray(cursor + 4, cursor + 8).toString('ascii')
    const data = png.subarray(cursor + 8, cursor + 8 + length)
    const expectedCrc = png.readUInt32BE(cursor + 8 + length)
    if (crc32(png.subarray(cursor + 4, cursor + 8 + length)) !== expectedCrc) return false
    if (type === 'IHDR') {
      if (sawHeader || cursor !== 8 || length !== 13) return false
      sawHeader = true
    } else if (type === 'IDAT') {
      if (!sawHeader || sawEnd || length === 0) return false
      sawData = true
      compressed.push(data)
    } else if (type === 'pHYs') {
      if (!sawHeader || sawData || sawEnd || sawPhysicalDimensions || length !== 9) return false
      if (data[8] !== 0 && data[8] !== 1) return false
      sawPhysicalDimensions = true
    } else if (type === 'IEND') {
      if (!sawData || sawEnd || length !== 0 || end !== png.byteLength) return false
      sawEnd = true
    } else {
      return false
    }
    cursor = end
  }
  if (!sawHeader || !sawData || !sawEnd) return false
  try {
    const colorType = png[25]
    const rowBytes = colorType === 6 ? 256 * 4 : 256 * 3
    const pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: 256 * (rowBytes + 1) })
    if (pixels.byteLength !== 256 * (rowBytes + 1)) return false
    for (let offset = 0; offset < pixels.byteLength; offset += rowBytes + 1) {
      if (pixels[offset]! > 4) return false
    }
    return true
  } catch {
    return false
  }
}

function loadDisplay(
  manifest: PluginManifest,
  files: readonly InspectedFile[],
): PluginPackageDisplay | null {
  if (manifest.schemaVersion !== 2 && manifest.schemaVersion !== 3) return null
  if (!manifest.display.icon.endsWith('.svg')) throw new PluginPackageIntegrityError('corrupt')
  const icon = files.find(file => file.path === manifest.display.icon)
  if (icon === undefined) throw new PluginPackageIntegrityError('corrupt')
  if (icon.bytes.byteLength > MAX_ICON_BYTES) {
    throw new PluginPackageIntegrityError('limit_exceeded')
  }
  const svg = decodeUtf8(icon.bytes)
  if (!isPassiveIconSvg(svg)) throw new PluginPackageIntegrityError('corrupt')
  let composerIconDataUrl: string | null = null
  if (manifest.schemaVersion === 3) {
    if (!manifest.display.composerIcon.endsWith('.png')) {
      throw new PluginPackageIntegrityError('corrupt')
    }
    const composerIcon = files.find(file => file.path === manifest.display.composerIcon)
    if (composerIcon === undefined) throw new PluginPackageIntegrityError('corrupt')
    if (composerIcon.bytes.byteLength > MAX_COMPOSER_ICON_BYTES) {
      throw new PluginPackageIntegrityError('limit_exceeded')
    }
    const png = composerIcon.bytes
    if (
      !isCanonicalComposerPng(png) ||
      png.readUInt32BE(8) !== 13 ||
      png.subarray(12, 16).toString('ascii') !== 'IHDR' ||
      png.readUInt32BE(16) !== 256 ||
      png.readUInt32BE(20) !== 256 ||
      png[24] !== 8 ||
      (png[25] !== 2 && png[25] !== 6) ||
      png[26] !== 0 ||
      png[27] !== 0 ||
      png[28] !== 0
    ) {
      throw new PluginPackageIntegrityError('corrupt')
    }
    composerIconDataUrl = `data:image/png;base64,${png.toString('base64')}`
  }
  return {
    category: manifest.display.category,
    accent: manifest.display.accent,
    iconSvg: svg,
    composerIconDataUrl,
  }
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
  loadDisplay(manifest, files)
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
    const directory = this.resolvePackageKey(record.packageKey)
    const skills: SkillDefinition[] = []
    for (const task of manifest.tasks) {
      skills.push(loadTaskSkill(task, inspected.files, directory))
    }
    return skills
  }

  async loadDisplay(record: PluginVersionRecord): Promise<PluginPackageDisplay | null> {
    const inspected = await this.verifyInspection(record)
    return loadDisplay(inspected.manifest, inspected.files)
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
