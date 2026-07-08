/**
 * Active context — pure-function tests for the
 * `renderActiveContextFragment` helper. The fragment is what the
 * assembler injects into the system prompt between memory and
 * environment context. These tests exercise the shape without
 * standing up a full profile + Loom session.
 *
 * (The design-system and canvas-selection blocks were removed with the
 * legacy desktop design vertical — skills are the remaining per-turn
 * pin; vertical context ships via the generic `systemPromptAppend`.)
 */

import { describe, it, expect } from 'vitest'
import { renderActiveContextFragment } from '../../../src/profile/assembler.js'
import type { LoadedProfile } from '../../../src/profile/loader.js'

function profileWithSkills(
  skills: Array<{ name: string; description?: string; content: string }>,
): LoadedProfile {
  return {
    config: { name: 'test-agent' } as LoadedProfile['config'],
    soulMd: null,
    agentsMd: null,
    skills,
    basePath: '/tmp/test',
    timeoutMs: 1_800_000,
  } as LoadedProfile
}

describe('renderActiveContextFragment', () => {
  it('returns null when activeContext is undefined', () => {
    expect(renderActiveContextFragment(profileWithSkills([]), undefined)).toBeNull()
  })

  it('returns null when the skills list is empty', () => {
    expect(
      renderActiveContextFragment(profileWithSkills([]), { skills: [] }),
    ).toBeNull()
  })

  describe('<active-skills>', () => {
    it('inlines the body of each pinned skill that exists in the profile', () => {
      const fragment = renderActiveContextFragment(
        profileWithSkills([
          {
            name: 'critique',
            description: 'review',
            content: '# Critique\n\nGo through every dimension.',
          },
          {
            name: 'discovery',
            description: 'find',
            content: '# Discovery\n\nAsk 5 sharp questions.',
          },
        ]),
        {
          skills: [
            { id: 'critique', name: 'critique' },
            { id: 'discovery', name: 'discovery' },
          ],
        },
      )

      expect(fragment).not.toBeNull()
      expect(fragment!).toContain('<active-skills>')
      expect(fragment!).toContain('<skill name="critique">')
      expect(fragment!).toContain('Go through every dimension.')
      expect(fragment!).toContain('<skill name="discovery">')
      expect(fragment!).toContain('Ask 5 sharp questions.')
    })

    it('silently skips skill ids not present in the loaded profile (stale chip)', () => {
      const fragment = renderActiveContextFragment(
        profileWithSkills([
          { name: 'critique', description: '', content: 'body' },
        ]),
        { skills: [{ id: 'critique', name: 'critique' }, { id: 'phantom', name: 'phantom' }] },
      )
      expect(fragment).not.toBeNull()
      expect(fragment!).toContain('<skill name="critique">')
      expect(fragment!).not.toContain('phantom')
    })

    it('does not emit <active-skills> when only stale ids were pinned', () => {
      const fragment = renderActiveContextFragment(
        profileWithSkills([]),
        { skills: [{ id: 'phantom', name: 'phantom' }] },
      )
      expect(fragment).toBeNull()
    })

    it('escapes "<" / ">" / "&" / quote in the skill name attribute', () => {
      const fragment = renderActiveContextFragment(
        profileWithSkills([
          { name: 'weird&"<>name', description: '', content: 'b' },
        ]),
        { skills: [{ id: 'weird&"<>name', name: 'weird' }] },
      )
      expect(fragment!).toContain('<skill name="weird&amp;&quot;&lt;&gt;name">')
    })
  })
})
