/**
 * Resolve the design-systems catalog directory for the running profile.
 *
 * The catalog is shipped INSIDE the ownware-design profile as a sibling
 * subdirectory of `tools/` and `helpers/`. Both tool files and any future
 * helper that needs the path use this resolver instead of doing their
 * own path math.
 *
 * Resolution order (first that exists wins):
 *
 *   1. `OWNWARE_DESIGN_CATALOG_DIR` env var, if set. The marketplace
 *      installer (or a power user) can point the catalog elsewhere
 *      without editing tool code — useful for shared dev setups.
 *   2. `<profile-dir>/design-systems/` — the canonical install layout.
 *      Resolved relative to this file's own location:
 *        helpers/catalog-path.ts  →  ../design-systems
 *
 * Returns `null` when neither path resolves to an existing directory.
 * Tools surface a "catalog not configured" error in that case rather
 * than throwing — see `tools/*.ts`.
 */

import { existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export function resolveCatalogDir(): string | null {
  const fromEnv = process.env['OWNWARE_DESIGN_CATALOG_DIR']
  if (fromEnv && isDirectory(fromEnv)) {
    return fromEnv
  }

  // Canonical install layout: profile ships the catalog as a sibling of
  // tools/ and helpers/. From helpers/catalog-path.ts, that's one level up
  // and into design-systems/.
  const bundled = resolve(HERE, '..', 'design-systems')
  if (isDirectory(bundled)) {
    return bundled
  }

  return null
}

function isDirectory(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory()
  } catch {
    return false
  }
}
