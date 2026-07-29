import { describe, expect, it } from 'vitest'
import { MarkdownStream } from '../../markdown-ansi.js'
import { ANSI_STYLE, PLAIN_STYLE, type Style } from '../../style.js'

// A tagging style so assertions read the structure, not escape codes.
const TAG_STYLE: Style = {
  dim: (s) => `<d>${s}</d>`,
  bold: (s) => `<b>${s}</b>`,
  italic: (s) => `<i>${s}</i>`,
  red: (s) => `<r>${s}</r>`,
  green: (s) => `<g>${s}</g>`,
  cyan: (s) => `<c>${s}</c>`,
  strike: (s) => `<s>${s}</s>`,
}

function render(chunks: string[], style: Style = TAG_STYLE): string {
  let buf = ''
  const md = new MarkdownStream(style, (chunk) => {
    buf += chunk
  })
  for (const chunk of chunks) md.feed(chunk)
  md.flush()
  return buf
}

describe('MarkdownStream', () => {
  it('renders bold, italic, code, links inline', () => {
    expect(render(['This is **bold**, *it*, `code`, [docs](https://x.dev).\n'])).toBe(
      'This is <b>bold</b>, <i>it</i>, <c>code</c>, docs <d>(https://x.dev)</d>.\n',
    )
  })

  it('spans split across deltas still render (line-buffered)', () => {
    expect(render(['This is **bo', 'ld** text\n'])).toBe('This is <b>bold</b> text\n')
  })

  it('headings render bold with the marker stripped', () => {
    expect(render(['## What I can do\n'])).toBe('<b>What I can do</b>\n')
  })

  it('bullets become dot rows', () => {
    expect(render(['- **Write code** — features\n  - nested\n'])).toBe(
      '<d>•</d> <b>Write code</b> — features\n  <d>•</d> nested\n',
    )
  })

  it('fences pass contents verbatim, markers dimmed', () => {
    expect(render(['```ts\nconst x = **notbold**\n```\n'])).toBe(
      '<d>```ts</d>\nconst x = **notbold**\n<d>```</d>\n',
    )
  })

  it('table pipes dim, cells render', () => {
    expect(render(['| a | **b** |\n|---|---|\n'])).toBe(
      '<d>|</d> a <d>|</d> <b>b</b> <d>|</d>\n<d>|---|---|</d>\n',
    )
  })

  it('blockquotes and rules', () => {
    expect(render(['> quoted\n---\n'])).toBe('<d>│ </d><d>quoted</d>\n<d>───</d>\n')
  })

  it('flush closes a partial line', () => {
    let buf = ''
    const md = new MarkdownStream(TAG_STYLE, (chunk) => {
      buf += chunk
    })
    md.feed('no newline yet')
    expect(buf).toBe('')
    expect(md.pending).toBe(true)
    md.flush()
    expect(buf).toBe('no newline yet\n')
    expect(md.pending).toBe(false)
  })

  it('plain text is identity (minus buffering)', () => {
    expect(render(['just a sentence.\n'])).toBe('just a sentence.\n')
  })

  it('PLAIN_STYLE strips markers without emitting any escapes', () => {
    const out = render(['# Head\n**bold** and *it*\n'], PLAIN_STYLE)
    expect(out).toBe('Head\nbold and it\n')
    expect(out).not.toContain('')
  })

  it('ANSI_STYLE emits real escapes', () => {
    expect(render(['**b**\n'], ANSI_STYLE)).toBe('[1mb[22m\n')
  })
})
