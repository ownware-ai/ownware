/**
 * Toggle a skill between active and inactive without deleting it.
 *
 * Inactive = a `.disabled` marker file present in the skill folder.
 * The loader sets `SkillDefinition.active = false` when it sees the
 * marker; the assembler skips inactive skills when building the
 * "Available Skills" catalog injected into the system prompt.
 *
 * Reasoning: a non-tech user clicking the trash icon shouldn't be a
 * destructive operation. Toggle off / on is reversible; permanent
 * remove stays available as a separate action.
 *
 * Layout invariant: only the nested layout (`skills/<slug>/SKILL.md`)
 * supports activate/deactivate. Legacy flat skills can only be removed
 * — they don't have a folder to put a marker in. The handler returns a
 * `NOT_FOUND` for that case.
 */

import { lstat, unlink, writeFile } from 'fs/promises'
import { join, resolve as resolvePath } from 'path'
import { SkillInstallError, type SkillRegistry } from './installer.js'

const SLUG_RE = /^[a-zA-Z0-9_-]+$/
const MARKER_NAME = '.disabled'

export interface SetSkillActiveRequest {
  readonly profileId: string
  readonly profileBasePath: string
  readonly slug: string
  readonly active: boolean
  readonly registry: SkillRegistry
}

export async function setSkillActive(req: SetSkillActiveRequest): Promise<void> {
  if (!SLUG_RE.test(req.slug)) {
    throw new SkillInstallError('INVALID_SLUG', 'Slug contains unsupported characters.')
  }

  const skillsDir = join(req.profileBasePath, 'skills')
  const slugDir = join(skillsDir, req.slug)
  const markerPath = join(slugDir, MARKER_NAME)

  // The slug folder must exist as a real directory (not a symlink).
  let dirStat
  try {
    dirStat = await lstat(slugDir)
  } catch {
    throw new SkillInstallError('NOT_FOUND', `Skill "${req.slug}" not found.`)
  }
  if (dirStat.isSymbolicLink()) {
    throw new SkillInstallError(
      'INVALID_SLUG',
      'Refusing to toggle a symbolic link masquerading as a skill folder.',
    )
  }
  if (!dirStat.isDirectory()) {
    // Legacy flat skill (skills/<slug>.md) — no folder to put a marker
    // in. Surface as NOT_FOUND from the toggle's point of view; the
    // user should remove + re-install if they want this primitive.
    throw new SkillInstallError(
      'NOT_FOUND',
      `Skill "${req.slug}" uses the legacy flat layout and cannot be toggled. Remove and re-install.`,
    )
  }

  // Path-escape guard.
  const resolvedDir = resolvePath(skillsDir)
  const resolvedSlugDir = resolvePath(slugDir)
  if (
    !resolvedSlugDir.startsWith(resolvedDir + '/') &&
    resolvedSlugDir !== resolvedDir
  ) {
    throw new SkillInstallError(
      'INVALID_SLUG',
      'Skill path resolved outside the profile skills directory.',
    )
  }

  try {
    if (req.active) {
      // Enable: remove marker if present. Idempotent (already-enabled is a no-op).
      try {
        await unlink(markerPath)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code !== 'ENOENT') {
          throw new SkillInstallError(
            'WRITE_FAILED',
            `Failed to enable skill: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    } else {
      // Disable: write empty marker. Idempotent.
      await writeFile(markerPath, '', { mode: 0o600 })
    }
  } catch (err) {
    if (err instanceof SkillInstallError) throw err
    throw new SkillInstallError(
      'WRITE_FAILED',
      err instanceof Error ? err.message : 'Failed to toggle skill.',
    )
  }

  try {
    await req.registry.reload(req.profileId)
  } catch (err) {
    throw new SkillInstallError(
      'RELOAD_FAILED',
      `Skill toggle written but profile reload failed. ${err instanceof Error ? err.message : ''}`.trim(),
    )
  }
}
