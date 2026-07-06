/**
 * Built-in Filesystem Tools
 *
 * Provides readFile, writeFile, editFile, listFiles, glob, and grep.
 * All use Node.js fs/promises and operate relative to context.cwd.
 *
 * @security Hardened with:
 *   - Symlink resolution check (prevents symlink escape)
 *   - Sensitive file blocking (.env, .pem, id_rsa, credentials)
 *   - Binary file detection (null bytes in first 8KB)
 *   - File size limits (10MB default read limit)
 *   - Output sanitization (redacts secrets before returning to model)
 *   - Sensitive write path blocking (.ssh/, .gnupg/, /etc/)
 */

import * as fs from 'node:fs/promises'
import { statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import * as path from 'node:path'
import { defineTool } from '../types.js'
import type {
  Tool,
  ToolContext,
  ToolResult,
  ValidateInputResult,
} from '../types.js'
import { sanitizeOutput } from './output-sanitizer.js'
import { isRipgrepAvailable, runRipgrep } from './ripgrep.js'
import {
  BLOCKED_FILE_ERROR_MESSAGE,
  isBlockedFilePath,
} from '../../credentials/patterns.js'

// ---------------------------------------------------------------------------
// Security constants
// ---------------------------------------------------------------------------

const MAX_READ_SIZE = 10 * 1024 * 1024 // 10MB
const BINARY_CHECK_SIZE = 8192 // Check first 8KB for null bytes

/**
 * Token cap on a single `readFile` result. When the model asks for a file
 * whose content estimates over this many tokens, the tool refuses with an
 * actionable error instead of returning a partially-truncated blob.
 *
 * Why throw, not truncate: a truncated success returns up to 25K tokens of
 * content that LOOKS complete to the model — it has no way to know the
 * tail is missing and will reason on incomplete data. The throw path
 * returns a ~150-byte error message that tells the model exactly what to
 * do next: use `offset`/`limit`, or `grep` for the specific lines.
 *
 * The 25,000 number is an empirically calibrated
 * point that's large enough for almost every legitimate single-file read
 * (~100KB of typical English text or ~75KB of code) but small enough that
 * five parallel reads can't single-handedly burn the context window.
 */
const DEFAULT_MAX_READ_TOKENS = 25_000

/**
 * Cheap token estimate: chars/4 with per-line overhead for the leading
 * `<lineno>\t` prefix the tool emits. Overestimates slightly for
 * non-English / heavy-code content, which is the safe direction — we'd
 * rather refuse a borderline read than blow the model's context.
 */
function estimateReadTokens(content: string): number {
  return Math.ceil(content.length / 4)
}

function readTokenOverflowMessage(
  filePath: string,
  estimatedTokens: number,
  maxTokens: number,
  totalLines: number,
  offset: number,
  limit: number,
): string {
  const range =
    offset > 0 || limit < totalLines
      ? `lines ${offset + 1}–${Math.min(offset + limit, totalLines)} of ${totalLines}`
      : `${totalLines} lines`
  return (
    `File "${filePath}" (${range}, ~${estimatedTokens.toLocaleString()} tokens) ` +
    `exceeds the ${maxTokens.toLocaleString()}-token read budget. ` +
    `Use \`offset\` and \`limit\` to read specific portions, ` +
    `or use \`grep\` to find the lines you need before reading.`
  )
}

/**
 * Per-session memory of what `readFile` has already returned. When the
 * model asks to re-read a file that hasn't changed since the previous
 * read in this session, the tool returns a short stub pointing back at
 * the earlier tool_result instead of paying the full content cost again.
 *
 * Why per-session: planner / agent-loop agents commonly re-read the same
 * board / spec file every turn. Without this map a 4KB board re-read on
 * every turn dominates context. The FILE_UNCHANGED_STUB pattern below
 * short-circuits that cost.
 *
 * Why include offset+limit in the key: a re-read at a DIFFERENT slice is
 * a different question — that one still gets the content. The cache key
 * is { resolved abs path, mtimeMs, offset, limit, contentHash }.
 *
 * Storage: a module-level Map keyed by sessionId. Sessions are bounded
 * (one per chat thread) and entries are small (~80 bytes each). On
 * session end the entry can be cleared via `forgetReadStateForSession`,
 * but leaking entries is bounded by total session count and acceptable.
 */
interface ReadStateEntry {
  readonly resolvedPath: string
  readonly mtimeMs: number
  readonly offset: number
  readonly limit: number
  readonly contentHash: string
}

const readStateBySession = new Map<string, Map<string, ReadStateEntry>>()

function readStateKey(resolvedPath: string, offset: number, limit: number): string {
  return `${resolvedPath}::${offset}::${limit}`
}

function getSessionReadState(sessionId: string): Map<string, ReadStateEntry> {
  let state = readStateBySession.get(sessionId)
  if (!state) {
    state = new Map()
    readStateBySession.set(sessionId, state)
  }
  return state
}

/**
 * Stub returned for unchanged re-reads. Uses a phrasing that models
 * reliably recognise as a re-read marker and refer back to the earlier
 * tool_result.
 */
const FILE_UNCHANGED_STUB =
  'File unchanged since last read. The content from the earlier readFile tool_result ' +
  'in this conversation is still current — refer to that instead of re-reading.'

function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex')
}

/**
 * Clear the read-state map for a session. Intended for session teardown;
 * exported via `index.ts` so the gateway can call it when a thread closes.
 */
export function forgetReadStateForSession(sessionId: string): void {
  readStateBySession.delete(sessionId)
}

/** Hard cap on grep output bytes. Prevents OOM on pathological searches. */
const GREP_MAX_BYTES_DEFAULT = 20 * 1024 * 1024 // 20MB
/** Per-line truncation in grep output. Prevents minified/base64 noise from blowing context. */
const GREP_MAX_LINE_LENGTH_DEFAULT = 500

/**
 * Version control system directories — always pruned during walks, even when
 * `hidden: true` is passed. Walking these is never useful and explodes I/O.
 */
const VCS_DIRS: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  '.bzr',
  '.jj',
  '.sl',
])

/** Directories that are always pruned regardless of `hidden` flag. */
function isAlwaysPrunedDir(name: string): boolean {
  return VCS_DIRS.has(name) || name === 'node_modules'
}

