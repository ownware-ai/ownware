/**
 * Team connectors → member assembly (B4). Pure merge: team-granted
 * Composio toolkits are added to a COPY of the member's profile,
 * additively + deduped, never mutating the original.
 */

import { describe, expect, it } from 'vitest'
import type { LoadedProfile } from '../../../src/profile/loader.js'
import { withTeamConnectors } from '../../../src/team/member-connectors.js'

function profile(toolkits: string[]): LoadedProfile {
  return { config: { tools: { composio: { toolkits } } } } as unknown as LoadedProfile
}

describe('withTeamConnectors', () => {
  it('returns the same profile reference when nothing is granted', () => {
    const p = profile(['gmail'])
    expect(withTeamConnectors(p, [])).toBe(p)
  })

  it('returns the same reference when every grant is already present (no-op)', () => {
    const p = profile(['gmail', 'github'])
    expect(withTeamConnectors(p, ['gmail'])).toBe(p)
  })

  it('merges granted toolkits additively and dedups', () => {
    const out = withTeamConnectors(profile(['gmail']), ['github', 'gmail', 'slack'])
    expect(out.config.tools.composio.toolkits).toEqual(['gmail', 'github', 'slack'])
  })

  it('does not mutate the original profile', () => {
    const p = profile(['gmail'])
    withTeamConnectors(p, ['github'])
    expect(p.config.tools.composio.toolkits).toEqual(['gmail'])
  })
})
