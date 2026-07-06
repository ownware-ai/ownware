/**
 * Unit Tests — Skill Loader
 *
 * Tests SKILL.md parsing: frontmatter extraction, YAML parsing,
 * trigger type detection, and edge cases.
 *
 * Uses parseSkillFile() directly (no filesystem needed for unit tests).
 */

import { describe, it, expect } from 'vitest'
import { parseSkillFile } from '../../../skills/loader.js'

// ---------------------------------------------------------------------------
// Valid files
// ---------------------------------------------------------------------------

describe('parseSkillFile()', () => {
  it('parses valid skill file with all fields', () => {
    const raw = `---
name: commit
description: Create a git commit
trigger: /commit
---

Help the user create a well-formed git commit.
Follow conventional commits format.`

    const skill = parseSkillFile(raw)
    expect(skill).not.toBeNull()
    expect(skill!.name).toBe('commit')
    expect(skill!.description).toBe('Create a git commit')
    expect(skill!.trigger).toBe('/commit')
    expect(skill!.content).toContain('conventional commits')
  })

  it('parses regex trigger', () => {
    const raw = `---
name: review
description: Review PR
trigger: \\/review-pr\\s+\\d+
triggerIsRegex: true
---

Review the pull request.`

    const skill = parseSkillFile(raw)
    expect(skill).not.toBeNull()
    expect(skill!.trigger).toBeInstanceOf(RegExp)
  })

  it('parses allowedTools as array', () => {
    const raw = `---
name: debug
description: Debug issue
trigger: /debug
allowedTools:
  - read_file
  - grep
  - bash
---

Debug the issue.`

    const skill = parseSkillFile(raw)
    expect(skill).not.toBeNull()
    expect(skill!.allowedTools).toEqual(['read_file', 'grep', 'bash'])
  })

  it('trims content body', () => {
    const raw = `---
name: test
description: Run tests
trigger: /test
---

  Content with whitespace.
`
    const skill = parseSkillFile(raw)
    expect(skill!.content).toBe('Content with whitespace.')
  })

  it('handles quoted values in frontmatter', () => {
    const raw = `---
name: "my-skill"
description: "A skill with: colons"
trigger: "/go"
---

Content.`

    const skill = parseSkillFile(raw)
    expect(skill!.name).toBe('my-skill')
    expect(skill!.description).toBe('A skill with: colons')
  })

  // -----------------------------------------------------------------------
  // Invalid files
  // -----------------------------------------------------------------------

  describe('invalid files', () => {
    it('returns null for file without frontmatter', () => {
      const raw = `Just some markdown content without frontmatter.`
      expect(parseSkillFile(raw)).toBeNull()
    })

    it('returns null for file with unclosed frontmatter', () => {
      const raw = `---
name: broken
description: Missing closing delimiter

Content.`
      expect(parseSkillFile(raw)).toBeNull()
    })

    it('returns null when name is missing', () => {
      const raw = `---
description: No name
trigger: /test
---

Content.`
      expect(parseSkillFile(raw)).toBeNull()
    })

    it('returns null when trigger is missing', () => {
      const raw = `---
name: no-trigger
description: Missing trigger
---

Content.`
      expect(parseSkillFile(raw)).toBeNull()
    })

    it('returns null for empty frontmatter', () => {
      const raw = `---
---

Content.`
      expect(parseSkillFile(raw)).toBeNull()
    })

    it('returns null for empty file', () => {
      expect(parseSkillFile('')).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles frontmatter with boolean values', () => {
      const raw = `---
name: careful
description: Careful skill
trigger: /careful
triggerIsRegex: false
---

Be careful.`

      const skill = parseSkillFile(raw)
      expect(skill).not.toBeNull()
      expect(skill!.trigger).toBe('/careful') // string, not regex
    })

    it('handles multiline content body', () => {
      const raw = `---
name: multi
description: Multiline
trigger: /multi
---

Line one.

Line two.

Line three.`

      const skill = parseSkillFile(raw)
      expect(skill!.content).toContain('Line one.')
      expect(skill!.content).toContain('Line two.')
      expect(skill!.content).toContain('Line three.')
    })
  })
})
