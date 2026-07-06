/**
 * AGENTS.md ↔ memories interop.
 *
 * The DB is canonical. AGENTS.md is now a one-way export view used for
 * profile sharing and human inspection. Two utilities live here:
 *
 *   parseAgentsMd(md)
 *     Given the contents of an AGENTS.md file, extract a list of
 *     bullet entries. Mirrors the format the desktop client's memory
 *     parser has been writing for months — `- text` for user-pinned and
 *     `- ~ text` for auto-learned. Heading lines / prose / unknown
 *     lines are ignored. Output is the source for `seedFromAgentsMd`.
 *
 *   exportToAgentsMd(memories)
 *     Render an array of active memories back into the same format.
 *     Used when the user exports a profile (so the recipient sees
 *     the agent's current notebook in plain markdown). Pinned and
 *     manual entries get the user prefix; agent-proposed get `~ `.
 *
 * Backward-compat seeding flow lives in `seedFromAgentsMd` here, not
 * inside the loader, so the assembler stays free of disk reads beyond
 * what `loadProfile()` already did and the seed step can be unit-tested
 * in isolation.
 */

import type { SqliteMemoryStore } from './store.js'
import type { Memory, MemoryKind } from './schema.js'
import { MAX_MEMORY_CONTENT_CHARS } from './schema.js'

const BULLET_LINE = /^\s*[-*]\s+(.+?)\s*$/
const LEARNED_PREFIX = /^~\s+/

export interface ParsedAgentsBullet {
  readonly text: string
  readonly source: 'user' | 'learned'
}

export function parseAgentsMd(md: string | null | undefined): ParsedAgentsBullet[] {
  if (!md || md.trim().length === 0) return []
  const out: ParsedAgentsBullet[] = []
  for (const line of md.split('\n')) {
    const m = line.match(BULLET_LINE)
    if (!m) continue
    const raw = m[1]!
    const isLearned = LEARNED_PREFIX.test(raw)
    const text = (isLearned ? raw.replace(LEARNED_PREFIX, '') : raw).trim()
    if (text.length === 0 || text.length > MAX_MEMORY_CONTENT_CHARS) continue
    out.push({ text, source: isLearned ? 'learned' : 'user' })
  }
  return out
}

/**
 * Seed `memories` from an AGENTS.md string for a profile that has
 * never been touched by the new system. Idempotent guard at the call
 * site (caller checks `countForProfile === 0`); we do NOT branch on
 * existing rows here so the function stays pure for tests.
 *
 * Returns the inserted Memory[].
 */
export function seedFromAgentsMd(
  store: SqliteMemoryStore,
  profileId: string,
  md: string | null | undefined,
): Memory[] {
  const bullets = parseAgentsMd(md)
  if (bullets.length === 0) return []
  const created: Memory[] = []
  for (const b of bullets) {
    created.push(
      store.create({
        profileId,
        content: b.text,
        kind: 'fact' as MemoryKind,
        source: 'legacy_import',
        confidence: b.source === 'user' ? 1.0 : 0.8,
        pinned: b.source === 'user',
      }),
    )
  }
  return created
}

/**
 * Render a list of memories back into AGENTS.md format. Used on
 * profile export. Pinned + user-sourced entries are written without
 * the `~ ` prefix; agent-proposed/reflection/legacy_import entries
 * get the prefix to preserve the visual distinction the client's UI
 * already understands.
 */
export function exportToAgentsMd(memories: readonly Memory[]): string {
  const head: string[] = ['# Memory', '', '<!-- exported from ownware.db -->', '']
  if (memories.length === 0) {
    return head.join('\n') + '\n'
  }
  const lines: string[] = []
  for (const m of memories) {
    if (m.status !== 'active') continue
    const learnedPrefix = m.source === 'user_pinned' ? '' : '~ '
    lines.push(`- ${learnedPrefix}${m.content}`)
  }
  return [...head, ...lines, ''].join('\n')
}
