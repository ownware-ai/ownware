/**
 * Local Backend
 *
 * BackendProtocol implementation backed by the local filesystem.
 * Uses Node.js fs/promises for all operations.
 */

import { readFile, writeFile, readdir, stat, access, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, resolve, join } from 'node:path'
import type {
  BackendProtocol,
  FileEntry,
  GrepResult,
  ExecResult,
  ReadFileOptions,
  ExecOptions,
} from './types.js'
import { BackendError } from './types.js'

// ---------------------------------------------------------------------------
// LocalBackend
// ---------------------------------------------------------------------------

export class LocalBackend implements BackendProtocol {
  private readonly root: string

  /**
   * @param root - Root directory for relative path resolution. Default: process.cwd()
   */
  constructor(root?: string) {
    this.root = root ?? process.cwd()
  }

  /** Get the root directory */
  getRoot(): string {
    return this.root
  }

  /**
   * Read file content with optional line offset and limit.
   * Returns numbered lines (cat -n style) when offset/limit used.
   */
  async readFile(path: string, opts?: ReadFileOptions): Promise<string> {
    const abs = this.resolvePath(path)
    let content: string
    try {
      content = await readFile(abs, 'utf-8')
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new BackendError(`File not found: ${path}`, 'NOT_FOUND', path)
      }
      throw err
    }

    if (opts?.offset !== undefined || opts?.limit !== undefined) {
      const lines = content.split('\n')
      const start = opts?.offset ?? 0
      const end = opts?.limit !== undefined ? start + opts.limit : lines.length
      return lines
        .slice(start, end)
        .map((line, i) => `${start + i + 1}\t${line}`)
        .join('\n')
    }

    return content
  }

  /** Write content to a file, creating parent directories as needed. */
  async writeFile(path: string, content: string): Promise<void> {
    const abs = this.resolvePath(path)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf-8')
  }

  /** Replace an exact string occurrence in a file. */
  async editFile(path: string, oldString: string, newString: string): Promise<void> {
    const abs = this.resolvePath(path)
    let content: string
    try {
      content = await readFile(abs, 'utf-8')
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new BackendError(`File not found: ${path}`, 'NOT_FOUND', path)
      }
      throw err
    }

    if (!content.includes(oldString)) {
      throw new BackendError(
        `String not found in ${path}: "${oldString.slice(0, 80)}${oldString.length > 80 ? '...' : ''}"`,
        'EDIT_MISMATCH',
        path,
      )
    }

    await writeFile(abs, content.replace(oldString, newString), 'utf-8')
  }

  /** List directory entries with metadata. */
  async listFiles(path: string): Promise<FileEntry[]> {
    const abs = this.resolvePath(path)
    let names: string[]
    try {
      names = await readdir(abs)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new BackendError(`Directory not found: ${path}`, 'NOT_FOUND', path)
      }
      throw err
    }

    const entries = await Promise.all(
      names.map(async (name): Promise<FileEntry> => {
        const full = join(abs, name)
        try {
          const s = await stat(full)
          return { name, path: full, isDirectory: s.isDirectory(), size: s.size, modifiedAt: s.mtimeMs }
        } catch {
          // Race: dirent listed in readdir but its stat failed (deleted
          // between calls, perm denied, or a broken symlink). Returning
          // a placeholder is preferable to dropping the whole listing —
          // the consumer can still show the name; metadata is best-effort.
          return { name, path: full, isDirectory: false, size: 0, modifiedAt: 0 }
        }
      }),
    )

    return entries.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Glob for files matching a pattern. Uses Node.js 22+ built-in glob. */
  async glob(pattern: string, path?: string): Promise<string[]> {
    const cwd = path ? this.resolvePath(path) : this.root
    const { glob: nodeGlob } = await import('node:fs/promises')
    const matches: string[] = []
    for await (const entry of nodeGlob(pattern, { cwd })) {
      matches.push(resolve(cwd, entry))
    }
    return matches.sort()
  }

  /** Search files for a pattern (case-insensitive literal match). */
  async grep(pattern: string, path?: string, globFilter?: string): Promise<GrepResult[]> {
    const searchDir = path ? this.resolvePath(path) : this.root
    const files = globFilter
      ? await this.glob(globFilter, searchDir)
      : await this.collectFiles(searchDir)

    const results: GrepResult[] = []
    const lower = pattern.toLowerCase()

    for (const filePath of files) {
      try {
        const content = await readFile(filePath, 'utf-8')
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]?.toLowerCase().includes(lower)) {
            results.push({ path: filePath, lineNumber: i + 1, content: lines[i] ?? '' })
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    return results
  }

  /** Check if a path exists. */
  async exists(path: string): Promise<boolean> {
    try {
      await access(this.resolvePath(path))
      return true
    } catch {
      // The whole point of `exists` is to return a boolean — any access
      // failure (ENOENT, EACCES, broken symlink) means "not reachable
      // from here," which is the same answer the caller needs.
      return false
    }
  }

  /** Execute a shell command with timeout and abort support. */
  async execute(command: string, opts?: ExecOptions): Promise<ExecResult> {
    const timeout = opts?.timeout ?? 120_000
    const cwd = opts?.cwd ?? this.root

    return new Promise<ExecResult>((res, rej) => {
      const child = spawn('sh', ['-c', command], {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let settled = false
      let timer: ReturnType<typeof setTimeout>

      // Settle exactly once. The timeout/abort paths reject IMMEDIATELY instead
      // of waiting for 'close': a killed shell can leave an orphaned grandchild
      // (e.g. `sh -c "sleep 10"` that forked) holding the stdout/stderr pipe
      // open, so 'close' may not fire until that orphan exits — long past the
      // timeout. Rejecting on the timer keeps the timeout deterministic and
      // non-hanging, instead of racing a 'close' that may never come in time.
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }

      timer = setTimeout(() => {
        child.kill('SIGKILL')
        settle(() => rej(new BackendError(`Command timed out: ${command.slice(0, 80)}`, 'TIMEOUT')))
      }, timeout)

      if (opts?.signal) {
        opts.signal.addEventListener(
          'abort',
          () => {
            child.kill('SIGKILL')
            settle(() => rej(new BackendError(`Command timed out: ${command.slice(0, 80)}`, 'TIMEOUT')))
          },
          { once: true },
        )
      }

      child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

      child.on('close', (code) => {
        settle(() => res({ stdout, stderr, exitCode: code ?? 1 }))
      })

      child.on('error', (err) => {
        settle(() => rej(new BackendError(`Exec failed: ${err.message}`, 'EXEC_FAILED')))
      })
    })
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private resolvePath(path: string): string {
    return path.startsWith('/') ? path : resolve(this.root, path)
  }

  /** Recursively collect file paths (max 1000, skip hidden dirs and node_modules). */
  private async collectFiles(dir: string, max = 1000): Promise<string[]> {
    const result: string[] = []
    const queue = [dir]

    while (queue.length > 0 && result.length < max) {
      const current = queue.shift()!
      try {
        const entries = await readdir(current, { withFileTypes: true })
        for (const e of entries) {
          const full = join(current, e.name)
          if (e.isDirectory()) {
            if (!e.name.startsWith('.') && e.name !== 'node_modules') queue.push(full)
          } else {
            result.push(full)
          }
        }
      } catch { /* skip */ }
    }

    return result
  }
}
