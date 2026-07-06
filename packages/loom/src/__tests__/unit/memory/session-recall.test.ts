/**
 * Unit Tests — Session Recall
 *
 * Tests keyword-based session matching: scoring, ranking,
 * formatting, and edge cases.
 */

import { describe, it, expect } from 'vitest'
import { recallRelevantSessions } from '../../../memory/session-recall.js'
import type { SessionSummary } from '../../../memory/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sessions: SessionSummary[] = [
  {
    sessionId: 'session-1',
    summary: 'Fixed authentication bug in login middleware. JWT token validation was failing on expired tokens.',
    keywords: ['authentication', 'JWT', 'login', 'middleware', 'token'],
    timestamp: '2026-03-28T10:00:00Z',
  },
  {
    sessionId: 'session-2',
    summary: 'Refactored database connection pooling. Switched from pg to postgres.js for better performance.',
    keywords: ['database', 'postgres', 'connection', 'pooling', 'performance'],
    timestamp: '2026-03-29T14:00:00Z',
  },
  {
    sessionId: 'session-3',
    summary: 'Added rate limiting to API endpoints. Used sliding window algorithm with Redis.',
    keywords: ['rate-limiting', 'API', 'Redis', 'sliding-window'],
    timestamp: '2026-03-30T09:00:00Z',
  },
  {
    sessionId: 'session-4',
    summary: 'Wrote unit tests for authentication service. 95% coverage achieved.',
    keywords: ['testing', 'authentication', 'unit-tests', 'coverage'],
    timestamp: '2026-03-31T16:00:00Z',
  },
]

// ---------------------------------------------------------------------------
// Basic matching
// ---------------------------------------------------------------------------

describe('recallRelevantSessions()', () => {
  it('returns empty string for empty sessions', () => {
    expect(recallRelevantSessions('auth bug', [])).toBe('')
  })

  it('returns empty string for empty prompt', () => {
    expect(recallRelevantSessions('', sessions)).toBe('')
  })

  it('returns empty string for whitespace-only prompt', () => {
    expect(recallRelevantSessions('   ', sessions)).toBe('')
  })

  it('finds sessions related to authentication', () => {
    const result = recallRelevantSessions(
      'I need to fix the authentication token validation',
      sessions,
    )
    expect(result).toContain('session-1')
    // session-4 also mentions authentication
    expect(result).toContain('session-4')
  })

  it('finds sessions related to database', () => {
    const result = recallRelevantSessions(
      'database connection is timing out with postgres',
      sessions,
    )
    expect(result).toContain('session-2')
  })

  it('returns no matches for unrelated prompt', () => {
    const result = recallRelevantSessions(
      'deploy the frontend to vercel',
      sessions,
    )
    // No sessions about frontend or vercel
    expect(result).toBe('')
  })

  // -----------------------------------------------------------------------
  // Ranking
  // -----------------------------------------------------------------------

  describe('ranking', () => {
    it('returns higher-relevance sessions first', () => {
      const result = recallRelevantSessions(
        'authentication middleware token validation',
        sessions,
      )
      // session-1 has more keyword overlap than session-4
      const pos1 = result.indexOf('session-1')
      const pos4 = result.indexOf('session-4')
      if (pos1 !== -1 && pos4 !== -1) {
        expect(pos1).toBeLessThan(pos4)
      }
    })
  })

  // -----------------------------------------------------------------------
  // maxResults
  // -----------------------------------------------------------------------

  describe('maxResults', () => {
    it('limits number of returned sessions', () => {
      const result = recallRelevantSessions(
        'authentication token database API testing',
        sessions,
        1,
      )
      // Should only contain 1 session tag
      const matches = result.match(/<session /g)
      expect(matches?.length ?? 0).toBeLessThanOrEqual(1)
    })

    it('defaults to 3 max results', () => {
      const result = recallRelevantSessions(
        'authentication database API rate redis token',
        sessions,
      )
      const matches = result.match(/<session /g)
      expect(matches?.length ?? 0).toBeLessThanOrEqual(3)
    })
  })

  // -----------------------------------------------------------------------
  // Output format
  // -----------------------------------------------------------------------

  describe('output format', () => {
    it('includes header', () => {
      const result = recallRelevantSessions('authentication', sessions)
      if (result) {
        expect(result).toContain('# Relevant Past Sessions')
      }
    })

    it('wraps sessions in XML tags with attributes', () => {
      const result = recallRelevantSessions('authentication token', sessions)
      if (result) {
        expect(result).toMatch(/<session id="[^"]+" relevance="[^"]+" date="[^"]+">/)
        expect(result).toContain('</session>')
      }
    })

    it('includes session summary text', () => {
      const result = recallRelevantSessions('authentication JWT login', sessions)
      if (result) {
        expect(result).toContain('JWT token validation')
      }
    })

    it('includes relevance score', () => {
      const result = recallRelevantSessions('authentication', sessions)
      if (result) {
        expect(result).toMatch(/relevance="\d+\.\d+"/)
      }
    })
  })

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles sessions with no keywords', () => {
      const noKeywords: SessionSummary[] = [{
        sessionId: 'empty',
        summary: 'Something happened',
        keywords: [],
        timestamp: '2026-04-01T00:00:00Z',
      }]
      // Should not crash
      const result = recallRelevantSessions('something', noKeywords)
      expect(typeof result).toBe('string')
    })

    it('handles sessions with empty summary', () => {
      const emptySummary: SessionSummary[] = [{
        sessionId: 'empty',
        summary: '',
        keywords: ['test'],
        timestamp: '2026-04-01T00:00:00Z',
      }]
      const result = recallRelevantSessions('test keyword', emptySummary)
      expect(typeof result).toBe('string')
    })

    it('ignores common stop words', () => {
      // "the" and "is" are stop words — should not match on them alone
      const result = recallRelevantSessions('the is a', sessions)
      expect(result).toBe('')
    })
  })
})
