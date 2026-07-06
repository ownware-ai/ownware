/**
 * Unit Tests — Skill Matcher
 *
 * Tests skill matching: string triggers, regex triggers,
 * confidence scoring, and edge cases.
 */

import { describe, it, expect } from 'vitest'
import { matchSkill, matchSkillWithConfidence, matchAllSkills } from '../../../skills/matcher.js'
import type { SkillDefinition } from '../../../skills/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const skills: SkillDefinition[] = [
  {
    name: 'commit',
    description: 'Create a git commit',
    trigger: 'commit',
    content: 'Help create a commit...',
  },
  {
    name: 'review-pr',
    description: 'Review a pull request',
    trigger: /^\/review-pr\s+\d+$/,
    content: 'Review the PR...',
  },
  {
    name: 'test',
    description: 'Run test suite',
    trigger: 'test',
    content: 'Run tests...',
  },
  {
    name: 'deploy',
    description: 'Deploy to production',
    trigger: /^\/deploy\s+(staging|production)$/,
    content: 'Deploy...',
  },
]

// ---------------------------------------------------------------------------
// matchSkill()
// ---------------------------------------------------------------------------

describe('matchSkill()', () => {
  it('returns null for empty input', () => {
    expect(matchSkill('', skills)).toBeNull()
  })

  it('returns null for whitespace-only input', () => {
    expect(matchSkill('   ', skills)).toBeNull()
  })

  it('returns null for empty skills array', () => {
    expect(matchSkill('/commit', [])).toBeNull()
  })

  it('returns null when no skill matches', () => {
    expect(matchSkill('hello world', skills)).toBeNull()
  })

  // -- String triggers --

  describe('string triggers', () => {
    it('matches exact slash command', () => {
      const result = matchSkill('/commit', skills)
      expect(result?.name).toBe('commit')
    })

    it('matches slash command with arguments', () => {
      const result = matchSkill('/commit fix the login bug', skills)
      expect(result?.name).toBe('commit')
    })

    it('matches bare trigger word with arguments', () => {
      const result = matchSkill('commit fix the bug', skills)
      expect(result?.name).toBe('commit')
    })

    it('is case insensitive', () => {
      const result = matchSkill('/COMMIT', skills)
      expect(result?.name).toBe('commit')
    })

    it('does not match partial words', () => {
      // "commitment" should not match "commit" trigger
      const result = matchSkill('commitment issues', skills)
      expect(result).toBeNull()
    })
  })

  // -- Regex triggers --

  describe('regex triggers', () => {
    it('matches valid regex pattern', () => {
      const result = matchSkill('/review-pr 123', skills)
      expect(result?.name).toBe('review-pr')
    })

    it('does not match invalid regex pattern', () => {
      const result = matchSkill('/review-pr abc', skills)
      expect(result?.name).not.toBe('review-pr')
    })

    it('matches deploy with staging', () => {
      const result = matchSkill('/deploy staging', skills)
      expect(result?.name).toBe('deploy')
    })

    it('matches deploy with production', () => {
      const result = matchSkill('/deploy production', skills)
      expect(result?.name).toBe('deploy')
    })

    it('does not match deploy with invalid env', () => {
      const result = matchSkill('/deploy development', skills)
      expect(result?.name).not.toBe('deploy')
    })
  })
})

// ---------------------------------------------------------------------------
// matchSkillWithConfidence()
// ---------------------------------------------------------------------------

describe('matchSkillWithConfidence()', () => {
  it('returns null for no match', () => {
    expect(matchSkillWithConfidence('xyz', skills)).toBeNull()
  })

  it('returns skill and confidence', () => {
    const result = matchSkillWithConfidence('/commit', skills)
    expect(result).not.toBeNull()
    expect(result!.skill.name).toBe('commit')
    expect(result!.confidence).toBeGreaterThan(0)
    expect(result!.confidence).toBeLessThanOrEqual(1)
  })

  it('exact match has highest confidence (1.0)', () => {
    const result = matchSkillWithConfidence('/commit', skills)
    expect(result!.confidence).toBe(1.0)
  })

  it('prefix match has high confidence', () => {
    const result = matchSkillWithConfidence('/commit fix bug', skills)
    expect(result!.confidence).toBeGreaterThan(0.9)
  })

  it('bare word match has lower confidence than slash command', () => {
    const slash = matchSkillWithConfidence('/commit fix bug', skills)
    const bare = matchSkillWithConfidence('commit fix bug', skills)
    expect(slash!.confidence).toBeGreaterThan(bare!.confidence)
  })
})

// ---------------------------------------------------------------------------
// matchAllSkills()
// ---------------------------------------------------------------------------

describe('matchAllSkills()', () => {
  it('returns empty array for no matches', () => {
    expect(matchAllSkills('xyz', skills)).toEqual([])
  })

  it('returns empty array for empty input', () => {
    expect(matchAllSkills('', skills)).toEqual([])
  })

  it('returns all matching skills sorted by confidence', () => {
    // Both "commit" and "test" have string triggers — only one should match
    const results = matchAllSkills('/commit', skills)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].skill.name).toBe('commit')

    // Verify sorted descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i].confidence).toBeLessThanOrEqual(results[i - 1].confidence)
    }
  })
})
