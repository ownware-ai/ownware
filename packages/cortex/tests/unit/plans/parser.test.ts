/**
 * Unit tests for trailing-checklist extraction.
 *
 * The parser is the bridge between the freeform plan body and the
 * structured todo list. Its contract is "find the checklist that
 * trails the file." These tests pin the corner cases.
 */

import { describe, it, expect } from 'vitest'
import { extractTrailingChecklist } from '../../../src/plans/parser.js'

describe('extractTrailingChecklist', () => {
  it('returns empty for an empty body', () => {
    expect(extractTrailingChecklist('')).toEqual([])
  })

  it('returns empty when the file has no checklist at all', () => {
    const body = '# Plan\n\nJust prose, no actions yet.\n'
    expect(extractTrailingChecklist(body)).toEqual([])
  })

  it('extracts a simple trailing checklist', () => {
    const body = [
      '# Plan',
      '',
      'Approach: rewrite the auth middleware in place.',
      '',
      '- [ ] Read auth/session.ts',
      '- [ ] Refactor session validator',
      '- [ ] Update tests',
      '',
    ].join('\n')

    const items = extractTrailingChecklist(body)
    expect(items).toHaveLength(3)
    expect(items[0]!.text).toBe('Read auth/session.ts')
    expect(items[1]!.text).toBe('Refactor session validator')
    expect(items[2]!.text).toBe('Update tests')
    expect(items.every(i => i.done === false)).toBe(true)
  })

  it('handles a mix of done and pending items', () => {
    const body = [
      'Some prose.',
      '',
      '- [x] Already done',
      '- [ ] Still pending',
      '- [X] Also done (uppercase X)',
    ].join('\n')

    const items = extractTrailingChecklist(body)
    expect(items.map(i => i.done)).toEqual([true, false, true])
    expect(items.map(i => i.text)).toEqual(['Already done', 'Still pending', 'Also done (uppercase X)'])
  })

  it('only takes the TRAILING run — quoted lists in the middle are ignored', () => {
    const body = [
      '# Options considered',
      '',
      'We thought about:',
      '- [ ] Approach A: monolithic refactor',
      '- [ ] Approach B: behind a flag',
      '',
      'We picked B because it lets us iterate.',
      '',
      '# Action steps',
      '',
      '- [ ] Add the flag',
      '- [ ] Wire B behind it',
      '- [ ] Add tests for B',
    ].join('\n')

    const items = extractTrailingChecklist(body)
    // Only the trailing 3 items, not the middle two.
    expect(items.map(i => i.text)).toEqual([
      'Add the flag',
      'Wire B behind it',
      'Add tests for B',
    ])
  })

  it('ignores trailing blank lines under the checklist', () => {
    const body = [
      'prose',
      '',
      '- [ ] first',
      '- [ ] second',
      '',
      '   ',
      '\t',
      '',
    ].join('\n')

    const items = extractTrailingChecklist(body)
    expect(items.map(i => i.text)).toEqual(['first', 'second'])
  })

  it('records 1-based source line numbers for each item', () => {
    const body = [
      '# Plan',          // line 1
      '',                // line 2
      'Prose.',          // line 3
      '',                // line 4
      '- [ ] one',       // line 5
      '- [ ] two',       // line 6
      '- [x] three',     // line 7
    ].join('\n')

    const items = extractTrailingChecklist(body)
    expect(items.map(i => i.line)).toEqual([5, 6, 7])
  })

  it('treats empty checkbox text as a valid (but empty-text) item', () => {
    const body = '- [ ] \n- [ ] something'
    const items = extractTrailingChecklist(body)
    expect(items.map(i => i.text)).toEqual(['', 'something'])
  })

  it('does not match `*` or `+` bullets — only `-`', () => {
    const body = '* [ ] starred\n+ [ ] plused\n- [ ] dashed'
    const items = extractTrailingChecklist(body)
    // Only the trailing dashed line is valid; the parser walks back
    // and stops at the first non-checklist line.
    expect(items).toHaveLength(1)
    expect(items[0]!.text).toBe('dashed')
  })

  it('tolerates indentation on checklist lines (sub-items count too)', () => {
    const body = [
      'Plan:',
      '',
      '- [ ] step one',
      '  - [ ] sub-step',
      '- [ ] step two',
    ].join('\n')

    const items = extractTrailingChecklist(body)
    expect(items).toHaveLength(3)
    expect(items.map(i => i.text)).toEqual(['step one', 'sub-step', 'step two'])
  })
})
