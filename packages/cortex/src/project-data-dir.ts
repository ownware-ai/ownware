/**
 * The project-local `.ownware/` directory — and why it ignores itself.
 *
 * Some artifacts are deliberately written into the USER'S PROJECT rather
 * than the data dir: plans (`.ownware/plans`) are about the repo, and a
 * profile selecting the `file` checkpoint store with no explicit `dir`
 * gets `.ownware/checkpoints`. That placement is intentional (see
 * `constants.ts`).
 *
 * The problem is what happens next in a real repo. A tool-using run
 * drops checkpoint JSON — which contains the whole conversation — into
 * the project, where it shows up as untracked and `git add -A` commits
 * it. Transcripts then travel to whatever remote the customer pushes to.
 * (Found by the CLI journey harness: FINDINGS F11.)
 *
 * The fix keeps the deliberate placement and removes the hazard: the
 * directory carries a `.gitignore` of `*`, so it ignores its own
 * contents AND itself. Git never sees any of it, no matter what the
 * customer's own `.gitignore` says — the same "invisible working
 * directory" property `.git` has, and the reason this does not depend on
 * every customer remembering to add a rule.
 *
 * Deliberately not in the engine: it takes a plain directory path and has no
 * concept of `.ownware`, projects, or git. The kernel owns that.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_DATA_DIR_NAME } from './constants.js'

const IGNORE_FILE = '.gitignore'

/**
 * `*` ignores every entry in the directory, including this file, so the
 * whole directory is invisible to git. `!.gitignore` is deliberately NOT
 * used: we want the directory untracked entirely, not tracked-but-empty.
 */
const IGNORE_BODY = `# Ownware writes machine-local state here (checkpoints, plans).
# Checkpoints contain full conversation transcripts — never commit them.
# '*' ignores this file too, so the whole directory stays invisible to git.
*
`

/**
 * Ensure `<projectRoot>/.ownware/` exists and cannot be committed.
 *
 * Idempotent, and it never overwrites an existing `.gitignore` — a user
 * who has deliberately edited it keeps their version.
 *
 * Returns the absolute path to the directory.
 */
export function ensureProjectDataDir(projectRoot: string = process.cwd()): string {
  const dir = join(projectRoot, DEFAULT_DATA_DIR_NAME)
  mkdirSync(dir, { recursive: true })
  const ignorePath = join(dir, IGNORE_FILE)
  if (!existsSync(ignorePath)) writeFileSync(ignorePath, IGNORE_BODY, 'utf-8')
  return dir
}
