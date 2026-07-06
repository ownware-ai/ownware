/**
 * Auto-snap, end-to-end through `write_page.execute` against a real temp
 * workspace (fs-level, no sqlite). Proves a raw-colour page now SUCCEEDS,
 * the colours land as :root tokens, the page references var(--…), and an
 * existing token is reused by value.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WRITE_PAGE_TOOL } from '../../profiles/ownware-design/tools/write-page.ts'

type ExecCtx = Parameters<typeof WRITE_PAGE_TOOL.execute>[1]

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'design-snap-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const ctx = (): ExecCtx => ({ workspacePath: dir }) as unknown as ExecCtx

describe('write_page auto-snap (e2e fs)', () => {
  it('snaps raw colours instead of failing the write', async () => {
    const html =
      `<!doctype html><html><head><link rel="stylesheet" href="styles.css">` +
      `<style>.hero{background:#6b3df5}.ov{background:rgba(47,111,235,.15)}</style>` +
      `</head><body><div class="hero">hi</div></body></html>`

    const res = await WRITE_PAGE_TOOL.execute({ name: 'index', html }, ctx())
    expect(res.isError).toBe(false)
    expect(res.content).toContain('Auto-tokenized 2 raw colours')

    const page = await readFile(join(dir, 'index.html'), 'utf-8')
    expect(page).toContain('var(--color-6b3df5)')
    expect(page).toContain('var(--color-2f6feb26)')
    expect(page).not.toContain('#6b3df5')

    const styles = await readFile(join(dir, 'styles.css'), 'utf-8')
    expect(styles).toContain('--color-6b3df5: #6b3df5;')
    expect(styles).toContain('--color-2f6feb26: #2f6feb26;')
  })

  it('reuses an existing token by value (no duplicate minted)', async () => {
    await writeFile(join(dir, 'styles.css'), ':root {\n  --brand: #6b3df5;\n}\n', 'utf-8')
    const html =
      `<!doctype html><html><head><style>.a{color:#6b3df5}</style></head><body></body></html>`

    const res = await WRITE_PAGE_TOOL.execute({ name: 'index', html }, ctx())
    expect(res.isError).toBe(false)

    const page = await readFile(join(dir, 'index.html'), 'utf-8')
    expect(page).toContain('var(--brand)')

    const styles = await readFile(join(dir, 'styles.css'), 'utf-8')
    expect(styles).not.toContain('--color-6b3df5') // reused, not minted
  })

  it('still rejects inline styles (auto-snap is colours only)', async () => {
    const html = `<!doctype html><html><body><div style="background:#fff">x</div></body></html>`
    const res = await WRITE_PAGE_TOOL.execute({ name: 'index', html }, ctx())
    expect(res.isError).toBe(true)
    expect(res.content.toLowerCase()).toContain('inline')
  })
})
