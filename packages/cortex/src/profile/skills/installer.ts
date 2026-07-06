/**
 * Skill Installer
 *
 * Orchestrates the full install pipeline:
 *   resolve → fetch (or use pasted content) → validate → write (atomic)
 *   → reload → on reload failure: rollback the file.
 *
 * Removal is symmetrical: lstat (reject symlinks) → unlink → reload.
 *
 * Filesystem layout for an installed skill:
 *   <profileBasePath>/skills/<slug>.md
 *
 * The on-disk content carries the original frontmatter, an optional
 * `<!-- cortex:source ... -->` comment line under the closing `---` (only
 * when the source is a URL, never for pasted content), and the body.
 */

import { mkdir, rename, rm, unlink, writeFile, lstat, access } from 'fs/promises'
import { join, resolve as resolvePath } from 'path'
import {
  resolveSkillUrl,
  SkillUrlError,
  type ResolvedSkillUrl,
} from './url-resolver.js'
import {
  fetchSkill,
  SkillFetchError,
  type FetchSkillOptions,
} from './fetcher.js'
import {
  validateSkillContent,
  SkillValidationError,
  type ValidatedSkill,
} from './validator.js'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SkillInstallErrorCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_SCHEME'
  | 'PRIVATE_HOST'
  | 'UNSUPPORTED_HOST'
  | 'FETCH_FAILED'
  | 'WRONG_CONTENT_TYPE'
  | 'TOO_LARGE'
  | 'GIST_FILE_NOT_FOUND'
  | 'TOO_MANY_REDIRECTS'
  | 'TREE_TOO_LARGE'
  | 'MALFORMED_FRONTMATTER'
  | 'INVALID_YAML'
  | 'MISSING_OR_INVALID_NAME'
  | 'MISSING_OR_INVALID_DESCRIPTION'
  | 'UNSAFE_NAME'
  | 'EMPTY_BODY'
  | 'SKILL_EXISTS'
  | 'INVALID_SLUG'
  | 'NOT_FOUND'
  | 'WRITE_FAILED'
  | 'DELETE_FAILED'
  | 'RELOAD_FAILED'

export class SkillInstallError extends Error {
  readonly code: SkillInstallErrorCode
  /** Optional structured payload — used e.g. to surface existing slug on collision. */
  readonly details?: Record<string, unknown>
  constructor(
    code: SkillInstallErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.code = code
    this.name = 'SkillInstallError'
    if (details !== undefined) this.details = details
  }
}

// ---------------------------------------------------------------------------
// Public API — install
// ---------------------------------------------------------------------------

/** Minimal registry surface the installer depends on. Inject for tests. */
export interface SkillRegistry {
  reload(profileId: string): Promise<unknown>
}

export type InstallSkillSource =
  | { kind: 'url'; url: string }
  | { kind: 'content'; content: string; sourceUrl?: string | null }
  | {
      kind: 'github-folder'
      owner: string
      repo: string
      ref: string
      /** Repo-relative path of the SKILL.md (e.g. `finance/x/SKILL.md`). */
      path: string
    }

export interface InstallSkillRequest {
  readonly profileId: string
  readonly profileBasePath: string
  readonly source: InstallSkillSource
  readonly registry: SkillRegistry
  /** Override fetcher behaviour (timeouts, mock fetch). */
  readonly fetchOptions?: FetchSkillOptions
}

export interface InstalledSkill {
  readonly slug: string
  readonly name: string
  readonly description: string
  readonly trigger: string
  /** The source URL recorded in the file, if any. Null when pasted. */
  readonly source: string | null
  /** Absolute path the file was written to. */
  readonly path: string
}

const SLUG_RE = /^[a-zA-Z0-9_-]+$/

