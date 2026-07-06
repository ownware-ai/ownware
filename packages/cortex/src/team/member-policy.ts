/**
 * Member tool policy — a team member's autonomy + restrictions applied
 * to its assembled profile tools, at the cortex security boundary.
 *
 * Autonomy on a team is enforced as TOOL ACCESS, never a permission
 * prompt: a team run is headless (no human to answer a mid-task `ask`),
 * so a member's capability is governed by which tools it is handed —
 * not by `permissionMode`, which stays `'auto'` for every member.
 *
 *   - 'inherit'   → the member keeps its full profile tool surface.
 *   - 'read-only' → only read tools survive; the member physically
 *                   cannot mutate the workspace. Stronger than a denial
 *                   the model could be tempted to argue with — the tool
 *                   simply isn't there.
 *
 * `toolRestricts` are deny globs (same matcher as profile tool policy)
 * removed on top, for fine-grained "this member shouldn't touch X".
 *
 * The team's own coordination tools (complete_task / file_task /
 * ask_team) are appended elsewhere and never pass through here — a
 * read-only member still hands off and asks questions.
 */

import type { Tool } from '@ownware/loom'
import { applyToolPolicy } from '../profile/tool-policy.js'
import type { TeamMember } from './schema.js'

export function applyMemberToolPolicy(tools: Tool[], member: TeamMember): Tool[] {
  let result = tools
  if (member.autonomy === 'read-only') {
    // Unknown read-only status (undefined) is treated as mutating — the
    // safe default for an unrecognized tool under a read-only member.
    result = result.filter((t) => t.isReadOnly === true)
  }
  const restricts = member.toolRestricts ?? []
  if (restricts.length > 0) {
    result = applyToolPolicy(result, [], restricts)
  }
  return result
}
