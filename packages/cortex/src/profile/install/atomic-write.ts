/**
 * Atomic JSON write helper.
 *
 * Writes to `<path>.tmp` then `rename()` over the destination. On the
 * same filesystem, rename is atomic — readers see either the old file
 * or the new one, never a partial write. This matters for the sidecar:
 * if the gateway crashes mid-install, the sidecar is either valid or
 * absent, never a half-written JSON the registry can't parse.
 *
 * Lifted into its own file so the install pipeline doesn't pull in the
 * registry's atomicWrite (which is a private internal in registry.ts
 * and the install module shouldn't depend on its internals).
 */

import { rename, writeFile, unlink } from 'node:fs/promises'

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`
  const body = JSON.stringify(value, null, 2)
  try {
    await writeFile(tmp, body, { encoding: 'utf-8' })
    await rename(tmp, path)
  } catch (err) {
    try { await unlink(tmp) } catch { /* */ }
    throw err
  }
}
