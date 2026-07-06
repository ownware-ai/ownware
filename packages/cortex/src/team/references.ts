/**
 * Reference docs rendering — the standing docs a team keeps on hand,
 * composed into a single bounded section that is injected identically
 * into the conductor's SOUL and every member handoff so the whole team
 * works from the same source.
 *
 * One renderer, two call sites (Principle 4): the section is byte-for-
 * byte the same whether the conductor or a member reads it. Content is
 * already capped at the schema boundary (≤8k chars × ≤6 docs).
 */

import type { TeamReference } from './schema.js'

export function renderReferenceSection(references: readonly TeamReference[]): string {
  if (references.length === 0) return ''
  const docs = references.map((r) => `### ${r.name}\n\n${r.content.trim()}`).join('\n\n')
  return `## Reference — docs the team keeps on hand\n\n${docs}\n`
}
