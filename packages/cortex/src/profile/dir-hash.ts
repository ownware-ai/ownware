/**
 * Deterministic SHA-256 of a profile directory.
 *
 * Used by:
 *   - registry.ts forkBuiltin — record `forkedAtHash` to detect upstream
 *     drift on a builtin
 *   - install-from-github.ts — record `installedHash` so update detection
 *     can decide if the user has local edits since install
 *   - update/local-edits.ts — compare current dir vs. recorded hash
 *
 * Algorithm:
 *   - Walk the dir recursively, file by file
 *   - Skip the sidecar file (it's metadata, not content)
 *   - Sort by relative path so order doesn't depend on fs walk order
 *   - For each file, hash `<rel>\0<bytes>\0`
 *
 * Output is a 64-char lowercase hex string.
 *
 * Errors are intentionally swallowed for a single unreadable file —
 * hashing a profile dir must never throw on a stray symlink loop or
 * permission glitch. The cost of swallowing is "two hashes might agree
 * even though one had an unreadable file"; in practice the install
 * pipeline runs validateTree first which already rejects such anomalies.
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ORIGIN_SIDECAR_FILE } from './registry.js'

export async function hashProfileDir(dirPath: string): Promise<string> {
  const files: Array<{ rel: string; bytes: Buffer }> = []
  await collect(dirPath, '', files)
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const hash = createHash('sha256')
  for (const f of files) {
    hash.update(f.rel, 'utf-8')
    hash.update('\0')
    hash.update(f.bytes)
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function collect(
  base: string,
  prefix: string,
  out: Array<{ rel: string; bytes: Buffer }>,
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(base)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry === ORIGIN_SIDECAR_FILE) continue
    const full = join(base, entry)
    const rel = prefix === '' ? entry : `${prefix}/${entry}`
    let s
    try { s = await stat(full) } catch { continue }
    if (s.isDirectory()) {
      await collect(full, rel, out)
    } else if (s.isFile()) {
      try {
        const bytes = await readFile(full)
        out.push({ rel, bytes })
      } catch { /* unreadable file — skip */ }
    }
  }
}
