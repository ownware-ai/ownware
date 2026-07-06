/**
 * Per-profile private helper resolution.
 *
 * A profile may carry a `helpers/<name>/` subdirectory that contains
 * another full profile (with its own `agent.json`, `SOUL.md`, etc.).
 * These nested profiles are scoped to the enclosing parent — they are
 * NOT registered globally, so the global discovery walker never sees
 * them, and only the parent can spawn them.
 *
 * The agent.json `subagents[]` array remains the security boundary —
 * a parent must explicitly declare what it can spawn. This module just
 * answers "given a parent dir + a subagent name, where does the helper
 * live?" — the resolver in run.ts uses it as the first lookup step
 * before falling back to the global registry.
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { loadProfile, type LoadedProfile } from './loader.js'

/**
 * If `<parentDir>/helpers/<name>/agent.json` (or `.yaml`/`.yml`) exists,
 * return the absolute path to that helper directory. Otherwise return
 * `null` and the caller falls back to the global registry.
 *
 * The check is name-only: caller has already validated the subagent is
 * declared in the parent's `subagents[]`. We don't rescan the helpers/
 * dir or maintain an index.
 */
export async function resolveLocalHelperDir(
  parentDir: string,
  helperName: string,
): Promise<string | null> {
  // Defensive: refuse names that could traverse out of helpers/.
  if (!isSafeHelperName(helperName)) return null

  const helperDir = join(parentDir, 'helpers', helperName)
  for (const filename of ['agent.json', 'agent.yaml', 'agent.yml']) {
    if (await fileExists(join(helperDir, filename))) {
      return helperDir
    }
  }
  return null
}

/**
 * Load a local helper as a full `LoadedProfile`. Same loader the global
 * registry uses, so SOUL.md / AGENTS.md / skills / custom tools / Zod
 * validation all behave identically. The caller passes the returned
 * profile into `resolveSubagentDef` exactly as if it had come from the
 * registry.
 *
 * Throws the same errors `loadProfile` throws — caller treats a load
 * failure as a configuration error (not a missing-helper error).
 */
export async function loadLocalHelperProfile(helperDir: string): Promise<LoadedProfile> {
  return loadProfile(helperDir)
}

function isSafeHelperName(name: string): boolean {
  if (name.length === 0 || name.length > 64) return false
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false
  if (name.startsWith('.')) return false
  return /^[A-Za-z0-9._-]+$/.test(name)
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p)
    return s.isFile()
  } catch {
    return false
  }
}
