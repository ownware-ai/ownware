/**
 * Sandbox Backend
 *
 * Wraps any BackendProtocol with security enforcement:
 * - Prevents path traversal (../)
 * - Restricts operations to a root directory
 * - Blocks access to sensitive files (.env, credentials, keys)
 */

import { resolve, relative } from 'node:path'
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
// Sensitive file patterns
// ---------------------------------------------------------------------------

const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /\.env$/,
  /\.env\..+$/,
  /credentials\.json$/,
  /\.pem$/,
  /\.key$/,
  /id_rsa/,
  /id_ed25519/,
  /\.secrets/,
  /\.aws\/credentials/,
  /\.ssh\/config/,
  /\.netrc$/,
  /secret[_-]?key/i,
  /\.secrets\.baseline$/,
]

// ---------------------------------------------------------------------------
// SandboxBackend
// ---------------------------------------------------------------------------

export class SandboxBackend implements BackendProtocol {
  private readonly inner: BackendProtocol
  private readonly root: string

  /**
   * @param inner - The underlying backend to delegate to
   * @param root - Absolute root directory. All paths must resolve within this.
   */
  constructor(inner: BackendProtocol, root: string) {
    this.inner = inner
    this.root = resolve(root)
  }

  async readFile(path: string, opts?: ReadFileOptions): Promise<string> {
    return this.inner.readFile(this.validate(path), opts)
  }

  async writeFile(path: string, content: string): Promise<void> {
    return this.inner.writeFile(this.validate(path), content)
  }

  async editFile(path: string, oldString: string, newString: string): Promise<void> {
    return this.inner.editFile(this.validate(path), oldString, newString)
  }

  async listFiles(path: string): Promise<FileEntry[]> {
    return this.inner.listFiles(this.validate(path))
  }

  async glob(pattern: string, path?: string): Promise<string[]> {
    const safePath = path ? this.validate(path) : undefined
    return this.inner.glob(pattern, safePath)
  }

  async grep(pattern: string, path?: string, glob?: string): Promise<GrepResult[]> {
    const safePath = path ? this.validate(path) : undefined
    return this.inner.grep(pattern, safePath, glob)
  }

  async exists(path: string): Promise<boolean> {
    return this.inner.exists(this.validate(path))
  }

  async execute(command: string, opts?: ExecOptions): Promise<ExecResult> {
    if (!this.inner.execute) {
      throw new BackendError('Execute not supported', 'EXEC_FAILED')
    }
    // Validate cwd if provided
    const safeOpts = opts?.cwd ? { ...opts, cwd: this.validate(opts.cwd) } : opts
    return this.inner.execute(command, safeOpts)
  }

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  /**
   * Validate and resolve a path, ensuring it stays within the sandbox root.
   * Throws BackendError on path traversal or sensitive file access.
   */
  private validate(path: string): string {
    const abs = resolve(this.root, path)
    const rel = relative(this.root, abs)

    // Path traversal check: relative path must not escape root
    if (rel.startsWith('..') || rel.startsWith('/')) {
      throw new BackendError(
        `Path traversal blocked: "${path}" escapes sandbox root`,
        'PATH_TRAVERSAL',
        path,
      )
    }

    // Sensitive file check
    if (isSensitive(abs)) {
      throw new BackendError(
        `Access to sensitive file blocked: "${path}"`,
        'SENSITIVE_FILE',
        path,
      )
    }

    return abs
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a path matches any sensitive file pattern */
function isSensitive(path: string): boolean {
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(path))
}
