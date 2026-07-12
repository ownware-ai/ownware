/**
 * Profile update — public entry surface for Phase 2.
 *
 * Update detection (`checkProfileUpdate`) and three-way apply
 * (`applyProfileUpdate`) for github-sourced profiles. Forks and
 * builtin-bundles are intentionally not handled here; they have their
 * own update mechanisms (registry's content-hash compare for forks;
 * app releases for builtins).
 */

export { checkProfileUpdate } from './check-updates.js'
export type { UpdateState, CheckUpdateOptions } from './check-updates.js'

export {
  applyProfileUpdate,
  findProfilesForRepo,
  uninstallProfilesForRepo,
  recoverInterruptedProfileUpdates,
} from './apply-update.js'
export type {
  UpdateStrategy,
  ApplyUpdateOptions,
  ApplyUpdateResult,
} from './apply-update.js'

export { detectLocalEdits } from './local-edits.js'
export type { LocalEditsState } from './local-edits.js'
