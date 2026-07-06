import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import {
  SqliteMemoryStore,
  parseAgentsMd,
  seedFromAgentsMd,
  exportToAgentsMd,
} from '../../../src/memory/index.js'

let tmpDir: string
let db: CortexDatabase
let store: SqliteMemoryStore

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-agentsmd-'))
  db = new CortexDatabase(join(tmpDir, 'main.db'), join(tmpDir, 'fx.db'))
  store = new SqliteMemoryStore(db.rawMainHandle, null)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('parseAgentsMd', () => {
  it('returns [] for empty / null input', () => {
    expect(parseAgentsMd(null)).toEqual([])
    expect(parseAgentsMd('')).toEqual([])
    expect(parseAgentsMd('   ')).toEqual([])
  })

  it('extracts user-pinned bullets', () => {
    const md = `# Memory

- Brand color is #F14060
- I work at Ownware`
    expect(parseAgentsMd(md)).toEqual([
      { text: 'Brand color is #F14060', source: 'user' },
      { text: 'I work at Ownware', source: 'user' },
    ])
  })

  it('detects the leading "~" as a learned entry', () => {
    const md = `- ~ User uses Bun on Mac
- I prefer terse responses`
    expect(parseAgentsMd(md)).toEqual([
      { text: 'User uses Bun on Mac', source: 'learned' },
      { text: 'I prefer terse responses', source: 'user' },
    ])
  })

  it('ignores headings, prose, and unparseable lines', () => {
    const md = `# Memory

Some random prose without bullets.

<!-- auto-learn: on -->

- only bullet`
    expect(parseAgentsMd(md)).toEqual([
      { text: 'only bullet', source: 'user' },
    ])
  })

  it('drops empty bullets and oversized content', () => {
    const huge = 'x'.repeat(2001)
    const md = `-
- ${huge}
- ok`
    expect(parseAgentsMd(md)).toEqual([{ text: 'ok', source: 'user' }])
  })
})

describe('seedFromAgentsMd', () => {
  it('inserts one memory per parsed bullet with legacy_import source', () => {
    const md = `- Fact A
- ~ Learned B`
    const created = seedFromAgentsMd(store, 'profile-1', md)
    expect(created).toHaveLength(2)
    expect(created[0]!.source).toBe('legacy_import')
    expect(created[0]!.pinned).toBe(true) // user bullet → pinned
    expect(created[0]!.confidence).toBe(1.0)
    expect(created[1]!.source).toBe('legacy_import')
    expect(created[1]!.pinned).toBe(false) // learned bullet → not pinned
    expect(created[1]!.confidence).toBe(0.8)
  })

  it('is a no-op for empty input', () => {
    expect(seedFromAgentsMd(store, 'p', '')).toEqual([])
    expect(store.countForProfile('p', 'all')).toBe(0)
  })
})

describe('exportToAgentsMd', () => {
  it('produces a markdown file with the right prefix conventions', () => {
    const a = store.create({ profileId: 'p', content: 'User name is Sam', source: 'user_pinned' })
    const b = store.create({ profileId: 'p', content: 'User uses Bun', source: 'agent_proposed' })
    const md = exportToAgentsMd([a, b])
    expect(md).toContain('# Memory')
    expect(md).toContain('exported from ownware.db')
    expect(md).toContain('- User name is Sam')
    expect(md).toContain('- ~ User uses Bun')
  })

  it('omits non-active rows', () => {
    const a = store.create({ profileId: 'p', content: 'active', source: 'user_pinned' })
    const archived = store.create({ profileId: 'p', content: 'archived', source: 'user_pinned' })
    const updated = store.update(archived.id, { status: 'archived' })!
    const md = exportToAgentsMd([a, updated])
    expect(md).toContain('active')
    expect(md).not.toContain('archived')
  })
})
