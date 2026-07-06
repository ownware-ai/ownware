/**
 * Integration Tests — Skill Lifecycle
 *
 * Tests the full skill pipeline: parsing skill files → registering
 * in registry → matching against user input → injecting into prompt.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { SkillRegistry } from '../../skills/registry.js'
import { parseSkillFile } from '../../skills/loader.js'
import { matchSkill, matchAllSkills } from '../../skills/matcher.js'
import { createSkillsFragment } from '../../prompt/fragments/skills.js'
import { PromptBuilder } from '../../prompt/builder.js'
import type { SkillDefinition } from '../../skills/types.js'

// ---------------------------------------------------------------------------
// Fixtures — raw skill file content
// ---------------------------------------------------------------------------

const COMMIT_SKILL_MD = `---
name: commit
description: Create a well-structured git commit
trigger: commit
---

Help the user create a git commit following conventional commits format.
Analyze staged changes and draft a commit message.`

const REVIEW_SKILL_MD = `---
name: review-pr
description: Review a GitHub pull request
trigger: \\/review-pr\\s+\\d+
triggerIsRegex: true
allowedTools:
  - read_file
  - grep
  - bash
---

Review the specified pull request for:
- Code quality
- Security issues
- Test coverage`

const TEST_SKILL_MD = `---
name: test
description: Run and analyze test results
trigger: test
---

Run the test suite and analyze failures.`

// ---------------------------------------------------------------------------
// Parse → Register → Match pipeline
// ---------------------------------------------------------------------------

describe('Skill Lifecycle: Parse → Register → Match', () => {
  let registry: SkillRegistry

  beforeEach(() => {
    registry = new SkillRegistry()

    // Parse skill files
    const skills = [COMMIT_SKILL_MD, REVIEW_SKILL_MD, TEST_SKILL_MD]
      .map(raw => parseSkillFile(raw))
      .filter((s): s is SkillDefinition => s !== null)

    // Register all
    registry.registerAll(skills)
  })

  it('parses and registers all valid skills', () => {
    expect(registry.size).toBe(3)
    expect(registry.has('commit')).toBe(true)
    expect(registry.has('review-pr')).toBe(true)
    expect(registry.has('test')).toBe(true)
  })

  it('matches /commit input to commit skill', () => {
    const skills = registry.list()
    const matched = matchSkill('/commit', skills)
    expect(matched).not.toBeNull()
    expect(matched!.name).toBe('commit')
  })

  it('matches /commit with arguments', () => {
    const skills = registry.list()
    const matched = matchSkill('/commit fix authentication bug', skills)
    expect(matched).not.toBeNull()
    expect(matched!.name).toBe('commit')
  })

  it('matches regex trigger /review-pr 456', () => {
    const skills = registry.list()
    const matched = matchSkill('/review-pr 456', skills)
    expect(matched).not.toBeNull()
    expect(matched!.name).toBe('review-pr')
  })

  it('does not match /review-pr without number', () => {
    const skills = registry.list()
    const matched = matchSkill('/review-pr', skills)
    // Regex requires a number — should not match review-pr
    expect(matched?.name).not.toBe('review-pr')
  })

  it('returns null for unmatched input', () => {
    const skills = registry.list()
    expect(matchSkill('explain this function', skills)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Match → Prompt injection
// ---------------------------------------------------------------------------

describe('Skill Match → Prompt Injection', () => {
  it('matched skill content injected into prompt via skills fragment', () => {
    const parsed = [COMMIT_SKILL_MD, TEST_SKILL_MD]
      .map(raw => parseSkillFile(raw))
      .filter((s): s is SkillDefinition => s !== null)

    const builder = new PromptBuilder()
    builder.addFragment(createSkillsFragment(parsed))

    const text = builder.buildText()
    expect(text).toContain('# Available Skills')
    expect(text).toContain('commit')
    expect(text).toContain('test')
    expect(text).toContain('Create a well-structured git commit')
    expect(text).toContain('Run and analyze test results')
  })

  it('matched skill with allowedTools shows tool restrictions', () => {
    const parsed = parseSkillFile(REVIEW_SKILL_MD)!
    const builder = new PromptBuilder()
    builder.addFragment(createSkillsFragment([parsed]))

    const text = builder.buildText()
    expect(text).toContain('read_file')
    expect(text).toContain('grep')
    expect(text).toContain('bash')
  })
})

// ---------------------------------------------------------------------------
// Registry mutation → re-match
// ---------------------------------------------------------------------------

describe('Registry Mutation → Re-match', () => {
  it('removing a skill prevents it from matching', () => {
    const registry = new SkillRegistry()
    const skill = parseSkillFile(COMMIT_SKILL_MD)!
    registry.register(skill)

    // Matches before removal
    expect(matchSkill('/commit', registry.list())).not.toBeNull()

    // Remove and re-match
    registry.remove('commit')
    expect(matchSkill('/commit', registry.list())).toBeNull()
  })

  it('overwriting a skill updates its content', () => {
    const registry = new SkillRegistry()
    const original = parseSkillFile(COMMIT_SKILL_MD)!
    registry.register(original)

    // Overwrite with new content
    registry.register({
      ...original,
      description: 'Updated commit skill',
      content: 'New commit instructions...',
    })

    const skill = registry.get('commit')
    expect(skill?.description).toBe('Updated commit skill')
    expect(skill?.content).toBe('New commit instructions...')
  })
})
