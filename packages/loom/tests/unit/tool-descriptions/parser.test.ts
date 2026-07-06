/**
 * Unit Tests — Tool Description Parser
 */

import { describe, it, expect } from 'vitest'

import { parseToolDescription } from '../../../src/tools/descriptions/parser.js'

describe('parseToolDescription', () => {
  it('parses a description with frontmatter and overview', () => {
    const md = `---
name: example
---

## overview
The example tool does an example thing.
`
    const desc = parseToolDescription(md)
    expect(desc.name).toBe('example')
    expect(desc.sections.overview).toContain('example tool')
  })

  it('parses every standard section in canonical order independent of source order', () => {
    const md = `---
name: many
---

## examples
exA

## overview
ovA

## safety
saA

## usage
usA

## parallel
paA

## alternatives
alA
`
    const desc = parseToolDescription(md)
    expect(desc.sections.overview).toBe('ovA')
    expect(desc.sections.usage).toBe('usA')
    expect(desc.sections.safety).toBe('saA')
    expect(desc.sections.parallel).toBe('paA')
    expect(desc.sections.alternatives).toBe('alA')
    expect(desc.sections.examples).toBe('exA')
  })

  it('throws when frontmatter is missing the name field', () => {
    const md = `---
description: nothing
---

## overview
body
`
    expect(() => parseToolDescription(md)).toThrow(/missing required `name`/)
  })

  it('throws when overview is missing', () => {
    const md = `---
name: noOverview
---

## usage
- a
`
    expect(() => parseToolDescription(md)).toThrow(/overview/)
  })

  it('throws on an unknown section name', () => {
    const md = `---
name: bad
---

## overview
body

## foo
unknown section
`
    expect(() => parseToolDescription(md)).toThrow(/Unknown tool description section "foo"/)
  })

  it('throws on a duplicate section', () => {
    const md = `---
name: dup
---

## overview
first

## overview
second
`
    expect(() => parseToolDescription(md)).toThrow(/Duplicate tool description section/)
  })

  it('throws on unclosed frontmatter', () => {
    const md = `---
name: x

## overview
body
`
    expect(() => parseToolDescription(md)).toThrow(/frontmatter is not closed/)
  })

  it('drops sections whose body is empty / whitespace-only (still requires overview)', () => {
    const md = `---
name: emptySections
---

## overview
present

## usage

## safety

`
    const desc = parseToolDescription(md)
    expect(desc.sections.overview).toBe('present')
    expect(desc.sections.usage).toBeUndefined()
    expect(desc.sections.safety).toBeUndefined()
  })

  it('strips a leading BOM', () => {
    const md = '﻿---\nname: bomTool\n---\n\n## overview\nbody\n'
    const desc = parseToolDescription(md)
    expect(desc.name).toBe('bomTool')
  })
})