export async function installSkill(req: InstallSkillRequest): Promise<InstalledSkill> {
  // 1. Get raw content + optional source URL.
  const { content: rawContent, sourceUrl } = await loadSource(
    req.source,
    req.fetchOptions,
  )

  // 2. Validate.
  const validated = validate(rawContent)

  // 3. Build target path; check collision.
  //    Layout: skills/<slug>/SKILL.md
  const skillsDir = join(req.profileBasePath, 'skills')
  const slugDir = join(skillsDir, validated.slug)
  const targetPath = join(slugDir, 'SKILL.md')
  if (await pathExists(slugDir)) {
    throw new SkillInstallError(
      'SKILL_EXISTS',
      `A skill named "${validated.slug}" already exists in this profile.`,
      { existingSlug: validated.slug },
    )
  }

  // 4. Build the on-disk content (preserve frontmatter + optional source comment + body).
  const onDisk = buildOnDiskContent(validated, sourceUrl)

  // 5. Write atomically: mkdir slug folder, write temp, rename.
  const tempPath = join(slugDir, '.SKILL.md.tmp')
  try {
    await mkdir(slugDir, { recursive: true })
    await writeFile(tempPath, onDisk, { mode: 0o600 })
    await rename(tempPath, targetPath)
  } catch (err) {
    // Best-effort rollback: nuke the slug folder we created.
    await safeRm(slugDir)
    throw new SkillInstallError(
      'WRITE_FAILED',
      err instanceof Error ? err.message : 'Failed to write skill file.',
    )
  }

  // 6. Reload. Rollback the entire slug folder on failure.
  try {
    await req.registry.reload(req.profileId)
  } catch (err) {
    await safeRm(slugDir)
    throw new SkillInstallError(
      'RELOAD_FAILED',
      `Skill saved but profile reload failed; rolled back. ${err instanceof Error ? err.message : ''}`.trim(),
    )
  }

  return {
    slug: validated.slug,
    name: validated.name,
    description: validated.description,
    trigger: validated.trigger,
    source: sourceUrl,
    path: targetPath,
  }
}

// ---------------------------------------------------------------------------
// Public API — remove
// ---------------------------------------------------------------------------

export interface RemoveSkillRequest {
  readonly profileId: string
  readonly profileBasePath: string
  readonly slug: string
  readonly registry: SkillRegistry
}

export async function removeSkill(req: RemoveSkillRequest): Promise<void> {
  if (!SLUG_RE.test(req.slug)) {
    throw new SkillInstallError('INVALID_SLUG', 'Slug contains unsupported characters.')
  }

  const skillsDir = join(req.profileBasePath, 'skills')
  const slugDir = join(skillsDir, req.slug)

  // Layout: skills/<slug>/SKILL.md. The slug folder is what we own and
  // remove. For back-compat with the v0 flat layout, also support removing
  // a top-level skills/<slug>.md file.
  const flatPath = join(skillsDir, `${req.slug}.md`)

  let target: string | null = null
  let isDir = false
  try {
    const dirStat = await lstat(slugDir)
    if (dirStat.isSymbolicLink()) {
      throw new SkillInstallError(
        'INVALID_SLUG',
        'Refusing to remove a symbolic link masquerading as a skill.',
      )
    }
    if (dirStat.isDirectory()) {
      target = slugDir
      isDir = true
    }
  } catch (err) {
    if (err instanceof SkillInstallError) throw err
    // not present as a folder — fall through to legacy flat check
  }

  if (!target) {
    try {
      const fileStat = await lstat(flatPath)
      if (fileStat.isSymbolicLink()) {
        throw new SkillInstallError(
          'INVALID_SLUG',
          'Refusing to remove a symbolic link masquerading as a skill.',
        )
      }
      target = flatPath
    } catch (err) {
      if (err instanceof SkillInstallError) throw err
      throw new SkillInstallError('NOT_FOUND', `Skill "${req.slug}" not found.`)
    }
  }

  // Path-escape guard: target must resolve inside skills/.
  const resolvedDir = resolvePath(skillsDir)
  const resolvedTarget = resolvePath(target)
  if (
    !resolvedTarget.startsWith(resolvedDir + '/') &&
    resolvedTarget !== resolvedDir
  ) {
    throw new SkillInstallError(
      'INVALID_SLUG',
      'Skill path resolved outside the profile skills directory.',
    )
  }

  try {
    if (isDir) {
      await rm(target, { recursive: true, force: true })
    } else {
      await unlink(target)
    }
  } catch (err) {
    throw new SkillInstallError(
      'DELETE_FAILED',
      err instanceof Error ? err.message : 'Failed to delete skill.',
    )
  }

  try {
    await req.registry.reload(req.profileId)
  } catch (err) {
    throw new SkillInstallError(
      'RELOAD_FAILED',
      `Skill removed but profile reload failed. ${err instanceof Error ? err.message : ''}`.trim(),
    )
  }
}

// ---------------------------------------------------------------------------
// Pipeline pieces
// ---------------------------------------------------------------------------

