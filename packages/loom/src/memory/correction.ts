/**
 * Correction Memory
 *
 * Tracks mistakes and their corrections within a session for
 * self-improvement. Corrections are formatted and injected into
 * the prompt so the agent avoids repeating mistakes.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Correction {
  /** What went wrong */
  readonly mistake: string
  /** How to do it correctly */
  readonly correction: string
  /** ISO timestamp when recorded */
  readonly timestamp: string
  /** Turn index when recorded (if available) */
  readonly turnIndex?: number
}

// ---------------------------------------------------------------------------
// CorrectionMemory
// ---------------------------------------------------------------------------

/**
 * Session-scoped correction memory.
 *
 * Records mistakes and corrections as they happen, then formats them
 * for injection into the system prompt. This gives the agent a
 * "don't repeat this" memory within a single session.
 */
export class CorrectionMemory {
  private readonly corrections: Correction[] = []
  private readonly maxCorrections: number

  /**
   * @param maxCorrections - Maximum corrections to retain (oldest dropped first). Default 20.
   */
  constructor(maxCorrections = 20) {
    this.maxCorrections = maxCorrections
  }

  /**
   * Record a new correction.
   *
   * @param mistake - Description of what went wrong
   * @param correction - Description of the correct approach
   * @param turnIndex - Optional turn index for context
   */
  record(mistake: string, correction: string, turnIndex?: number): void {
    this.corrections.push({
      mistake: mistake.trim(),
      correction: correction.trim(),
      timestamp: new Date().toISOString(),
      turnIndex,
    })

    // Evict oldest if over limit
    while (this.corrections.length > this.maxCorrections) {
      this.corrections.shift()
    }
  }

  /**
   * Get all corrections formatted for prompt injection.
   *
   * Returns an empty string if no corrections have been recorded.
   * The format uses XML tags for clear parsing.
   */
  getCorrections(): string {
    if (this.corrections.length === 0) return ''

    const entries = this.corrections.map((c, i) => [
      `<correction index="${i + 1}">`,
      `  <mistake>${c.mistake}</mistake>`,
      `  <fix>${c.correction}</fix>`,
      '</correction>',
    ].join('\n'))

    return [
      '# Session Corrections',
      '',
      'You made the following mistakes earlier in this session. Do not repeat them:',
      '',
      '<corrections>',
      ...entries,
      '</corrections>',
    ].join('\n')
  }

  /** Number of recorded corrections */
  get count(): number {
    return this.corrections.length
  }

  /** Whether any corrections have been recorded */
  get hasCorrections(): boolean {
    return this.corrections.length > 0
  }

  /** Clear all corrections */
  clear(): void {
    this.corrections.length = 0
  }

  /** Get raw correction entries (for serialization) */
  getEntries(): readonly Correction[] {
    return this.corrections
  }
}
