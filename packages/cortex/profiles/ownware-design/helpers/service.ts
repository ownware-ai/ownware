/**
 * Design-systems service — caching layer over `scanner.ts`.
 *
 * Both tool files (`tools/list-design-systems.ts` and
 * `tools/apply-design-system.ts`) share ONE service instance via
 * `getDesignSystemsService()`. The singleton is initialised lazily on
 * the first call and lives for the lifetime of the Cortex process —
 * so a session that calls `list` then `apply` pays the disk-scan cost
 * once, not twice.
 *
 * Cache strategy:
 *   - `list()` results cached for the lifetime of the service.
 *   - `apply(id)` results cached per-id, lifetime of the service.
 *   - `invalidate()` resets both caches; a future filesystem-watcher
 *     wire-up in the gateway can call this on catalog changes.
 *
 * One-shot startup diagnostic per process: when the service is first
 * resolved, it logs the entry count + warning count + catalog path to
 * stderr. Never logs values, never re-logs for the same path.
 */

import {
  loadEntry,
  scanCatalog,
  type DesignSystemEntry,
  type DesignSystemSummary,
  type ScanResult,
  type ScanWarning,
} from './scanner.ts'
// `.ts` (not `.js`): this helper is loaded as SOURCE via Node type-strip
// (profiles aren't compiled) — a `.js` specifier 500s every `/run`. See CT-10.
import { resolveCatalogDir } from './catalog-path.ts'

export interface DesignSystemsServiceOptions {
  readonly catalogDir: string | null
  readonly logger?: (msg: string) => void
}

const loggedDirs = new Set<string>()

export class DesignSystemsService {
  private readonly catalogDir: string | null
  private readonly logger: (msg: string) => void

  private scanCache: Promise<ScanResult> | null = null
  private readonly entryCache = new Map<string, Promise<DesignSystemEntry | null>>()

  constructor(opts: DesignSystemsServiceOptions) {
    this.catalogDir = opts.catalogDir
    this.logger = opts.logger ?? ((msg) => console.warn(msg))
  }

  async list(filter?: {
    readonly category?: DesignSystemSummary['category']
    readonly surface?: DesignSystemSummary['surface']
    readonly search?: string
    readonly limit?: number
  }): Promise<{
    readonly total: number
    readonly summaries: readonly DesignSystemSummary[]
    readonly warnings: readonly ScanWarning[]
    readonly catalogConfigured: boolean
  }> {
    const scan = await this.scan()
    let results: readonly DesignSystemSummary[] = scan.summaries

    if (filter?.category) {
      results = results.filter((s) => s.category === filter.category)
    }
    if (filter?.surface) {
      results = results.filter((s) => s.surface === filter.surface)
    }
    if (filter?.search && filter.search.trim()) {
      const needle = filter.search.trim().toLowerCase()
      results = results.filter(
        (s) =>
          s.id.includes(needle) ||
          s.name.toLowerCase().includes(needle) ||
          s.summary.toLowerCase().includes(needle),
      )
    }

    const total = results.length
    if (typeof filter?.limit === 'number' && filter.limit >= 0) {
      results = results.slice(0, filter.limit)
    }

    return {
      total,
      summaries: results,
      warnings: scan.warnings,
      catalogConfigured: this.catalogDir !== null,
    }
  }

  async apply(id: string): Promise<DesignSystemEntry | null> {
    if (this.catalogDir === null) return null

    const cached = this.entryCache.get(id)
    if (cached) return cached

    const promise = loadEntry(this.catalogDir, id)
    this.entryCache.set(id, promise)
    return promise
  }

  invalidate(): void {
    this.scanCache = null
    this.entryCache.clear()
  }

  getCatalogDir(): string | null {
    return this.catalogDir
  }

  private async scan(): Promise<ScanResult> {
    if (this.catalogDir === null) {
      return { summaries: [], warnings: [] }
    }
    if (!this.scanCache) {
      this.scanCache = scanCatalog(this.catalogDir).then((result) => {
        const dirKey = this.catalogDir ?? '(none)'
        if (!loggedDirs.has(dirKey)) {
          loggedDirs.add(dirKey)
          this.logger(
            `[ownware-design] catalog ${dirKey}: ${result.summaries.length} entries, ${result.warnings.length} warnings`,
          )
          for (const w of result.warnings) {
            this.logger(`[ownware-design]   ! ${w.folder}: ${w.reason}`)
          }
        }
        return result
      })
    }
    return this.scanCache
  }
}

// ───────────────────────────────────────────────────────────────────────
// Singleton — both tool files share this one service instance.
// ───────────────────────────────────────────────────────────────────────

let singleton: DesignSystemsService | null = null

export function getDesignSystemsService(): DesignSystemsService {
  if (!singleton) {
    singleton = new DesignSystemsService({
      catalogDir: resolveCatalogDir(),
    })
  }
  return singleton
}