/**
 * @security Paths hard-blocked by `isBlockedFilePath` from
 * `credentials/patterns.ts`. Credential isolation means the agent
 * reads secret files through the vault, never directly — there is no
 * "ask permission to read .env" path any more.
 *
 * The pattern list lives in `credentials/patterns.ts` so Cortex, the
 * shell `.env`-command guard, and the filesystem `readFile` path all
 * agree on the definition of "secret file". Adding a new blocked
 * pattern is one line in that module; every consumer picks it up.
 */

/** @security Paths that should never be written to. */
const SENSITIVE_WRITE_PATHS: string[] = [
  '/.ssh/',
  '/.gnupg/',
  '/.aws/',
  '/.config/gcloud/',
  '/.kube/',
  '/etc/',
  '/usr/',
  '/bin/',
  '/sbin/',
  '/boot/',
  '/sys/',
  '/proc/',
  '/dev/',
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a user-provided path against the working directory.
 *
 * Two enforcement modes:
 *
 *  - **Strict (default)** — used by write tools (`writeFile`,
 *    `editFile`, `createFile`). The literal target must be within
 *    `workspacePath` or an entry of `additionalWorkspaceRoots`, and
 *    the symlink-resolved real path must too. Out-of-bounds throws.
 *
 *  - **`allowOutsideWorkspace`** — used by read tools that the
 *    zone gate has already authorized. The zone classifier escalates
 *    outside-workspace reads to `MACHINE`, which is gated by the
 *    profile's HITL policy; by the time `execute` runs, the call has
 *    been explicitly allowed (auto in YOLO, prompted in standard).
 *    In this mode we skip the lexical out-of-bounds throw — but we
 *    still enforce the **symlink-escape** invariant: if the agent's
 *    literal path was inside an allowed root yet `realpath` lands
 *    outside, that is an attack vector the zone classifier could not
 *    see (it inspected the literal path), and we reject it.
 *
 * Sensitive-file blocking (`.ssh`, `.env`, certificates, …) is the
 * caller's responsibility via `isSensitiveFile`. The zone classifier
 * also tags those paths as `NEVER`, so an approved call never reaches
 * here for them; this function does not duplicate that check.
 *
 * @security Both modes resolve every allowed root through `realpath`
 * to neutralize macOS `/tmp` ↔ `/private/tmp` aliasing and any
 * granted-folder symlinks the host wired up.
 */
async function resolvePath(
  filePath: string,
  context: ToolContext,
  options?: { allowOutsideWorkspace?: boolean },
): Promise<string> {
  const allowOutside = options?.allowOutsideWorkspace ?? false
  const resolved = path.resolve(context.cwd, filePath)
  const workspace = context.workspacePath
  // Defensive default. The interface requires `additionalWorkspaceRoots`,
  // but older test fixtures and any host that pre-dates this field will
  // pass an undefined value at runtime — falling back to `[]` keeps the
  // existing single-workspace behaviour intact.
  const additionalRoots = context.additionalWorkspaceRoots ?? []

  // Validate workspace path — reject empty or root to prevent blanket access
  if (!workspace || workspace === '/') {
    throw new Error('Invalid workspace path configuration.')
  }

  // Boundary check with trailing separator to prevent prefix attacks
  // e.g. /workspace-evil must not pass when workspacePath is /workspace
  function isWithin(target: string, root: string): boolean {
    return target === root || target.startsWith(root + path.sep)
  }

  // Resolve every allowed root through realpath so macOS prefixes
  // (/tmp → /private/tmp) and granted-folder symlinks classify the
  // same way. Failures fall back to the literal path so a freshly-
  // created workspace doesn't crash before the directory exists.
  async function resolveRoot(root: string): Promise<{ literal: string; real: string }> {
    let real = root
    try {
      real = await fs.realpath(root)
    } catch {
      // realpath failed (e.g. ENOENT) — keep literal
    }
    return { literal: root, real }
  }

  const allowedRoots = await Promise.all([workspace, ...additionalRoots].map(resolveRoot))

  // Reject root === '/' on additional roots too — a granted '/' would
  // defeat the whole boundary system.
  for (const r of allowedRoots) {
    if (r.literal === '/' || r.real === '/') {
      throw new Error('Invalid workspace path configuration: root "/" is never allowed.')
    }
  }

  function isWithinAnyRoot(target: string): boolean {
    for (const r of allowedRoots) {
      if (isWithin(target, r.literal) || isWithin(target, r.real)) return true
    }
    return false
  }

  const lexicallyInside = isWithinAnyRoot(resolved)

  // Strict mode rejects lexical out-of-bounds outright. In
  // `allowOutsideWorkspace` mode we trust the upstream zone gate.
  if (!lexicallyInside && !allowOutside) {
    throw new Error(
      `Path "${filePath}" resolves outside the workspace root.`,
    )
  }

  // Symlink resolution: check if the real path is still within an allowed root
  try {
    const realPath = await fs.realpath(resolved)

    // Symlink-escape protection — applies whenever the literal path
    // was inside an allowed root. The agent (and the zone classifier)
    // saw the literal path; if the real target is outside, that is an
    // escape they could not detect, so we block regardless of mode.
    if (lexicallyInside && !isWithinAnyRoot(realPath)) {
      throw new Error(
        `Path "${filePath}" is a symlink pointing outside the workspace root.`,
      )
    }

    return realPath
  } catch (e) {
    // realpath fails if file doesn't exist yet (writeFile) — allow the resolved path
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return resolved
    }
    throw e
  }
}

/**
 * Check if a path matches a blocked (secret-material) file pattern.
 * Thin wrapper over the shared implementation so call sites read
 * naturally — the previous pattern-array + inlined `.some` lived here
 * when the list was small enough to review inline. Now the list is
 * canonical in `credentials/patterns.ts`.
 */
function isSensitiveFile(filePath: string): boolean {
  return isBlockedFilePath(filePath)
}

/** Check if a path is in a sensitive write location. */
function isSensitiveWritePath(filePath: string): boolean {
  const home = process.env.HOME ?? ''
  return SENSITIVE_WRITE_PATHS.some(p => {
    if (p.startsWith('/')) {
      // Absolute system paths
      if (p.startsWith('/.')) {
        // Home-relative paths like /.ssh/
        return home && filePath.startsWith(home + p)
      }
      return filePath.startsWith(p)
    }
    return false
  })
}

