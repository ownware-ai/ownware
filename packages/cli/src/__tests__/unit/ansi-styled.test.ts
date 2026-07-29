import { describe, expect, it } from 'vitest'
import { ansiLineToStyledText, stripAnsi } from '../../tui/ansi-styled.js'
import { TOKEN_STYLE } from '../../theme.js'
import { ANSI_STYLE } from '../../style.js'

function textOf(line: string): string {
  return ansiLineToStyledText(line)
    .chunks.map((c) => c.text)
    .join('')
}

describe('ansiLineToStyledText', () => {
  it('reassembles the full visible text with no bytes lost', () => {
    const line = TOKEN_STYLE.cyan('❯ ') + 'hi there'
    expect(textOf(line)).toBe('❯ hi there')
  })

  it('multi-byte glyphs survive styling boundaries', () => {
    const line = TOKEN_STYLE.dim('✻ Thinking...') + ' ' + TOKEN_STYLE.dim('· cache')
    expect(textOf(line)).toBe('✻ Thinking... · cache')
  })

  it('truecolor fg becomes a colored chunk', () => {
    const styled = ansiLineToStyledText(TOKEN_STYLE.cyan('link'))
    expect(styled.chunks).toHaveLength(1)
    expect(styled.chunks[0]!.text).toBe('link')
  })

  it('classic ANSI styles parse too', () => {
    const line = ANSI_STYLE.bold('B') + ANSI_STYLE.red('R') + 'plain'
    expect(textOf(line)).toBe('BRplain')
    expect(ansiLineToStyledText(line).chunks.length).toBeGreaterThanOrEqual(3)
  })

  it('plain text is one chunk, identity', () => {
    const styled = ansiLineToStyledText('no styling here')
    expect(styled.chunks.map((c) => c.text).join('')).toBe('no styling here')
  })

  it('unknown SGR codes are dropped, never rendered as text', () => {
    expect(textOf('a[95mb[0mc')).toBe('abc')
  })
})

describe('stripAnsi', () => {
  it('strips every escape our styles produce', () => {
    expect(stripAnsi(TOKEN_STYLE.bold(TOKEN_STYLE.cyan('x')) + ANSI_STYLE.dim('y'))).toBe('xy')
  })
})
