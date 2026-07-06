/**
 * understanding-store — the on-disk home of the additive `profile.json` digest.
 *
 * The gatherer (and later ingest helpers) and the builder share a
 * `rootSessionId` (the Loom primitive every parent + sub-agent sees), so they
 * address the SAME location without passing anything through the model. Each
 * writer drops ONE slice file; the reader merges them. One-file-per-writer is
 * deliberate: scan tools are `isReadOnly` and may run in PARALLEL, so a shared
 * read-merge-write file would race — disjoint slice files never do.
 *
 *   <baseDir>/understanding/<rootSessionId>/slices/<key>.json   ← each writer's slice
 *
 * `baseDir` is a PARAMETER (never a hardcoded `~/.cortex`): desktop callers pass
 * `~/.ownware`, a future cloud helper passes its `dataDir`. Storage-agnostic.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { UnderstandingSliceSchema, mergeSlices } from './understanding.js'
import type { UnderstandingSlice } from './understanding.js'

/** Keep a session id path-safe (no traversal, bounded length). */
const safeKey = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'x'

function slicesDir(baseDir: string, rootSessionId: string): string {
  return join(baseDir, 'understanding', safeKey(rootSessionId), 'slices')
}

/**
 * Write one writer's slice. `key` identifies the writer (e.g. the scan/tool
 * name) so re-running it overwrites only its own slice — never another's.
 * Returns the path written.
 */
export function writeUnderstandingSlice(
  baseDir: string,
  rootSessionId: string,
  key: string,
  slice: UnderstandingSlice,
): string {
  const validated = UnderstandingSliceSchema.parse(slice)
  const file = join(slicesDir(baseDir, rootSessionId), `${safeKey(key)}.json`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(validated, null, 2))
  return file
}

/**
 * Read every slice for a session and merge them into one accumulator. Returns
 * null when nothing has been written yet. Slices are merged in a stable order;
 * a `judgment` slice (the gatherer's summary/voice) is applied LAST so its
 * scalars win over anything a scan happened to set.
 */
export function readUnderstanding(baseDir: string, rootSessionId: string): UnderstandingSlice | null {
  const dir = slicesDir(baseDir, rootSessionId)
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort((a, b) => {
      // judgment merges last; otherwise alphabetical for determinism.
      const aj = a.startsWith('judgment')
      const bj = b.startsWith('judgment')
      if (aj !== bj) return aj ? 1 : -1
      return a < b ? -1 : a > b ? 1 : 0
    })
  if (files.length === 0) return null
  let acc: UnderstandingSlice = {}
  let any = false
  for (const f of files) {
    try {
      const parsed = UnderstandingSliceSchema.safeParse(JSON.parse(readFileSync(join(dir, f), 'utf8')))
      if (parsed.success) {
        acc = mergeSlices(acc, parsed.data)
        any = true
      }
    } catch {
      // A corrupt slice file is skipped, not fatal — the rest still merge.
    }
  }
  return any ? acc : null
}

/** Absolute path of the slices directory — exposed for tests/cleanup. */
export function understandingSlicesDir(baseDir: string, rootSessionId: string): string {
  return slicesDir(baseDir, rootSessionId)
}