/** Check if content is likely binary by looking for null bytes in the first chunk. */
function isBinary(buffer: Buffer): boolean {
  const checkSize = Math.min(buffer.length, BINARY_CHECK_SIZE)
  for (let i = 0; i < checkSize; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

function lineNumbered(content: string, offset: number): string {
  return content
    .split('\n')
    .map((line, i) => `${offset + i + 1}\t${line}`)
    .join('\n')
}

function ok(content: string, metadata?: Record<string, unknown>): ToolResult {
  return { content, isError: false, metadata }
}

function err(message: string): ToolResult {
  return { content: message, isError: true }
}

// ---------------------------------------------------------------------------
// readFile
// ---------------------------------------------------------------------------

export const readFile: Tool = defineTool({
  name: 'readFile',
  cacheKey: (input, ctx) => {
    // Key on resolved absolute path + mtime + slice window. mtime is the
    // canonical "did the file change" signal. If stat fails (missing,
    // permission, race), bypass the cache so the tool's own error
    // handling stays authoritative. We deliberately use path.resolve
    // (sync, no symlink follow) — security-relevant resolution stays
    // inside execute(), the cache key just needs to be deterministic.
    const i = input as { file_path: string; offset?: number; limit?: number }
    try {
      const abs = path.resolve(ctx.cwd, i.file_path)
      const st = statSync(abs)
      return `${abs}:${st.mtimeMs}:${i.offset ?? 0}:${i.limit ?? 2000}`
    } catch {
      return null
    }
  },
  description:
    'Read a file from the filesystem. Returns content with 1-based line numbers.\n' +
    '- Read files BEFORE suggesting changes — never modify code you haven\'t read.\n' +
    '- Read a file in this turn before editing it. `editFile` matches `old_string` literally against the file\'s current contents, so stale memory produces a not-found error you have to debug.\n' +
    '- Use `offset` and `limit` to read specific portions of large files (>2000 lines).\n' +
    '- Single-read budget is ~25,000 tokens (~100KB). Reads above the budget are REFUSED — use `offset`/`limit` to chunk, or use `grep` to find the lines you need before reading. Do NOT plan a turn that reads many large files in parallel.\n' +
    '- If the file doesn\'t exist, returns an error — check the path with `glob` first.\n' +
    '- Image and binary files are detected automatically and rejected; use a specialized tool for those.\n' +
    '- After a non-trivial edit, re-read the edited region to verify the change landed correctly.',
  category: 'filesystem',
  isReadOnly: true,
  requiresPermission: true,
  uiDescriptor: {
    kind: 'file-read',
    summary: { verb: 'Read', primaryField: 'file_path' },
    preview: { contentField: 'content', format: 'code', truncateAtLines: 10 },
    openAction: { target: 'file-pane', pathField: 'file_path' },
  },
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute or relative path to the file to read.',
      },
      offset: {
        type: 'number',
        description: 'Line number to start reading from (0-based). Default: 0.',
      },
      limit: {
        type: 'number',
        description:
          'Maximum number of lines to read. Default: 2000.',
      },
    },
    required: ['file_path'],
  },
  async execute(input, context) {
    const { file_path, offset = 0, limit = 2000 } = input as {
      file_path: string
      offset?: number
      limit?: number
    }

    try {
      const resolved = await resolvePath(file_path, context, { allowOutsideWorkspace: true })

      // Security: hard-block reads of secret-material files. The
      // credential vault is the ONLY way to reach these values; there
      // is deliberately no "ask permission" fallback, because letting
      // the agent see .env content once would defeat the isolation
      // invariant for the rest of the session (the value is now in
      // message history).
      if (isSensitiveFile(resolved)) {
        return err(BLOCKED_FILE_ERROR_MESSAGE)
      }

      // Security: check file size before reading
      const stat = await fs.stat(resolved)
      if (stat.size > MAX_READ_SIZE) {
        return err(
          `File "${file_path}" is too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). ` +
          `Maximum read size is ${MAX_READ_SIZE / 1024 / 1024}MB.`,
        )
      }

      // Read as buffer first to check for binary content
      const buffer = await fs.readFile(resolved)

      // Security: binary file detection
      if (isBinary(buffer)) {
        return err(
          `File "${file_path}" appears to be a binary file. Use a specialized tool to handle binary files.`,
        )
      }

      const raw = buffer.toString('utf-8')
      const lines = raw.split('\n')
      const sliced = lines.slice(offset, offset + limit)
      let content = lineNumbered(sliced.join('\n'), offset)

      // Token-budget gate. Refuse oversized reads with an actionable
      // error — see DEFAULT_MAX_READ_TOKENS for the rationale. The check
      // runs on the LINE-NUMBERED content because that's what the model
      // actually receives; the `<lineno>\t` prefix counts against budget.
      const estimatedTokens = estimateReadTokens(content)
      if (estimatedTokens > DEFAULT_MAX_READ_TOKENS) {
        return err(
          readTokenOverflowMessage(
            file_path,
            estimatedTokens,
            DEFAULT_MAX_READ_TOKENS,
            lines.length,
            offset,
            limit,
          ),
        )
      }

      // Re-read short-circuit: if this exact (path, offset, limit) was
      // already read in this session and neither the file's mtime nor
      // content has changed, return the unchanged-stub. The earlier
      // tool_result is still in the conversation; sending it again just
      // burns context. The contentHash check guards against mtime
      // false-positives on Windows / cloud-synced filesystems where mtime
      // can change without content changing.
      const sessionState = getSessionReadState(context.sessionId)
      const stateKey = readStateKey(resolved, offset, limit)
      const contentHash = sha1(content)
      const prior = sessionState.get(stateKey)
      if (
        prior !== undefined &&
        prior.mtimeMs === stat.mtimeMs &&
        prior.contentHash === contentHash
      ) {
        return ok(FILE_UNCHANGED_STUB, {
          totalLines: lines.length,
          unchangedRead: true,
        })
      }
      sessionState.set(stateKey, {
        resolvedPath: resolved,
        mtimeMs: stat.mtimeMs,
        offset,
        limit,
        contentHash,
      })

      // Security: sanitize output (redact secrets)
      const { sanitized, redactedCount } = sanitizeOutput(content)
      content = sanitized

      const meta: Record<string, unknown> = { totalLines: lines.length }
      if (offset + limit < lines.length) {
        meta.truncated = true
        meta.nextOffset = offset + limit
      }
      if (redactedCount > 0) {
        meta.redactedSecrets = redactedCount
      }

      return ok(content, meta)
    } catch (e) {
      return err(
        `Failed to read "${file_path}": ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  },
})

// ---------------------------------------------------------------------------
// writeFile
// ---------------------------------------------------------------------------

/**
 * Pre-execute validation for `writeFile`. Resolves the destination path
 * (catching out-of-workspace and symlink-escape errors), rejects writes
 * to sensitive system directories, and runs the secret-content scan with
 * its `requestPermission` HITL prompt. The permission prompt lives ONLY
 * here so that callers using `executeTool` see it once; `execute` keeps
 * the cheap idempotent checks (path resolution, sensitive paths) for
 * defence in depth against direct callers (tests, custom dispatchers).
 *
 * Reserved error codes:
 *   10 — path resolution failed (out-of-workspace, symlink escape, …)
 *   11 — sensitive write path
 *   12 — write cancelled (user denied secret-content prompt)
 */
async function validateWriteFileInput(
  input: { file_path: string; content: string },
  context: ToolContext,
): Promise<ValidateInputResult> {
  let resolved: string
  try {
    resolved = await resolvePath(input.file_path, context)
  } catch (e) {
    return {
      result: false,
      message: `Failed to write "${input.file_path}": ${
        e instanceof Error ? e.message : String(e)
      }`,
      errorCode: 10,
    }
  }

  if (isSensitiveWritePath(resolved)) {
    return {
      result: false,
      message: `Write blocked: "${input.file_path}" is in a sensitive system directory.`,
      errorCode: 11,
    }
  }

  const { redactedCount, redactedTypes } = sanitizeOutput(input.content)
  if (redactedCount > 0) {
    const approved = await context.requestPermission(
      'writeFile:secrets',
      `Writing file "${input.file_path}" that contains ${redactedCount} potential secret(s): ${redactedTypes.join(', ')}`,
    )
    if (!approved) {
      return {
        result: false,
        message: `Write cancelled: file contains potential secrets.`,
        errorCode: 12,
      }
    }
  }

  return { result: true }
}

export const writeFile: Tool = defineTool({
  name: 'writeFile',
  description:
    'Create a new file with the given content. Fails if the file already exists.\n' +
    '- Use editFile to modify existing files, not writeFile.\n' +
    '- Parent directories are created automatically.\n' +
    '- Prefer editing existing files over creating new ones — prevents file bloat.\n' +
    '- Don\'t create documentation files unless explicitly asked.',
  category: 'filesystem',
  isReadOnly: false,
  requiresPermission: true,
  uiDescriptor: {
    kind: 'file-write',
    summary: { verb: 'Wrote', primaryField: 'file_path' },
    preview: { contentField: 'content', format: 'code', truncateAtLines: 10 },
    openAction: { target: 'file-pane', pathField: 'file_path' },
  },
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path for the new file.',
      },
      content: {
        type: 'string',
        description: 'Content to write to the file.',
      },
    },
    required: ['file_path', 'content'],
  },
  async validateInput(input, context) {
    return validateWriteFileInput(
      input as { file_path: string; content: string },
      context,
    )
  },
  async execute(input, context) {
    const { file_path, content } = input as {
      file_path: string
      content: string
    }

    try {
      // Path resolution and sensitive-path check are kept here for defence
      // in depth — `executeTool` already runs `validateWriteFileInput`
      // which performs the same checks. Direct callers that bypass the
      // executor (tests, custom dispatchers) still get rejection on
      // out-of-workspace and sensitive-system paths. The secret-content
      // permission prompt is intentionally NOT duplicated: it lives in
      // `validateInput` only so users never see the dialog twice.
      const resolved = await resolvePath(file_path, context)

      if (isSensitiveWritePath(resolved)) {
        return err(
          `Write blocked: "${file_path}" is in a sensitive system directory.`,
        )
      }

      // Create parent directories
      await fs.mkdir(path.dirname(resolved), { recursive: true })

      // Atomic create-only write using 'wx' flag to prevent TOCTOU race
      try {
        await fs.writeFile(resolved, content, { flag: 'wx', encoding: 'utf-8' })
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
          return err(
            `File "${file_path}" already exists. Use editFile to modify existing files.`,
          )
        }
        throw e
      }

      // Report line count as the primary metric — that's what the
      // user reads in the chat UI ("Wrote foo.html · 42 lines"), and
      // it's a more honest measure of how much a file changed than
      // raw character count. Both numbers ride on metadata so the
      // UI tool-registry can format whichever it prefers without
      // re-parsing the prose.
      const lineCount = content.split('\n').length
      return ok(
        `File created: ${file_path} (${lineCount} ${lineCount === 1 ? 'line' : 'lines'}, ${content.length} characters)`,
        { lineCount, charCount: content.length },
      )
    } catch (e) {
      return err(
        `Failed to write "${file_path}": ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  },
})

// ---------------------------------------------------------------------------
// editFile
// ---------------------------------------------------------------------------

/**
 * Pre-execute validation for `editFile`. Mirrors the cheap pre-write
 * checks in `execute` so the executor can reject obviously-doomed calls
 * (no-op edits, out-of-workspace paths, sensitive system files) without
 * arming the timeout or starting the read+match phase. Side-effect-free.
 *
 * The "old_string not found" and "ambiguous match" checks stay in
 * `execute` because they require a fresh file read; running that twice
 * (once here, once there) would double-charge IO on every successful
 * edit. The pre-flight savings only justify the duplication for checks
 * that are pure or O(1) IO.
 *
 * Reserved error codes:
 *   10 — path resolution failed
 *   11 — sensitive write path
 *   20 — old_string identical to new_string
 *   21 — target is a sensitive (read-blocked) file
 */
async function validateEditFileInput(
  input: { file_path: string; old_string: string; new_string: string },
  _context: ToolContext,
): Promise<ValidateInputResult> {
  if (input.old_string === input.new_string) {
    return {
      result: false,
      message: 'old_string and new_string are identical.',
      errorCode: 20,
    }
  }

  let resolved: string
  try {
    resolved = await resolvePath(input.file_path, _context)
  } catch (e) {
    return {
      result: false,
      message: `Failed to edit "${input.file_path}": ${
        e instanceof Error ? e.message : String(e)
      }`,
      errorCode: 10,
    }
  }

  if (isSensitiveWritePath(resolved)) {
    return {
      result: false,
      message: `Edit blocked: "${input.file_path}" is in a sensitive system directory.`,
      errorCode: 11,
    }
  }

  if (isSensitiveFile(resolved)) {
    return {
      result: false,
      message: BLOCKED_FILE_ERROR_MESSAGE,
      errorCode: 21,
    }
  }

  return { result: true }
}

/**
 * Atomically replace a file's contents: write to a temp file in the SAME
 * directory, fsync it, then rename over the target. POSIX rename is atomic
 * within a filesystem (and replaces on Windows), so a crash / power loss /
 * ENOSPC mid-write leaves the ORIGINAL file intact rather than truncated or
 * half-written — unlike a direct `fs.writeFile`, which truncates first. The
 * original file's mode is preserved (the temp+rename creates a NEW inode that
 * would otherwise pick up default perms, silently dropping an `+x` bit); the
 * temp file is cleaned up on any failure.
 */
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath)
  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomUUID().slice(0, 8)}.tmp`)
  // Preserve the existing file's mode when it exists (editFile always edits an
  // existing file; the try/catch keeps this safe if it somehow doesn't).
  let mode: number | undefined
  try {
    mode = (await fs.stat(filePath)).mode
  } catch {
    // New file — let the temp keep its default creation mode.
  }
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(tmp, 'wx')
    await handle.writeFile(content, 'utf-8')
    await handle.sync()
    if (mode !== undefined) await handle.chmod(mode)
    await handle.close()
    handle = undefined
    await fs.rename(tmp, filePath)
  } catch (e) {
    if (handle) {
      try { await handle.close() } catch { /* already failing; ignore close error */ }
    }
    try { await fs.unlink(tmp) } catch { /* temp may not have been created */ }
    throw e
  }
}

export const editFile: Tool = defineTool({
  name: 'editFile',
  description:
    'Edit an existing file by replacing `old_string` with `new_string`. Exact, literal match.\n' +
    '\n' +
    '## Rules (all mandatory)\n' +
    '- Read the file in this turn before editing. The tool reads the file fresh to perform the replacement, so an `old_string` from stale memory will not match — and the diagnostic ("not found") will not tell you what changed underneath you.\n' +
    '- `old_string` must match EXACTLY — same characters, same whitespace, same indentation. Copy from `readFile` output; do not retype.\n' +
    '- `old_string` must be UNIQUE in the file. If it isn\'t, the edit fails — add more surrounding lines until it is unique.\n' +
    '- For deletions, include 2–3 lines BEFORE and AFTER the code being removed in `old_string`, with the surrounding lines unchanged in `new_string`. This makes the edit unambiguous and prevents orphaning a `}` or a caller.\n' +
    '- Use `replace_all: true` ONLY for intentional all-occurrences changes (e.g., renaming a variable across a file). Default behavior requires a unique match.\n' +
    '- Prefer small, focused edits. Don\'t touch code you weren\'t asked to change — no drive-by refactors, no added comments or type annotations on untouched code.\n' +
    '\n' +
    '## After editing\n' +
    '- Re-read the edited region with `readFile` to verify the change applied correctly, no duplicate code was created, and nothing adjacent was corrupted.\n' +
    '- Never use `writeFile` to make a few line changes in an existing file. `writeFile` is for new files only.',
  category: 'filesystem',
  isReadOnly: false,
  requiresPermission: true,
  uiDescriptor: {
    kind: 'file-edit',
    summary: { verb: 'Edited', primaryField: 'file_path' },
    preview: { contentField: 'new_string', format: 'diff', truncateAtLines: 10 },
    openAction: { target: 'file-pane', pathField: 'file_path' },
  },
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the file to edit.',
      },
      old_string: {
        type: 'string',
        description: 'The exact string to find and replace.',
      },
      new_string: {
        type: 'string',
        description: 'The replacement string.',
      },
      replace_all: {
        type: 'boolean',
        description:
          'Replace all occurrences instead of requiring exactly one. Default: false.',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  async validateInput(input, context) {
    return validateEditFileInput(
      input as {
        file_path: string
        old_string: string
        new_string: string
      },
      context,
    )
  },
  async execute(input, context) {
    const {
      file_path,
      old_string,
      new_string,
      replace_all = false,
    } = input as {
      file_path: string
      old_string: string
      new_string: string
      replace_all?: boolean
    }

    // Mirrors of validateInput's checks for direct-call defence in depth.
    // executeTool runs validateInput first; bypassers (tests, custom
    // dispatchers) still get rejected on the cheap invariants.
    if (old_string === new_string) {
      return err('old_string and new_string are identical.')
    }

    try {
      const resolved = await resolvePath(file_path, context)

      // Security: block edits to sensitive paths
      if (isSensitiveWritePath(resolved)) {
        return err(
          `Edit blocked: "${file_path}" is in a sensitive system directory.`,
        )
      }

      // Security: hard-block edits to secret-material files. Same
      // invariant as readFile — the vault owns these values. If the
      // user really needs to rotate a secret, they do it through the
      // credential management UI, not an agent editFile call.
      if (isSensitiveFile(resolved)) {
        return err(BLOCKED_FILE_ERROR_MESSAGE)
      }

      const content = await fs.readFile(resolved, 'utf-8')

      const occurrences = countOccurrences(content, old_string)
      if (occurrences === 0) {
        return err(
          `old_string not found in "${file_path}". Ensure the string matches exactly, including whitespace and indentation.`,
        )
      }
      if (!replace_all && occurrences > 1) {
        return err(
          `old_string found ${occurrences} times in "${file_path}". Provide more context to make it unique, or set replace_all: true.`,
        )
      }

      let updated: string
      if (replace_all) {
        updated = content.split(old_string).join(new_string)
      } else {
        const idx = content.indexOf(old_string)
        updated =
          content.slice(0, idx) +
          new_string +
          content.slice(idx + old_string.length)
      }

      await atomicWriteFile(resolved, updated)

      const replacedCount = replace_all ? occurrences : 1
      return ok(
        `Edited "${file_path}": replaced ${replacedCount} occurrence${replacedCount > 1 ? 's' : ''}.`,
        { replacedCount },
      )
    } catch (e) {
      return err(
        `Failed to edit "${file_path}": ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  },
})

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let pos = 0
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++
    pos += needle.length
  }
  return count
}

