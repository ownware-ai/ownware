/**
 * Session Recall
 *
 * Simple keyword-based recall of relevant past sessions.
 * Finds sessions whose keywords or summaries overlap with the
 * current prompt and formats them for injection.
 */

import type { SessionSummary } from './types.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find past sessions relevant to the current prompt using keyword matching.
 *
 * Scores each session by keyword overlap with the current prompt,
 * returns the top matches formatted as context for prompt injection.
 *
 * @param currentPrompt - The current user input or assembled prompt
 * @param sessions - Available past session summaries
 * @param maxResults - Maximum number of sessions to return (default 3)
 * @returns Formatted context string, or empty string if no relevant sessions
 */
export function recallRelevantSessions(
  currentPrompt: string,
  sessions: readonly SessionSummary[],
  maxResults = 3,
): string {
  if (sessions.length === 0 || !currentPrompt.trim()) return ''

  const promptWords = extractWords(currentPrompt)
  if (promptWords.size === 0) return ''

  // Score each session by keyword overlap
  const scored = sessions.map(session => ({
    session,
    score: scoreSession(session, promptWords),
  }))

  // Filter to sessions with at least some relevance
  const relevant = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)

  if (relevant.length === 0) return ''

  const entries = relevant.map(({ session, score }) => [
    `<session id="${session.sessionId}" relevance="${score.toFixed(2)}" date="${session.timestamp}">`,
    session.summary.trim(),
    '</session>',
  ].join('\n'))

  return [
    '# Relevant Past Sessions',
    '',
    ...entries,
  ].join('\n\n')
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Score a session by keyword overlap with the prompt.
 * Returns a normalized score between 0 and 1.
 */
function scoreSession(
  session: SessionSummary,
  promptWords: Set<string>,
): number {
  // Combine session keywords and summary words
  const sessionWords = new Set<string>()

  for (const kw of session.keywords) {
    for (const w of kw.toLowerCase().split(/\s+/)) {
      if (w.length > 2) sessionWords.add(w)
    }
  }

  for (const w of extractWords(session.summary)) {
    sessionWords.add(w)
  }

  if (sessionWords.size === 0) return 0

  // Count overlapping words
  let overlap = 0
  for (const word of promptWords) {
    if (sessionWords.has(word)) overlap++
  }

  // Normalize by the smaller set size (Jaccard-like)
  const minSize = Math.min(promptWords.size, sessionWords.size)
  return minSize > 0 ? overlap / minSize : 0
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stop words to exclude from keyword matching */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'under', 'again',
  'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
  'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
  'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 'just', 'because', 'but', 'and', 'or', 'if',
  'while', 'this', 'that', 'these', 'those', 'it', 'its',
])

/**
 * Extract meaningful words from text, excluding stop words and short tokens.
 */
function extractWords(text: string): Set<string> {
  const words = new Set<string>()
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/)

  for (const token of tokens) {
    if (token.length > 2 && !STOP_WORDS.has(token)) {
      words.add(token)
    }
  }

  return words
}