async function loadSource(
  source: InstallSkillSource,
  fetchOptions: FetchSkillOptions | undefined,
): Promise<{ content: string; sourceUrl: string | null }> {
  if (source.kind === 'content') {
    return { content: source.content, sourceUrl: source.sourceUrl ?? null }
  }

  if (source.kind === 'github-folder') {
    // Build the raw URL directly; reuse fetchSkill via a synthesized
    // ResolvedSkillUrl so size/timeout/content-type checks still apply.
    const raw = `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.ref}/${source.path}`
    let resolved: ResolvedSkillUrl
    try {
      resolved = resolveSkillUrl(raw)
    } catch (err) {
      if (err instanceof SkillUrlError) {
        throw new SkillInstallError(err.code, err.message)
      }
      throw err
    }
    try {
      const fetched = await fetchSkill(resolved, fetchOptions ?? {})
      return { content: fetched.content, sourceUrl: raw }
    } catch (err) {
      if (err instanceof SkillFetchError) {
        throw new SkillInstallError(err.code, err.message)
      }
      throw err
    }
  }

  // source.kind === 'url'
  let resolved: ResolvedSkillUrl
  try {
    resolved = resolveSkillUrl(source.url)
  } catch (err) {
    if (err instanceof SkillUrlError) {
      throw new SkillInstallError(err.code, err.message)
    }
    throw err
  }

  // List-mode URLs aren't valid for single-skill install.
  if (resolved.origin === 'github-repo' || resolved.origin === 'github-tree') {
    throw new SkillInstallError(
      'UNSUPPORTED_HOST',
      'This URL points at a repo or folder. Use the browse flow to pick which skills to install.',
    )
  }

  try {
    const fetched = await fetchSkill(resolved, fetchOptions ?? {})
    return { content: fetched.content, sourceUrl: source.url }
  } catch (err) {
    if (err instanceof SkillFetchError) {
      throw new SkillInstallError(err.code, err.message)
    }
    throw err
  }
}

function validate(content: string): ValidatedSkill {
  try {
    return validateSkillContent(content)
  } catch (err) {
    if (err instanceof SkillValidationError) {
      throw new SkillInstallError(err.code, err.message)
    }
    throw err
  }
}

/** Reconstruct the on-disk content from the validated skill + optional source URL. */
function buildOnDiskContent(validated: ValidatedSkill, sourceUrl: string | null): string {
  // Re-emit the original frontmatter rather than reconstructing from parsed
  // fields, because we want to preserve unknown extensions (allowed-tools,
  // tags, version, etc.) byte-for-byte.
  const today = new Date().toISOString().slice(0, 10)
  const sourceComment = sourceUrl
    ? `<!-- cortex:source ${sanitiseCommentValue(sourceUrl)} installed=${today} -->\n\n`
    : ''

  // Re-serialise the frontmatter via the structure we have.
  const frontmatterLines: string[] = []
  for (const [key, value] of Object.entries(validated.frontmatter)) {
    frontmatterLines.push(`${key}: ${stringifyYamlValue(value)}`)
  }

  return `---\n${frontmatterLines.join('\n')}\n---\n${sourceComment}${validated.body}\n`
}

// Strings that YAML 1.1 would parse as something other than a string when
// unquoted. We force-quote these on re-emit so a string value round-trips
// as a string (e.g. version: "1.2", name: "yes", token: "true").
const AMBIGUOUS_STRING = /^(-?\d+(\.\d+)?|true|false|null|yes|no|on|off|~|0x[0-9a-f]+|0o[0-7]+)$/i
const NEEDS_QUOTING = /[:#&*!|>'"%@`,[\]{}\n\r\t]/

function stringifyYamlValue(value: unknown): string {
  if (typeof value === 'string') {
    if (value.length === 0) return '""'
    if (NEEDS_QUOTING.test(value) || AMBIGUOUS_STRING.test(value)) {
      return JSON.stringify(value)
    }
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    return `[${value.map(stringifyYamlValue).join(', ')}]`
  }
  // For objects / unknown, fall back to JSON — preserves shape without
  // requiring a full YAML emitter.
  return JSON.stringify(value)
}

/** HTML comments cannot contain `--`; collapse it defensively. */
function sanitiseCommentValue(s: string): string {
  return s.replace(/--+/g, '-').replace(/[<>\n\r]/g, '')
}

// ---------------------------------------------------------------------------
// fs helpers
// ---------------------------------------------------------------------------

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function safeRm(p: string): Promise<void> {
  try {
    await rm(p, { recursive: true, force: true })
  } catch {
    // ignore — best-effort cleanup
  }
}
