/**
 * Unit tests for the skill content validator.
 */

import { describe, it, expect } from 'vitest'
import {
  validateSkillContent,
  deriveSlug,
  SkillValidationError,
  type SkillValidationErrorCode,
} from '../../../src/profile/skills/validator.js'

function expectErrorCode(
  fn: () => unknown,
  code: SkillValidationErrorCode,
): void {
  try {
    fn()
    throw new Error('expected SkillValidationError to be thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(SkillValidationError)
    expect((err as SkillValidationError).code).toBe(code)
  }
}

const VALID = `---
name: competitive-research
description: Run a structured competitor SWOT analysis
---
# Competitive Research

Body here.
`

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('validateSkillContent — happy path', () => {
  it('parses a well-formed skill', () => {
    const result = validateSkillContent(VALID)
    expect(result.slug).toBe('competitive-research')
    expect(result.name).toBe('competitive-research')
    expect(result.description).toBe('Run a structured competitor SWOT analysis')
    expect(result.trigger).toBe('/competitive-research')
    expect(result.body).toContain('# Competitive Research')
  })

  it('respects an explicit trigger', () => {
    const content = `---
name: research
description: do research
trigger: /r
---
body
`
    const result = validateSkillContent(content)
    expect(result.trigger).toBe('/r')
  })

  it('preserves additional frontmatter fields', () => {
    const content = `---
name: skill
description: a skill
version: "1.0"
allowed-tools: [search, fetch]
tags: [a, b]
---
body
`
    const result = validateSkillContent(content)
    expect(result.frontmatter['version']).toBe('1.0')
    expect(result.frontmatter['allowed-tools']).toEqual(['search', 'fetch'])
    expect(result.frontmatter['tags']).toEqual(['a', 'b'])
  })

  it('derives a slug from a human-readable name', () => {
    const content = `---
name: Competitive Research
description: x
---
body
`
    const result = validateSkillContent(content)
    expect(result.slug).toBe('competitive-research')
    expect(result.name).toBe('Competitive Research')
  })

  it('handles CRLF line endings', () => {
    const content = '---\r\nname: x\r\ndescription: y\r\n---\r\nbody\r\n'
    const result = validateSkillContent(content)
    expect(result.body).toBe('body')
  })
})

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('validateSkillContent — errors', () => {
  it('rejects missing frontmatter', () => {
    expectErrorCode(
      () => validateSkillContent('# just a markdown body'),
      'MALFORMED_FRONTMATTER',
    )
  })

  it('rejects unclosed frontmatter', () => {
    const content = '---\nname: x\ndescription: y\nbody never gets here'
    expectErrorCode(() => validateSkillContent(content), 'MALFORMED_FRONTMATTER')
  })

  it('rejects invalid YAML in frontmatter', () => {
    const content = '---\nname: : :\ndesc: y\n---\nbody'
    expectErrorCode(() => validateSkillContent(content), 'INVALID_YAML')
  })

  it('rejects frontmatter that parses to a non-object', () => {
    const content = '---\n- a\n- b\n---\nbody'
    expectErrorCode(() => validateSkillContent(content), 'INVALID_YAML')
  })

  it('rejects missing name', () => {
    const content = '---\ndescription: y\n---\nbody'
    expectErrorCode(() => validateSkillContent(content), 'MISSING_OR_INVALID_NAME')
  })

  it('rejects empty name', () => {
    const content = '---\nname: ""\ndescription: y\n---\nbody'
    expectErrorCode(() => validateSkillContent(content), 'MISSING_OR_INVALID_NAME')
  })

  it('rejects non-string name', () => {
    const content = '---\nname: 42\ndescription: y\n---\nbody'
    expectErrorCode(() => validateSkillContent(content), 'MISSING_OR_INVALID_NAME')
  })

  it('rejects name longer than 60 characters', () => {
    const long = 'a'.repeat(61)
    const content = `---\nname: ${long}\ndescription: y\n---\nbody`
    expectErrorCode(() => validateSkillContent(content), 'MISSING_OR_INVALID_NAME')
  })

  it('rejects missing description', () => {
    const content = '---\nname: x\n---\nbody'
    expectErrorCode(() => validateSkillContent(content), 'MISSING_OR_INVALID_DESCRIPTION')
  })

  it('rejects description longer than 280 characters', () => {
    const long = 'a'.repeat(281)
    const content = `---\nname: x\ndescription: ${long}\n---\nbody`
    expectErrorCode(() => validateSkillContent(content), 'MISSING_OR_INVALID_DESCRIPTION')
  })

  it('rejects unsafe name (slug becomes empty)', () => {
    const content = '---\nname: "!!!"\ndescription: y\n---\nbody'
    expectErrorCode(() => validateSkillContent(content), 'UNSAFE_NAME')
  })

  it('rejects empty body', () => {
    const content = '---\nname: x\ndescription: y\n---\n   \n  '
    expectErrorCode(() => validateSkillContent(content), 'EMPTY_BODY')
  })

  it('rejects content over 64KB', () => {
    const big = `---\nname: x\ndescription: y\n---\n${'a'.repeat(64 * 1024 + 1)}`
    expectErrorCode(() => validateSkillContent(big), 'TOO_LARGE')
  })

  it('accepts content exactly at the 64KB cap', () => {
    const header = '---\nname: x\ndescription: y\n---\n'
    const remaining = 64 * 1024 - Buffer.byteLength(header, 'utf-8')
    const content = header + 'a'.repeat(remaining)
    expect(() => validateSkillContent(content)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Slug derivation
// ---------------------------------------------------------------------------

describe('deriveSlug', () => {
  it('lowercases letters', () => {
    expect(deriveSlug('Foo')).toBe('foo')
  })

  it('replaces whitespace with hyphens', () => {
    expect(deriveSlug('hello world')).toBe('hello-world')
  })

  it('collapses runs of whitespace', () => {
    expect(deriveSlug('a   b\tc')).toBe('a-b-c')
  })

  it('drops unsupported characters', () => {
    expect(deriveSlug('hello!@#$world')).toBe('helloworld')
  })

  it('preserves underscores and hyphens', () => {
    expect(deriveSlug('foo_bar-baz')).toBe('foo_bar-baz')
  })

  it('returns empty for input with only unsupported chars', () => {
    expect(deriveSlug('!!!')).toBe('')
  })
})
