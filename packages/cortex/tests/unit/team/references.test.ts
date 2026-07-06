/**
 * Reference section rendering (B5) — one renderer, injected identically
 * into the conductor SOUL and every member handoff.
 */

import { describe, expect, it } from 'vitest'
import { renderReferenceSection } from '../../../src/team/references.js'

describe('renderReferenceSection', () => {
  it('returns empty string when there are no references', () => {
    expect(renderReferenceSection([])).toBe('')
  })

  it('renders a single headed section with one ### per doc, content trimmed', () => {
    const out = renderReferenceSection([
      { name: 'Spec', content: '  do this  ' },
      { name: 'Rules', content: 'never that' },
    ])
    expect(out.startsWith('## Reference — docs the team keeps on hand')).toBe(true)
    expect(out).toContain('### Spec')
    expect(out).toContain('do this')
    expect(out).not.toContain('  do this  ') // trimmed
    expect(out).toContain('### Rules')
    expect(out).toContain('never that')
  })
})