// ---------------------------------------------------------------------------
// listFiles
// ---------------------------------------------------------------------------

export const listFiles: Tool = defineTool({
  name: 'listFiles',
  cacheKey: (input, ctx) => {
    // Directory mtime catches add/remove/rename of entries within the
    // dir but NOT modifications to existing files (their size could
    // change). For a directory listing this is the right tradeoff —
    // the agent re-reads files individually, where readFile's own
    // mtime check catches changes. Bypass the cache on stat failure.
    const dirPath = (input as { path?: string }).path ?? '.'
    try {
      const abs = path.resolve(ctx.cwd, dirPath)
      const st = statSync(abs)
      return `${abs}:${st.mtimeMs}`
    } catch {
      return null
    }
  },
  description:
    'List files and directories in a path. Returns name, size, and type.\n' +
    '- Use this to understand directory structure before diving into files.\n' +
    '- Results are sorted: directories first, then alphabetically.\n' +
    '- Shows file sizes in human-readable format (KB, MB).',
  category: 'filesystem',
  isReadOnly: true,
  requiresPermission: true,
  uiDescriptor: {
    kind: 'file-read',
    summary: { verb: 'Listed', primaryField: 'path' },
    openAction: { target: 'file-pane', pathField: 'path' },
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Directory path to list. Defaults to the working directory.',
      },
    },
    required: [],
  },
  async execute(input, context) {
    const dirPath = (input as { path?: string }).path ?? '.'

    try {
      const resolved = await resolvePath(dirPath, context, { allowOutsideWorkspace: true })
      const entries = await fs.readdir(resolved, { withFileTypes: true })

      const results = await Promise.all(
        entries.map(async (entry) => {
          const fullPath = path.join(resolved, entry.name)
          try {
            const stat = await fs.stat(fullPath)
            return {
              name: entry.name,
              isDir: entry.isDirectory(),
              size: stat.size,
            }
          } catch {
            return { name: entry.name, isDir: entry.isDirectory(), size: 0 }
          }
        }),
      )

      // Sort: directories first, then alphabetical
      results.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name)
      })

      const lines = results.map(
        (r) =>
          `${r.isDir ? 'd' : '-'} ${padSize(r.size)} ${r.name}`,
      )
      return ok(lines.join('\n'))
    } catch (e) {
      return err(
        `Failed to list "${dirPath}": ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  },
})

function padSize(size: number): string {
  if (size < 1024) return `${size}B`.padStart(8)
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}K`.padStart(8)
  return `${(size / (1024 * 1024)).toFixed(1)}M`.padStart(8)
}

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

export const glob: Tool = defineTool({
  name: 'glob',
  description:
    'Find files matching a glob pattern. Returns matching paths sorted by modification time (newest first).\n' +
    '- Use ** for recursive matching: \'**/*.ts\' finds all TypeScript files.\n' +
    '- Use this when you need to find files by name or extension.\n' +
    '- For searching file CONTENTS, use grep instead.\n' +
    '- VCS dirs (.git, .hg, .svn, .bzr, .jj, .sl) and node_modules are always skipped.\n' +
    '- Hidden files/dirs (dot-prefixed) are skipped by default — set hidden: true to include them.',
  category: 'filesystem',
  isReadOnly: true,
  requiresPermission: true,
  uiDescriptor: {
    kind: 'search',
    summary: { verb: 'Matched', primaryField: 'pattern' },
    preview: { contentField: 'content', format: 'plain', truncateAtLines: 10 },
  },
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern (e.g., "**/*.ts", "src/**/*.tsx").',
      },
      path: {
        type: 'string',
        description:
          'Directory to search in. Defaults to the working directory.',
      },
      hidden: {
        type: 'boolean',
        description:
          'Include hidden files and directories (dot-prefixed). Default: false. ' +
          'VCS dirs and node_modules are still excluded even when true.',
      },
    },
    required: ['pattern'],
  },
  async execute(input, context) {
    const { pattern, path: searchPath, hidden = false } = input as {
      pattern: string
      path?: string
      hidden?: boolean
    }

    try {
      const resolved = await resolvePath(searchPath ?? '.', context, { allowOutsideWorkspace: true })
      const matches = await globWalk(resolved, pattern, hidden)

      // Sort by mtime descending
      const withStats = await Promise.all(
        matches.map(async (filePath) => {
          try {
            const stat = await fs.stat(filePath)
            return { filePath, mtime: stat.mtimeMs }
          } catch {
            return { filePath, mtime: 0 }
          }
        }),
      )
      withStats.sort((a, b) => b.mtime - a.mtime)

      // Return paths relative to search root, filtering sensitive files from results
      const relative = withStats
        .map((m) => path.relative(resolved, m.filePath))
        .filter(p => !isSensitiveFile(p))

      if (relative.length === 0) {
        return ok('No files found.')
      }
      return ok(relative.join('\n'), { count: relative.length })
    } catch (e) {
      return err(
        `Glob failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  },
})

/**
 * Simple recursive glob walk using fs.readdir.
 * Supports *, **, and ? wildcards.
 */
async function globWalk(
  root: string,
  pattern: string,
  includeHidden: boolean,
): Promise<string[]> {
  const results: string[] = []
  const regex = globToRegex(pattern)

  async function walk(dir: string) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      const relativePath = path.relative(root, fullPath)
      if (entry.isDirectory()) {
        if (isAlwaysPrunedDir(entry.name)) continue
        if (!includeHidden && entry.name.startsWith('.')) continue
        await walk(fullPath)
      } else {
        if (!includeHidden && entry.name.startsWith('.')) continue
        if (regex.test(relativePath)) results.push(fullPath)
      }
    }
  }

  await walk(root)
  return results
}

function globToRegex(pattern: string): RegExp {
  let regexStr = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]!
    if (c === '*' && pattern[i + 1] === '*') {
      // ** matches any number of directories
      regexStr += '.*'
      i += 2
      if (pattern[i] === '/') i++ // skip trailing slash after **
    } else if (c === '*') {
      regexStr += '[^/]*'
      i++
    } else if (c === '?') {
      regexStr += '[^/]'
      i++
    } else if (c === '.') {
      regexStr += '\\.'
      i++
    } else if ('+^${}()|[]\\'.includes(c)) {
      regexStr += '\\' + c
      i++
    } else {
      regexStr += c
      i++
    }
  }
  return new RegExp(`^${regexStr}$`)
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

export const grep: Tool = defineTool({
  name: 'grep',
  cacheKey: (input, ctx) => {
    // grep can scan thousands of files, so we don't try to mtime each
    // one — the cost would dwarf the cache win. Instead key by stable
    // JSON of input + cwd. The (small) tradeoff: if the agent edits
    // a file then re-runs the same grep within a session, the second
    // call hits cached (potentially stale) output. In practice agents
    // grep, then read the matching files individually — the readFile
    // mtime check catches the staleness one level down. For the rare
    // tasks where this matters, the agent can vary the grep input
    // slightly to bypass the cache.
    try {
      const stable = JSON.stringify(
        Object.keys(input).sort().reduce((acc, k) => {
          (acc as Record<string, unknown>)[k] = (input as Record<string, unknown>)[k]
          return acc
        }, {} as Record<string, unknown>),
      )
      return `${ctx.cwd}|${stable}`
    } catch {
      return null
    }
  },
  description:
    'Search file contents. Returns matching lines with file paths and line numbers.\n' +
    '- Powered by ripgrep: fast, parallel, and respects .gitignore by default (set no_ignore: true to override).\n' +
    '- Searches CONTENTS, not file names (use glob for file names).\n' +
    '- Default mode is literal substring. Set regex: true to use a regular expression.\n' +
    '- Set multiline: true (implies regex) to match patterns across newlines (e.g., "interface\\\\s+\\\\w+\\\\s*\\\\{[\\\\s\\\\S]*?\\\\}").\n' +
    '- Use glob parameter to scope the file set (e.g., "*.ts").\n' +
    '- Lines longer than max_line_length (default 500) are truncated. Total output is capped at max_bytes (default 20MB).\n' +
    '- VCS dirs (.git, .hg, .svn, .bzr, .jj, .sl) and node_modules are always skipped.\n' +
    '- Hidden files/dirs are skipped unless hidden: true.\n' +
    '- Binary files are auto-detected and skipped.\n' +
    '- Returns up to max_results matching lines (default 250). Format: filepath:line_number: content.',
  category: 'filesystem',
  isReadOnly: true,
  requiresPermission: true,
  uiDescriptor: {
    kind: 'search',
    summary: { verb: 'Searched', primaryField: 'pattern' },
    preview: { contentField: 'content', format: 'plain', truncateAtLines: 10 },
  },
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'String or regex to search for. Treated as literal unless regex: true.',
      },
      path: {
        type: 'string',
        description:
          'File or directory to search in. Defaults to the working directory.',
      },
      glob: {
        type: 'string',
        description: 'Glob pattern to filter files (e.g., "*.ts").',
      },
      case_sensitive: {
        type: 'boolean',
        description: 'Whether the search is case-sensitive. Default: true.',
      },
      regex: {
        type: 'boolean',
        description:
          'Treat pattern as a JavaScript regular expression instead of a literal string. Default: false.',
      },
      multiline: {
        type: 'boolean',
        description:
          'Match across newlines. Implies regex: true; "." matches any character including newlines (dotall + multiline flags). Default: false.',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of matching lines to return. Default: 250.',
      },
      max_line_length: {
        type: 'number',
        description:
          'Truncate matched lines longer than this many characters. Default: 500. Set to 0 to disable.',
      },
      max_bytes: {
        type: 'number',
        description:
          'Hard cap on total output size in bytes. Search stops once exceeded. Default: 20971520 (20MB).',
      },
      hidden: {
        type: 'boolean',
        description:
          'Search hidden files and directories (dot-prefixed). Default: false. ' +
          'VCS dirs and node_modules are still excluded.',
      },
      no_ignore: {
        type: 'boolean',
        description:
          'Ignore .gitignore / .ignore rules and search all files. Default: false ' +
          '(ignored files are skipped, matching git semantics). Only honored when ripgrep is active.',
      },
    },
    required: ['pattern'],
  },
  async execute(input, context) {
    const {
      pattern,
      path: searchPath,
      glob: fileGlob,
      case_sensitive = true,
      regex: useRegex = false,
      multiline = false,
      max_results = 250,
      max_line_length = GREP_MAX_LINE_LENGTH_DEFAULT,
      max_bytes = GREP_MAX_BYTES_DEFAULT,
      hidden = false,
      no_ignore = false,
    } = input as {
      pattern: string
      path?: string
      glob?: string
      case_sensitive?: boolean
      regex?: boolean
      multiline?: boolean
      max_results?: number
      max_line_length?: number
      max_bytes?: number
      hidden?: boolean
      no_ignore?: boolean
    }

    // multiline implies regex
    const regexMode = useRegex || multiline

    let matcher: Matcher
    try {
      matcher = buildMatcher(pattern, {
        regex: regexMode,
        multiline,
        caseSensitive: case_sensitive,
      })
    } catch (e) {
      return err(
        `Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`,
      )
    }

    try {
      const resolved = await resolvePath(searchPath ?? '.', context, { allowOutsideWorkspace: true })
      const stat = await fs.stat(resolved)

      const state: GrepState = {
        matches: [],
        bytes: 0,
        maxResults: max_results,
        maxBytes: max_bytes,
        maxLineLength: max_line_length,
        capped: false,
      }

      // Try ripgrep first. Falls back to the JS walker on any failure.
      // Ripgrep is faster, respects .gitignore, handles binary detection natively.
      let usedRipgrep = false
      if (stat.isDirectory() && (await isRipgrepAvailable())) {
        try {
          const rg = await runRipgrep({
            pattern,
            cwd: resolved,
            fixedStrings: !regexMode,
            multiline,
            caseSensitive: case_sensitive,
            includeHidden: hidden,
            respectIgnore: !no_ignore,
            glob: fileGlob,
            maxBytes: max_bytes,
            maxResults: max_results,
            signal: context.signal,
          })
          for (const line of rg.lines) {
            // Security: filter sensitive files from results (ripgrep doesn't know our policy).
            if (isSensitiveFile(line.file)) continue
            const truncated = truncateLine(line.text, state.maxLineLength)
            state.matches.push(`${line.file}:${line.lineNo}: ${truncated}`)
          }
          if (rg.truncatedByBytes) state.capped = true
          usedRipgrep = true
        } catch {
          // Fall through to JS walker
        }
      }

      if (!usedRipgrep) {
        if (stat.isFile()) {
          await searchFile(resolved, matcher, state, resolved)
        } else {
          const globRegex = fileGlob ? globToRegex(fileGlob) : null
          await searchDirectory(resolved, resolved, matcher, state, globRegex, hidden)
        }
      }

      if (state.matches.length === 0) {
        return ok('No matches found.')
      }

      // Security: sanitize grep results (redact secrets)
      let content = state.matches.join('\n')
      const { sanitized, redactedCount } = sanitizeOutput(content)
      content = sanitized

      const trailers: string[] = []
      if (state.matches.length >= state.maxResults) {
        trailers.push(`Showing first ${state.maxResults} matches`)
      }
      if (state.capped) {
        trailers.push(`Output truncated at ${state.maxBytes} bytes`)
      }
      if (trailers.length > 0) {
        content += `\n\n[${trailers.join('; ')}]`
      }

      const meta: Record<string, unknown> = { matchCount: state.matches.length }
      if (redactedCount > 0) meta.redactedSecrets = redactedCount
      if (state.capped) meta.bytesCapped = true

      return ok(content, meta)
    } catch (e) {
      return err(
        `Grep failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  },
})

