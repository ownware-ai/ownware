/**
 * Active context (Slice A5b) — pure-function tests for the
 * `renderActiveContextFragment` helper. The fragment is what the
 * assembler injects into the system prompt between memory and
 * environment context. These tests exercise the shape without
 * standing up a full profile + Loom session.
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

  it('returns null when every list is empty + selection is missing', () => {
    expect(
      renderActiveContextFragment(profileWithSkills([]), {
        skills: [],
        designSystems: [],
      }),
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

  describe('<active-design-systems> — removed in slice B1.8.B', () => {
    // The Design vertical now owns this block client-side
    // (`build-system-prompt-append.ts:renderActiveDesignSystems`). It
    // bakes the full DESIGN.md + tokens.css verbatim each turn instead
    // of cortex's old lightweight summary. Cortex's
    // `activeContext.designSystems` schema input is still accepted
    // (typed metadata stays available for non-Design clients), but no
    // block is emitted from the shared assembler anymore — that would
    // duplicate with the client's bake.
    it('does NOT emit <active-design-systems> even when designSystems[] is populated', () => {
      const fragment = renderActiveContextFragment(profileWithSkills([]), {
        designSystems: [
          {
            id: 'editorial-monocle',
            name: 'Editorial Monocle',
            category: 'editorial',
            surface: 'web',
            swatches: ['#0E0E0E', '#FAF7EE', '#A12C2C'],
            summary: 'serif magazine',
          },
        ],
      })
      // Fragment may be null (no other blocks) OR non-null (skills /
      // selection present), but either way must NOT contain the tag.
      if (fragment !== null) {
        expect(fragment).not.toContain('<active-design-systems>')
      }
    })

    it('does NOT mention apply_design_system in the assembler-owned fragment', () => {
      const fragment = renderActiveContextFragment(profileWithSkills([]), {
        designSystems: [{ id: 'x', name: 'X' }],
      })
      if (fragment !== null) {
        expect(fragment).not.toContain('apply_design_system')
      }
    })
  })

  describe('<active-selection>', () => {
    it('renders the selection block with tag / selector / outerHTML / url', () => {
      const fragment = renderActiveContextFragment(profileWithSkills([]), {
        selection: {
          tag: 'button',
          selector: '#cta-primary',
          outerHTML: '<button id="cta-primary">Buy now</button>',
          url: 'http://localhost/preview/01-cover.html',
        },
      })
      expect(fragment).not.toBeNull()
      expect(fragment!).toContain('<active-selection>')
      expect(fragment!).toContain('tag: button')
      expect(fragment!).toContain('selector: #cta-primary')
      expect(fragment!).toContain('url: http://localhost/preview/01-cover.html')
      expect(fragment!).toContain('<button id="cta-primary">Buy now</button>')
    })

    it('truncates outerHTML over the byte budget', () => {
      const huge = '<div>' + 'x'.repeat(10_000) + '</div>'
      const fragment = renderActiveContextFragment(profileWithSkills([]), {
        selection: {
          tag: 'div',
          selector: 'body > div',
          outerHTML: huge,
        },
      })
      expect(fragment!).toContain('[…truncated to')
      expect(fragment!.length).toBeLessThan(huge.length + 500)
    })

    it('omits the url line when not provided', () => {
      const fragment = renderActiveContextFragment(profileWithSkills([]), {
        selection: {
          tag: 'span',
          selector: '.title',
          outerHTML: '<span class="title">Hi</span>',
        },
      })
      expect(fragment!).not.toContain('url:')
    })

    it('renders the file line and steers the agent to it with the constrained write tools', () => {
      const fragment = renderActiveContextFragment(profileWithSkills([]), {
        selection: {
          tag: 'button',
          selector: '[data-cx-id="hero-cta"]',
          outerHTML: '<button data-cx-id="hero-cta">Buy</button>',
          file: 'index.html',
        },
      })
      expect(fragment!).toContain('file: index.html')
      // The collapse denied editFile — the block must NOT tell the agent to
      // use it, and must point at the structured write tools instead.
      expect(fragment!).not.toContain('editFile')
      expect(fragment!).toMatch(/write_component|write_page|set_tokens/)
      // And it must tell the agent NOT to hunt for the file.
      expect(fragment!.toLowerCase()).toContain('do not glob')
    })

    it('omits the file line when not provided', () => {
      const fragment = renderActiveContextFragment(profileWithSkills([]), {
        selection: { tag: 'span', selector: '.t', outerHTML: '<span>Hi</span>' },
      })
      expect(fragment!).not.toContain('file:')
    })

    it('renders applied tokens as name=value so a colour change needs no file read', () => {
      const fragment = renderActiveContextFragment(profileWithSkills([]), {
        selection: {
          tag: 'button',
          selector: '[data-cx-id="cta"]',
          outerHTML: '<button data-cx-id="cta">Buy</button>',
          file: 'index.html',
          appliedTokens: [
            { name: '--accent', value: '#635bff' },
            { name: '--radius', value: '8px' },
          ],
        },
      })
      expect(fragment!).toContain('tokens: --accent=#635bff, --radius=8px')
    })

    it('renders a token with no resolved value as the bare name', () => {
      const fragment = renderActiveContextFragment(profileWithSkills([]), {
        selection: {
          tag: 'div',
          selector: '.box',
          outerHTML: '<div class="box"></div>',
          appliedTokens: [{ name: '--gap', value: '' }],
        },
      })
      expect(fragment!).toContain('tokens: --gap')
      expect(fragment!).not.toContain('--gap=')
    })

    it('omits the tokens line when none are provided', () => {
      const fragment = renderActiveContextFragment(profileWithSkills([]), {
        selection: { tag: 'p', selector: 'p', outerHTML: '<p>x</p>' },
      })
      expect(fragment!).not.toContain('tokens:')
    })
  })

  describe('composition (skills + selection — DS block removed)', () => {
    it('emits skills → selection in order; no DS block between them', () => {
      const fragment = renderActiveContextFragment(
        profileWithSkills([{ name: 'critique', description: '', content: 'body' }]),
        {
          skills: [{ id: 'critique', name: 'critique' }],
          designSystems: [{ id: 'ds1', name: 'DS One' }],
          selection: { tag: 'h1', selector: 'h1', outerHTML: '<h1>X</h1>' },
        },
      )
      expect(fragment).not.toBeNull()
      const skillIdx = fragment!.indexOf('<active-skills>')
      const selIdx = fragment!.indexOf('<active-selection>')
      expect(skillIdx).toBeGreaterThan(-1)
      expect(selIdx).toBeGreaterThan(skillIdx)
      // Slice B1.8.B regression: no parallel emit from cortex's side.
      expect(fragment!).not.toContain('<active-design-systems>')
    })
  })
})
