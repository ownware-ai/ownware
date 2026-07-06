/**
 * Filesystem scanner for the profile-local design-system catalog.
 *
 * Pure module — takes a directory path, returns parsed entries. No
 * caching, no side effects beyond `fs.readdir` / `fs.readFile`. The
 * `service.ts` wrapper layers caching + invalidation on top.
 *
 * Failure handling per Ownware Principle 1 (no silent failures): an
 * invalid entry is dropped from the result set AND its reason is
 * returned alongside as a warning, so the service can surface it.
 * The scanner never throws on a single bad folder — one malformed
 * entry must not brick the rest of the catalog.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  DesignSystemManifestSchema,
  type DesignSystemManifest,
} from './manifest.schema.js'

export interface DesignSystemEntry {
  readonly manifest: DesignSystemManifest
  readonly designMd: string
  readonly tokensCss: string
  /** The `:root { ... }` block extracted from tokensCss for paste-ready use. */
  readonly rootBlock: string
}

export interface DesignSystemSummary {
  readonly id: string
  readonly name: string
  readonly category: DesignSystemManifest['category']
  readonly surface: DesignSystemManifest['surface']
  readonly summary: string
  readonly swatches: readonly string[]
}

export interface ScanWarning {
  readonly folder: string
  readonly reason: string
}

export interface ScanResult {
  readonly summaries: readonly DesignSystemSummary[]
  readonly warnings: readonly ScanWarning[]
}

export async function scanCatalog(catalogDir: string): Promise<ScanResult> {
  const summaries: DesignSystemSummary[] = []
  const warnings: ScanWarning[] = []

  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(catalogDir, { withFileTypes: true })
  } catch {
    return { summaries, warnings }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue

    const folder = entry.name
    const manifestPath = path.join(catalogDir, folder, 'manifest.json')

    const manifestRaw = await safeReadFile(manifestPath)
    if (manifestRaw === null) continue // not a catalog entry; silent skip

    let parsed: unknown
    try {
      parsed = JSON.parse(manifestRaw)
    } catch (err) {
      warnings.push({
        folder,
        reason: `manifest.json is not valid JSON: ${(err as Error).message}`,
      })
      continue
    }

    const result = DesignSystemManifestSchema.safeParse(parsed)
    if (!result.success) {
      const first = result.error.issues[0]
      const where = first?.path.join('.') ?? 'manifest'
      warnings.push({
        folder,
        reason: `manifest.json failed validation at ${where}: ${first?.message ?? 'unknown error'}`,
      })
      continue
    }

    const manifest = result.data
    if (manifest.id !== folder) {
      warnings.push({
        folder,
        reason: `manifest.id "${manifest.id}" does not match folder name "${folder}"`,
      })
      continue
    }

    summaries.push({
      id: manifest.id,
      name: manifest.name,
      category: manifest.category,
      surface: manifest.surface,
      summary: manifest.summary,
      swatches: manifest.swatches,
    })
  }

  return { summaries, warnings }
}

export async function loadEntry(
  catalogDir: string,
  id: string,
): Promise<DesignSystemEntry | null> {
  if (!/^[a-z0-9-]+$/.test(id)) return null

  const folder = path.join(catalogDir, id)

  const stats = await safeStat(folder)
  if (!stats || !stats.isDirectory()) return null

  const manifestRaw = await safeReadFile(path.join(folder, 'manifest.json'))
  if (manifestRaw === null) return null

  let manifestParsed: unknown
  try {
    manifestParsed = JSON.parse(manifestRaw)
  } catch {
    return null
  }
  const parsed = DesignSystemManifestSchema.safeParse(manifestParsed)
  if (!parsed.success) return null
  const manifest = parsed.data
  if (manifest.id !== id) return null

  const designMd = await safeReadFile(path.join(folder, manifest.files.design))
  const tokensCss = await safeReadFile(path.join(folder, manifest.files.tokens))
  if (designMd === null || tokensCss === null) return null

  return {
    manifest,
    designMd,
    tokensCss,
    rootBlock: extractRootBlock(tokensCss),
  }
}

/**
 * Extract the first `:root { ... }` block from a CSS string.
 *
 * Brace-counted to handle nested-rule-looking content gracefully.
 * Returns the empty string when no `:root` block is found — never throws.
 */
export function extractRootBlock(css: string): string {
  const start = css.search(/:root\s*\{/)
  if (start < 0) return ''
  const openBrace = css.indexOf('{', start)
  if (openBrace < 0) return ''

  let depth = 1
  let i = openBrace + 1
  while (i < css.length && depth > 0) {
    const c = css[i]
    if (c === '{') depth += 1
    else if (c === '}') depth -= 1
    i += 1
  }
  if (depth !== 0) return ''

  return css.slice(start, i).trim()
}

async function safeReadFile(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8')
  } catch {
    return null
  }
}

async function safeStat(p: string): Promise<import('node:fs').Stats | null> {
  try {
    return await stat(p)
  } catch {
    return null
  }
}