// ---------------------------------------------------------------------------
// grep internals
// ---------------------------------------------------------------------------

interface GrepState {
  matches: string[]
  bytes: number
  readonly maxResults: number
  readonly maxBytes: number
  readonly maxLineLength: number
  capped: boolean
}

interface MatcherOpts {
  readonly regex: boolean
  readonly multiline: boolean
  readonly caseSensitive: boolean
}

/**
 * A matcher abstracts literal vs single-line regex vs multiline regex search.
 * Returns matching line ranges from a file's content as `{lineNo, text}` tuples.
 */
type Matcher = (content: string) => Iterable<MatchedLine>

interface MatchedLine {
  readonly lineNo: number // 1-based
  readonly text: string
}

function buildMatcher(pattern: string, opts: MatcherOpts): Matcher {
  if (opts.multiline) {
    // Validate regex eagerly so we surface a clear error.
    const flags = `g${opts.caseSensitive ? '' : 'i'}s` // s = dotall
    const re = new RegExp(pattern, flags)
    return function* multilineMatcher(content) {
      // Find each match, then expand to the set of lines it spans.
      // Re-instantiate per call so lastIndex doesn't leak across files.
      const localRe = new RegExp(re.source, re.flags)
      const lineStarts = computeLineStarts(content)
      const seen = new Set<number>()
      let m: RegExpExecArray | null
      while ((m = localRe.exec(content)) !== null) {
        const startLine = lineNoForOffset(lineStarts, m.index)
        const endLine = lineNoForOffset(lineStarts, m.index + Math.max(0, m[0].length - 1))
        for (let ln = startLine; ln <= endLine; ln++) {
          if (seen.has(ln)) continue
          seen.add(ln)
          yield { lineNo: ln, text: extractLine(content, lineStarts, ln) }
        }
        // Avoid zero-length infinite loop
        if (m.index === localRe.lastIndex) localRe.lastIndex++
      }
    }
  }

  if (opts.regex) {
    const flags = opts.caseSensitive ? '' : 'i'
    const re = new RegExp(pattern, flags)
    return function* regexMatcher(content) {
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          yield { lineNo: i + 1, text: lines[i]! }
        }
      }
    }
  }

  const needle = opts.caseSensitive ? pattern : pattern.toLowerCase()
  return function* literalMatcher(content) {
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const hay = opts.caseSensitive ? lines[i]! : lines[i]!.toLowerCase()
      if (hay.includes(needle)) {
        yield { lineNo: i + 1, text: lines[i]! }
      }
    }
  }
}

