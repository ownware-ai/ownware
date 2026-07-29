import { describe, expect, it } from 'vitest'
import { buildBanner, fitPath } from '../../banner.js'
import { PLAIN_STYLE } from '../../style.js'

const stripBar = (line: string): string => line.replace(/^▌ /, '')

describe('fitPath', () => {
  it('leaves a path that already fits alone', () => {
    expect(fitPath('~/code/app', 40)).toBe('~/code/app')
  })

  it('drops the MIDDLE, keeping the tail that identifies the project', () => {
    const fitted = fitPath('/very/long/prefix/that/nobody/reads/my-project/src', 30)
    expect(fitted.length).toBeLessThanOrEqual(30)
    expect(fitted).toContain('…')
    // The end is what the customer is looking for.
    expect(fitted.endsWith('my-project/src')).toBe(true)
  })

  it('never exceeds the budget even when absurdly small', () => {
    for (const max of [1, 2, 3, 5, 8]) {
      expect(fitPath('/a/very/long/path/indeed', max).length).toBeLessThanOrEqual(max)
    }
  })
})

describe('buildBanner width fitting (F1)', () => {
  const info = {
    version: '0.3.0',
    profileId: 'ownware-code',
    model: 'ollama:llama3.2',
    cwd: '/private/var/folders/7n/6xsykpbn3tl15gx1rjqbbxc00000gn/T/ownware-journey-first-run/project',
    baseUrl: 'http://127.0.0.1:63144',
    owned: true,
    logFile: '/private/var/folders/7n/6xsykpbn3tl15gx1rjqbbxc00000gn/T/ownware-journey/data/cli/gateway.log',
  }

  it('keeps every row inside the terminal width', () => {
    // A deep cwd used to wrap the ▌ row into a bar-less second row.
    for (const width of [60, 80, 100, 120]) {
      const rows = buildBanner(info, PLAIN_STYLE, width).trimEnd().split('\n')
      for (const row of rows) {
        expect(row.length, `width ${width}: ${row}`).toBeLessThanOrEqual(width)
      }
    }
  })

  it('still shows the gateway and the end of the path', () => {
    const rows = buildBanner(info, PLAIN_STYLE, 80).trimEnd().split('\n')
    const location = stripBar(rows[2]!)
    expect(location).toContain('127.0.0.1:63144 (local)')
    expect(location).toContain('project')
  })

  it('does not truncate when there is room', () => {
    const rows = buildBanner({ ...info, cwd: '~/code/app' }, PLAIN_STYLE, 100).trimEnd().split('\n')
    expect(stripBar(rows[2]!)).toBe('~/code/app · 127.0.0.1:63144 (local)')
  })
})
