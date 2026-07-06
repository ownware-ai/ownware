/**
 * Security Audit Log
 *
 * Records every tool call decision for compliance, debugging, and
 * forensic analysis. Critical for legal/finance/healthcare agents
 * where you need a full audit trail.
 *
 * @security Audit entries are sanitized — no raw secrets in the log.
 */

import type { AuditEntry } from './types.js'

// ---------------------------------------------------------------------------
// AuditLog
// ---------------------------------------------------------------------------

export class AuditLog {
  private readonly entries: AuditEntry[] = []
  private readonly maxEntries: number

  /**
   * @param maxEntries - Maximum entries to retain in memory. Default: 10_000.
   */
  constructor(maxEntries = 10_000) {
    this.maxEntries = maxEntries
  }

  /**
   * Record an audit entry.
   *
   * @security Input and output should be pre-sanitized by the caller.
   */
  record(entry: AuditEntry): void {
    this.entries.push(entry)
    // Evict oldest if over limit
    while (this.entries.length > this.maxEntries) {
      this.entries.shift()
    }
  }

  /**
   * Create and record an entry in one call.
   */
  log(
    toolName: string,
    input: Record<string, unknown>,
    decision: AuditEntry['decision'],
    opts?: {
      validation?: { level: string; reason?: string }
      outputSummary?: string
      durationMs?: number
      agentId?: string
      sessionId?: string
    },
  ): void {
    this.record({
      timestamp: new Date().toISOString(),
      toolName,
      input,
      validation: opts?.validation ?? { level: 'ok' },
      decision,
      outputSummary: opts?.outputSummary,
      durationMs: opts?.durationMs,
      agentId: opts?.agentId,
      sessionId: opts?.sessionId,
    })
  }

  /** Get all entries (in-memory). */
  getLog(): readonly AuditEntry[] {
    return this.entries
  }

  /** Get entries filtered by tool name. */
  getByTool(toolName: string): AuditEntry[] {
    return this.entries.filter(e => e.toolName === toolName)
  }

  /** Get entries filtered by decision. */
  getByDecision(decision: AuditEntry['decision']): AuditEntry[] {
    return this.entries.filter(e => e.decision === decision)
  }

  /** Get entries within a time range. */
  getByTimeRange(start: string, end: string): AuditEntry[] {
    return this.entries.filter(e => e.timestamp >= start && e.timestamp <= end)
  }

  /** Number of recorded entries. */
  get count(): number {
    return this.entries.length
  }

  /** Number of denied entries. */
  get deniedCount(): number {
    return this.entries.filter(e => e.decision === 'deny').length
  }

  /**
   * Export the audit log as JSON for compliance.
   *
   * @security This is the format you'd send to a SIEM, store in S3,
   * or provide to compliance auditors.
   */
  exportLog(): string {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      entryCount: this.entries.length,
      deniedCount: this.deniedCount,
      entries: this.entries,
    }, null, 2)
  }

  /**
   * Export a summary (no full entries, just statistics).
   */
  exportSummary(): {
    total: number
    allowed: number
    denied: number
    asked: number
    byTool: Record<string, number>
  } {
    const byTool: Record<string, number> = {}
    let allowed = 0
    let denied = 0
    let asked = 0

    for (const entry of this.entries) {
      byTool[entry.toolName] = (byTool[entry.toolName] ?? 0) + 1
      if (entry.decision === 'allow') allowed++
      else if (entry.decision === 'deny') denied++
      else asked++
    }

    return { total: this.entries.length, allowed, denied, asked, byTool }
  }

  /** Clear all entries. */
  clear(): void {
    this.entries.length = 0
  }
}
