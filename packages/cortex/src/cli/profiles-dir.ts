/**
 * Shared profile-directory discovery for the `ownware` CLI verbs.
 *
 * Priority is YOUR profiles first: a `./profiles` in the working directory
 * wins over the bundled marketplace, so `ownware profile new`, `ownware profile
 * list`, and `ownware run` all agree on the same set — the one you're building.
 * The bundled profiles are the fallback for a fresh directory that has none
 * (so `ownware run adam` still works out of the box from an empty folder).
 */

import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

/** Where to READ profiles from (yours first, bundled marketplace as fallback). */
export function findProfilesDir(cwd: string = process.cwd()): string {
  const here = import.meta.dirname ?? '.'
  const candidates = [
    resolve(cwd, 'profiles'), // your project's profiles — always win
    resolve(cwd, 'packages', 'cortex', 'profiles'), // monorepo root convenience
    resolve(here, '..', '..', 'profiles'), // bundled marketplace (dist/cli → pkg/profiles)
  ]
  for (const dir of candidates) {
    if (existsSync(dir)) return dir
  }
  return resolve(cwd, 'profiles')
}

/**
 * Where `ownware profile new/set/remove/open` WRITE — always the local project's
 * `./profiles`, never the bundled marketplace (which is read-only and shipped
 * inside the package).
 */
export function localProfilesDir(cwd: string = process.cwd()): string {
  return resolve(cwd, 'profiles')
}