function computeLineStarts(content: string): number[] {
  const starts = [0]
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) starts.push(i + 1)
  }
  return starts
}

/** Binary search: returns 1-based line number containing the given offset. */
function lineNoForOffset(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (starts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

function extractLine(content: string, starts: number[], lineNo: number): string {
  const start = starts[lineNo - 1]!
  const end = lineNo < starts.length ? starts[lineNo]! - 1 : content.length
  return content.slice(start, end)
}

function truncateLine(line: string, maxLen: number): string {
  if (maxLen <= 0 || line.length <= maxLen) return line
  return line.slice(0, maxLen) + ` … [+${line.length - maxLen} chars truncated]`
}

function grepDone(state: GrepState): boolean {
  return state.matches.length >= state.maxResults || state.capped
}

async function searchFile(
  filePath: string,
  matcher: Matcher,
  state: GrepState,
  root: string,
): Promise<void> {
  if (grepDone(state)) return

  // Security: skip sensitive files in grep results
  if (isSensitiveFile(filePath)) return

  let content: string
  try {
    content = await fs.readFile(filePath, 'utf-8')
  } catch {
    return // skip binary/unreadable files
  }

  // Skip likely binary files
  if (content.includes('\0')) return

  const relative = path.relative(path.dirname(root), filePath)
  for (const m of matcher(content)) {
    if (grepDone(state)) return
    const truncated = truncateLine(m.text, state.maxLineLength)
    const line = `${relative}:${m.lineNo}: ${truncated}`
    // +1 for newline that will be added when joining
    if (state.bytes + line.length + 1 > state.maxBytes) {
      state.capped = true
      return
    }
    state.matches.push(line)
    state.bytes += line.length + 1
  }
}

async function searchDirectory(
  dir: string,
  root: string,
  matcher: Matcher,
  state: GrepState,
  globRegex: RegExp | null,
  includeHidden: boolean,
): Promise<void> {
  if (grepDone(state)) return

  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (grepDone(state)) return
    const fullPath = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      if (isAlwaysPrunedDir(entry.name)) continue
      if (!includeHidden && entry.name.startsWith('.')) continue
      await searchDirectory(fullPath, root, matcher, state, globRegex, includeHidden)
    } else {
      if (!includeHidden && entry.name.startsWith('.')) continue
      if (globRegex) {
        const rel = path.relative(root, fullPath)
        if (!globRegex.test(rel) && !globRegex.test(entry.name)) continue
      }
      await searchFile(fullPath, matcher, state, root)
    }
  }
}

// ---------------------------------------------------------------------------
// Export all filesystem tools
// ---------------------------------------------------------------------------

export const filesystemTools: Tool[] = [
  readFile,
  writeFile,
  editFile,
  listFiles,
  glob,
  grep,
]
