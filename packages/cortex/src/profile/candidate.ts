import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { loadProfile } from './loader.js'
import { ORIGIN_SIDECAR_FILE } from './registry.js'
import { isInstallError } from './install/errors.js'
import { validateTree } from './install/validate-tree.js'

export interface CandidateFinding {
  readonly code: string
  readonly severity: 'error' | 'warning'
  readonly message: string
  readonly subjects?: readonly string[]
}

export interface ProfileCandidateValidation {
  readonly valid: boolean
  readonly candidateId: string | null
  readonly profileName: string | null
  readonly fileCount: number | null
  readonly totalBytes: number | null
  readonly findings: readonly CandidateFinding[]
}

export async function validateProfileCandidate(input: {
  readonly profileDir: string
  readonly allowCustomCode?: boolean
  readonly maxFiles?: number
  readonly maxBytes?: number
}): Promise<ProfileCandidateValidation> {
  let stats: { fileCount: number; totalBytes: number }
  try {
    stats = await validateTree({
      profileDir: input.profileDir,
      ...(input.allowCustomCode !== undefined ? { allowCustomCode: input.allowCustomCode } : {}),
      ...(input.maxFiles !== undefined ? { maxFiles: input.maxFiles } : {}),
      ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
    })
  } catch (err) {
    return invalidResult(toSafeTreeFinding(err))
  }

  let profileName: string
  try {
    profileName = (await loadProfile(input.profileDir)).config.name
  } catch {
    return {
      valid: false,
      candidateId: null,
      profileName: null,
      fileCount: stats.fileCount,
      totalBytes: stats.totalBytes,
      findings: [{
        code: 'profile_invalid',
        severity: 'error',
        message: 'Candidate profile configuration or file references are invalid.',
      }],
    }
  }

  try {
    const digest = await hashCandidateTree(input.profileDir)
    return {
      valid: true,
      candidateId: `sha256:${digest}`,
      profileName,
      fileCount: stats.fileCount,
      totalBytes: stats.totalBytes,
      findings: [],
    }
  } catch {
    return {
      valid: false,
      candidateId: null,
      profileName,
      fileCount: stats.fileCount,
      totalBytes: stats.totalBytes,
      findings: [{
        code: 'candidate_unreadable',
        severity: 'error',
        message: 'Candidate bytes could not be read consistently.',
      }],
    }
  }
}

function invalidResult(finding: CandidateFinding): ProfileCandidateValidation {
  return {
    valid: false,
    candidateId: null,
    profileName: null,
    fileCount: null,
    totalBytes: null,
    findings: [finding],
  }
}

function toSafeTreeFinding(err: unknown): CandidateFinding {
  if (!isInstallError(err)) {
    return {
      code: 'candidate_invalid',
      severity: 'error',
      message: 'Candidate tree could not be validated.',
    }
  }
  const subjects = 'files' in err.detail && Array.isArray(err.detail.files)
    ? err.detail.files.filter((value): value is string => typeof value === 'string')
    : undefined
  const messages: Readonly<Record<string, string>> = {
    path_escape: 'Candidate contains a path that leaves its declared boundary.',
    forbidden_custom_code: 'Candidate contains executable custom tool code that is not allowed here.',
    oversized: 'Candidate exceeds an enforced size or file-count limit.',
  }
  return {
    code: err.code,
    severity: 'error',
    message: messages[err.code] ?? 'Candidate tree is invalid.',
    ...(subjects !== undefined ? { subjects } : {}),
  }
}

async function hashCandidateTree(root: string): Promise<string> {
  const entries: Array<{ rel: string; kind: 'file' | 'symlink'; bytes: Buffer }> = []
  await collect(root, '', entries)
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const hash = createHash('sha256')
  for (const entry of entries) {
    hash.update(entry.rel, 'utf8')
    hash.update('\0')
    hash.update(entry.kind, 'utf8')
    hash.update('\0')
    hash.update(entry.bytes)
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function collect(
  dir: string,
  prefix: string,
  out: Array<{ rel: string; kind: 'file' | 'symlink'; bytes: Buffer }>,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === ORIGIN_SIDECAR_FILE) continue
    const full = join(dir, entry.name)
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const info = await lstat(full)
    if (info.isSymbolicLink()) {
      out.push({ rel, kind: 'symlink', bytes: Buffer.from(await readlink(full), 'utf8') })
    } else if (info.isDirectory()) {
      await collect(full, rel, out)
    } else if (info.isFile()) {
      out.push({ rel, kind: 'file', bytes: await readFile(full) })
    } else {
      throw new Error('Unsupported candidate entry')
    }
  }
}
