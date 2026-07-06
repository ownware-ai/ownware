/**
 * auto-snap — colour normalization + tokenization. Pure (no sqlite), so
 * it runs in any shell.
 */

import { describe, expect, it } from 'vitest'
import {
  normalizeColor,
  parseRootColorTokens,
  autoSnapColors,
  autoSnapHtml,
  upsertTokensIntoRoot,
} from '../../../profiles/ownware-design/helpers/auto-snap.ts'

describe('normalizeColor', () => {
  it('canonicalizes hex (short → long, lowercase, drops opaque alpha)', () => {
    expect(normalizeColor('#FFF')).toBe('#ffffff')
    expect(normalizeColor('#6B3DF5')).toBe('#6b3df5')
    expect(normalizeColor('#0d1117ff')).toBe('#0d1117')
  })
  it('keeps a real alpha as hex8', () => {
    expect(normalizeColor('#00000080')).toBe('#00000080')
  })
  it('converts rgb/rgba (comma + modern syntax)', () => {
    expect(normalizeColor('rgb(255,255,255)')).toBe('#ffffff')
    expect(normalizeColor('rgba(47,111,235,0)')).toBe('#2f6feb00')
    expect(normalizeColor('rgb(47 111 235 / 15%)')).toBe('#2f6feb26')
  })
  it('converts hsl', () => {
    expect(normalizeColor('hsl(0, 0%, 100%)')).toBe('#ffffff')
    expect(normalizeColor('hsl(0,0%,0%)')).toBe('#000000')
  })
  it('returns null for non-colours', () => {
    expect(normalizeColor('16px')).toBeNull()
    expect(normalizeColor('var(--x)')).toBeNull()
  })
  it('treats equal colours written differently as the same canonical', () => {
    expect(normalizeColor('#fff')).toBe(normalizeColor('rgb(255,255,255)'))
  })
})

describe('parseRootColorTokens', () => {
  it('maps canonical colour → existing token name', () => {
    const root = ':root {\n  --video-bg-start: #0d1117;\n  --radius: 8px;\n}'
    const map = parseRootColorTokens(root)
    expect(map.get('#0d1117')).toBe('video-bg-start')
    expect(map.has('#000000')).toBe(false) // radius is not a colour
  })
})

describe('autoSnapColors', () => {
  it('mints --color-<hex> for a new raw colour and substitutes var()', () => {
    const r = autoSnapColors('.a { color: #6b3df5; }', new Map())
    expect(r.out).toBe('.a { color: var(--color-6b3df5); }')
    expect(r.newTokens).toEqual([{ name: 'color-6b3df5', value: '#6b3df5' }])
  })
  it('reuses an existing token by value instead of minting', () => {
    const existing = new Map([['#0d1117', 'video-bg-start']])
    const r = autoSnapColors('.video { background: #0d1117; }', existing)
    expect(r.out).toBe('.video { background: var(--video-bg-start); }')
    expect(r.newTokens).toHaveLength(0)
  })
  it('dedupes the same colour to ONE token across occurrences', () => {
    const r = autoSnapColors('.a{color:rgb(47,111,235)} .b{border-color:#2f6feb}', new Map())
    expect(r.newTokens).toHaveLength(1)
    expect(r.out).toContain('var(--color-2f6feb)')
    expect(r.out.match(/var\(--color-2f6feb\)/g)).toHaveLength(2)
  })
  it('leaves colours inside a :root block untouched', () => {
    const css = ':root { --accent: #6b3df5; }\n.a { color: #6b3df5; }'
    const r = autoSnapColors(css, new Map())
    expect(r.out).toContain('--accent: #6b3df5;') // root literal kept
    expect(r.out).toContain('color: var(--color-6b3df5)') // body snapped
  })
  it('leaves var() and lengths alone', () => {
    const r = autoSnapColors('.a { color: var(--x); padding: 16px; }', new Map())
    expect(r.out).toBe('.a { color: var(--x); padding: 16px; }')
    expect(r.newTokens).toHaveLength(0)
  })
})

describe('autoSnapHtml', () => {
  it('snaps colours only inside <style> blocks', () => {
    const html = '<style>.a{color:#6b3df5}</style>\n<div class="a">#notacolor text</div>'
    const r = autoSnapHtml(html, new Map())
    expect(r.out).toContain('color:var(--color-6b3df5)')
    expect(r.out).toContain('#notacolor text') // body text untouched
    expect(r.newTokens).toEqual([{ name: 'color-6b3df5', value: '#6b3df5' }])
  })
})

describe('upsertTokensIntoRoot', () => {
  it('creates a :root block when none exists', () => {
    const out = upsertTokensIntoRoot('.a { color: red; }', [{ name: 'color-6b3df5', value: '#6b3df5' }])
    expect(out).toMatch(/^:root \{\n {2}--color-6b3df5: #6b3df5;\n\}/)
  })
  it('appends into an existing :root', () => {
    const out = upsertTokensIntoRoot(':root {\n  --accent: #000;\n}', [{ name: 'color-6b3df5', value: '#6b3df5' }])
    expect(out).toContain('--accent: #000;')
    expect(out).toContain('--color-6b3df5: #6b3df5;')
  })
})
