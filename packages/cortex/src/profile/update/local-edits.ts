/**
 * Detect whether the user has edited an installed profile dir since
 * install time.
 *
 * Strategy: hash the current dir contents, compare to the
 * `installedHash` recorded in the github-source sidecar.
 *
 * Returns:
 *   - `'unmodified'` — current hash matches the recorded one
 *   - `'modified'`   — current hash differs from the recorded one
 *   - `'unknown'`    — sidecar has no `installedHash` (legacy install,
 *                      pre-Phase-2). The update path treats this as
 *                      "we can't tell" and conservatively offers the
 *                      three-way merge dialog so we don't blast over
 *                      possible local edits.
 *   - `'not-tracked'` — sidecar isn't `kind: 'github'`. Forks and
 *                       builtin-bundles don't get this check; their
 *                       update story is handled elsewhere.
 *   - `'no-sidecar'`  — dir has no sidecar at all (manually placed).
 *                       Treated as "we can't tell."
 */

import { hashProfileDir } from '../dir-hash.js'
import type { OriginSidecar } from '../registry.js'

export type LocalEditsState =
  | 'unmodified'
  | 'modified'
  | 'unknown'
  | 'not-tracked'
  | 'no-sidecar'

export async function detectLocalEdits(
  profileDir: string,
  sidecar: OriginSidecar | null,
): Promise<LocalEditsState> {
  if (sidecar === null) return 'no-sidecar'
  if (sidecar.kind !== 'github') return 'not-tracked'
  if (sidecar.installedHash === undefined) return 'unknown'
  const current = await hashProfileDir(profileDir)
  return current === sidecar.installedHash ? 'unmodified' : 'modified'
}
