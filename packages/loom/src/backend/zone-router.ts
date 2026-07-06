/**
 * Zone Router
 *
 * Routes filesystem operations to the correct backend based on path prefix.
 * Supports multiple zones with different permissions (ro/rw).
 * Uses longest prefix match for routing.
 */

import type {
  BackendProtocol,
  FileEntry,
  GrepResult,
  ExecResult,
  ReadFileOptions,
  ExecOptions,
  Zone,
} from './types.js'
import { BackendError } from './types.js'

// ---------------------------------------------------------------------------
// ZoneRouter
// ---------------------------------------------------------------------------

export class ZoneRouter implements BackendProtocol {
  private readonly zones: Zone[]

  /**
   * @param zones - Filesystem zones. Internally sorted by path length (longest first).
   */
  constructor(zones: Zone[]) {
    this.zones = [...zones].sort((a, b) => b.path.length - a.path.length)
  }

  async readFile(path: string, opts?: ReadFileOptions): Promise<string> {
    const { backend, localPath } = this.route(path)
    return backend.readFile(localPath, opts)
  }

  async writeFile(path: string, content: string): Promise<void> {
    const { backend, localPath, zone } = this.route(path)
    this.assertWritable(zone, path)
    return backend.writeFile(localPath, content)
  }

  async editFile(path: string, oldString: string, newString: string): Promise<void> {
    const { backend, localPath, zone } = this.route(path)
    this.assertWritable(zone, path)
    return backend.editFile(localPath, oldString, newString)
  }

  async listFiles(path: string): Promise<FileEntry[]> {
    const { backend, localPath } = this.route(path)
    return backend.listFiles(localPath)
  }

  async glob(pattern: string, path?: string): Promise<string[]> {
    const { backend, localPath } = this.route(path ?? '/')
    return backend.glob(pattern, localPath)
  }

  async grep(pattern: string, path?: string, glob?: string): Promise<GrepResult[]> {
    const { backend, localPath } = this.route(path ?? '/')
    return backend.grep(pattern, localPath, glob)
  }

  async exists(path: string): Promise<boolean> {
    const { backend, localPath } = this.route(path)
    return backend.exists(localPath)
  }

  async execute(command: string, opts?: ExecOptions): Promise<ExecResult> {
    const rootZone = this.zones.find(z => z.path === '/') ?? this.zones[this.zones.length - 1]
    if (!rootZone) {
      throw new BackendError('No zones configured', 'EXEC_FAILED')
    }
    if (!rootZone.backend.execute) {
      throw new BackendError('Execute not supported by this backend', 'EXEC_FAILED')
    }
    this.assertWritable(rootZone, '/')
    return rootZone.backend.execute(command, opts)
  }

  /** Get all configured zones */
  getZones(): readonly Zone[] {
    return this.zones
  }

  /** Find which zone owns a path */
  findZone(path: string): Zone | undefined {
    const norm = normalize(path)
    return this.zones.find(z => norm.startsWith(normalize(z.path)))
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private route(path: string): { backend: BackendProtocol; localPath: string; zone: Zone } {
    const norm = normalize(path)

    for (const zone of this.zones) {
      const prefix = normalize(zone.path)
      if (norm === prefix || norm.startsWith(prefix + '/') || prefix === '/') {
        let localPath = prefix === '/' ? norm : norm.slice(prefix.length)
        if (!localPath.startsWith('/')) localPath = '/' + localPath
        return { backend: zone.backend, localPath, zone }
      }
    }

    throw new BackendError(`No zone configured for path: ${path}`, 'INVALID_PATH', path)
  }

  private assertWritable(zone: Zone, path: string): void {
    if (zone.permission === 'ro') {
      throw new BackendError(
        `Write denied: zone "${zone.path}" is read-only`,
        'PERMISSION_DENIED',
        path,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalize(p: string): string {
  if (p === '/') return '/'
  return p.endsWith('/') ? p.slice(0, -1) : p
}
