/**
 * Memory Loader
 *
 * Reads memory files (AGENTS.md) from configured sources, caches the
 * loaded content, and layers multiple sources so later entries override.
 */

import { readFile } from 'node:fs/promises'
import type { MemorySource, MemoryEntry } from './types.js'

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** In-memory cache keyed by file path */
const cache = new Map<string, { content: string; loadedAt: number; mtime: number }>()

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load memory entries from multiple sources.
 *
 * Sources are loaded in order. Later sources logically override earlier ones
 * (the consumer decides how to merge). Results are cached by file path;
 * cache is invalidated when the file's mtime changes.
 *
 * Files that don't exist or can't be read are silently skipped.
 *
 * @param sources - Ordered list of memory sources
 * @returns Array of loaded memory entries (same order as sources, missing files omitted)
 */
export async function loadMemory(sources: readonly MemorySource[]): Promise<MemoryEntry[]> {
  const entries: MemoryEntry[] = []

  // Load all sources concurrently
  const results = await Promise.allSettled(
    sources.map(source => loadSingle(source)),
  )

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value !== null) {
      entries.push(result.value)
    }
  }

  return entries
}

/**
 * Clear the memory loader cache.
 * Useful for testing or when you know files have changed.
 */
export function clearMemoryCache(): void {
  cache.clear()
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function loadSingle(source: MemorySource): Promise<MemoryEntry | null> {
  try {
    const { stat } = await import('node:fs/promises')
    const stats = await stat(source.path)
    const mtime = stats.mtimeMs

    // Check cache
    const cached = cache.get(source.path)
    if (cached && cached.mtime === mtime) {
      return {
        source,
        content: cached.content,
        loadedAt: cached.loadedAt,
      }
    }

    // Read file
    const content = await readFile(source.path, 'utf-8')
    const loadedAt = Date.now()

    // Update cache
    cache.set(source.path, { content, loadedAt, mtime })

    return { source, content, loadedAt }
  } catch {
    // File doesn't exist or can't be read — skip silently
    return null
  }
}

/**
 * Layer memory entries: later entries with the same source path override earlier ones.
 * Returns a deduplicated array with only the latest entry per path.
 *
 * @param entries - Memory entries in source order
 * @returns Deduplicated entries (last wins)
 */
export function layerMemoryEntries(entries: MemoryEntry[]): MemoryEntry[] {
  const byPath = new Map<string, MemoryEntry>()
  for (const entry of entries) {
    byPath.set(entry.source.path, entry)
  }
  return Array.from(byPath.values())
}
