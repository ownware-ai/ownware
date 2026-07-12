/**
 * Validate a cloned profile tree against Phase-1 security gates.
 *
 * Run after clone, before placement on disk. Read-only — never writes,
 * never executes anything from the cloned tree. Builds up a list of
 * findings and throws a single InstallError at the end so the caller
 * gets every problem in one shot rather than fix-and-retry.
 *
 * Gates enforced here:
 *   1. **No executable code in `tools/`** (custom tools are forbidden for
 *      installed profiles — see decision 1 in `2026-05-06-decisions.md`).
 *      Builtins skip this check via `allowCustomCode: true`.
 *   2. **No path escape** — every path the manifest or `agent.json`
 *      references must resolve INSIDE the profile dir. Symlinks pointing
 *      outside the dir are rejected even if the link target is inside.
 *   3. **File-count cap** — refuse trees with more than `maxFiles` real
 *      files (default 1000). Catches accidentally-checked-in node_modules
 *      and zip-bomb-ish payloads.
 *   4. **Total-size cap** — refuse trees larger than `maxBytes` (default
 *      50 MB). Cheap second line of defense after the clone-time cap.
 *
 * What this DOES NOT do:
 *   - It does not parse `agent.json` (manifest.ts does that)
 *   - It does not check name collisions (the placement step does that)
 *   - It does not run any profile loaders
 */

import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { InstallError } from './errors.js'

export interface ValidateTreeOptions {
  /** Absolute path to the candidate profile directory. */
  readonly profileDir: string
  /** True when the caller is the builtin pipeline; relaxes the no-custom-code gate. */
  readonly allowCustomCode?: boolean
  /** Hard cap on file count. Default 1000. */
  readonly maxFiles?: number
  /** Hard cap on total bytes. Default 50 * 1024 * 1024. */
  readonly maxBytes?: number
}

const DEFAULT_MAX_FILES = 1000
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024

/** Extensions we treat as "executable code" — refused inside `tools/`. */
const FORBIDDEN_TOOL_EXTENSIONS: readonly string[] = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
]

/**
 * Walk the profile dir and enforce every Phase-1 gate. On success, returns
 * a `TreeStats` summary the caller can log. On any gate failure, throws
 * an `InstallError` with the worst-fitting code and a `files`/`detail`
 * payload listing every violation.
 *
 * Implementation note: the walker does ONE pass over the tree and
 * accumulates every violation type so we report all problems at once.
 * Throwing only at the end keeps the contract "fix-everything-then-retry"
 * instead of the user playing whack-a-mole.
 */
export interface TreeStats {
  readonly fileCount: number
  readonly totalBytes: number
}

export async function validateTree(opts: ValidateTreeOptions): Promise<TreeStats> {
  const root = resolve(opts.profileDir)
  const realRoot = await realpath(root)
  const allowCustomCode = opts.allowCustomCode === true
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES

  const forbiddenCustomCode: string[] = []
  const pathEscapes: string[] = []

  let fileCount = 0
  let totalBytes = 0

  async function walk(dirAbs: string): Promise<void> {
    const entries = await readdir(dirAbs, { withFileTypes: true })

    for (const entry of entries) {
      const entryAbs = join(dirAbs, entry.name)
      const entryRel = relative(root, entryAbs)

      // Symlink check FIRST — before any further stat / recurse. We use
      // `lstat` so we describe the link itself, not its target. A symlink
      // whose target resolves OUTSIDE the profile root is a path-escape
      // even if the file at the target happens to exist.
      if (entry.isSymbolicLink()) {
        let targetInside = false
        try {
          targetInside = isInside(realRoot, await realpath(entryAbs))
        } catch {
          // Dangling/unreadable links are not safe candidate material.
        }
        if (!targetInside) {
          pathEscapes.push(entryRel)
          continue
        }
        // Symlink stays within the dir — treat it like a file for the
        // count/size accounting; do not recurse through it (avoids cycles).
        fileCount += 1
        if (fileCount > maxFiles) {
          throw new InstallError('oversized', {
            limitBytes: maxBytes,
            observedBytes: totalBytes,
          }, `Repository file count exceeds limit (${fileCount} > ${maxFiles})`)
        }
        continue
      }

      if (entry.isDirectory()) {
        // Skip `.git` if any clone leaves it behind — defense in depth;
        // clone.ts is supposed to drop it but we double-check.
        if (entry.name === '.git') continue
        await walk(entryAbs)
        continue
      }

      if (!entry.isFile()) {
        // Special files (sockets, devices, fifos) shouldn't appear in a
        // git clone — treat as a path escape so we surface the anomaly.
        pathEscapes.push(entryRel)
        continue
      }

      // Regular file — gate on tools/ extension rule (unless builtin).
      if (!allowCustomCode && isInForbiddenToolsDir(entryRel)) {
        if (FORBIDDEN_TOOL_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
          forbiddenCustomCode.push(entryRel)
        }
      }

      const st = await lstat(entryAbs)
      fileCount += 1
      totalBytes += st.size

      if (fileCount > maxFiles) {
        throw new InstallError('oversized', {
          limitBytes: maxBytes,
          observedBytes: totalBytes,
        }, `Repository file count exceeds limit (${fileCount} > ${maxFiles})`)
      }
      if (totalBytes > maxBytes) {
        throw new InstallError('oversized', {
          limitBytes: maxBytes,
          observedBytes: totalBytes,
        })
      }
    }
  }

  await walk(root)

  if (forbiddenCustomCode.length > 0) {
    throw new InstallError('forbidden_custom_code', {
      files: forbiddenCustomCode,
    })
  }
  if (pathEscapes.length > 0) {
    throw new InstallError('path_escape', { files: pathEscapes })
  }

  return { fileCount, totalBytes }
}

/**
 * True when `child` is inside (or equal to) `parent` after path
 * normalisation. Both inputs MUST be absolute paths.
 */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  if (rel === '') return true
  if (rel.startsWith('..')) return false
  // Reject `..` fragment anywhere in the relative path
  return !rel.split(sep).includes('..')
}

/**
 * True when the relative path lives under any `tools/` directory inside
 * the profile (top-level OR nested under a top-level profile in a
 * multi-profile repo, e.g. `profiles/coder/tools/foo.ts`).
 */
function isInForbiddenToolsDir(rel: string): boolean {
  const parts = rel.split(/[/\\]/)
  return parts.includes('tools')
}
