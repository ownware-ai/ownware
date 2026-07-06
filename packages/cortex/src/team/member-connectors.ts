/**
 * Team connectors → member assembly.
 *
 * A team grants Composio toolkits to its members. Rather than touch the
 * shared assembler (which would leak team-awareness into
 * `profile/assembler.ts` and break the plug-and-play constraint), the
 * team module augments a COPY of the member's profile before assembly —
 * the same in-module pattern the scheduler already uses for the per-team
 * model override. `assembleAgent` then wires the merged toolkits in
 * through its normal Composio path; nothing downstream knows about teams.
 *
 * The merge is additive and deduped: the member keeps its own toolkits
 * and gains the team's. It never bypasses auth — a toolkit only yields
 * tools if the assembling entity has it connected.
 */

import type { LoadedProfile } from '../profile/loader.js'

export function withTeamConnectors(
  profile: LoadedProfile,
  composioToolkits: readonly string[],
): LoadedProfile {
  if (composioToolkits.length === 0) return profile
  const existing = profile.config.tools.composio.toolkits
  const merged = [...new Set([...existing, ...composioToolkits])]
  if (merged.length === existing.length) return profile
  return {
    ...profile,
    config: {
      ...profile.config,
      tools: {
        ...profile.config.tools,
        composio: { ...profile.config.tools.composio, toolkits: merged },
      },
    },
  }
}
