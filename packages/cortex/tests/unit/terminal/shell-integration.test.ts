import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  makeShellNonce,
  oscCommandStart,
  oscCommandDone,
  prepareShellIntegration,
} from '../../../src/terminal/shell-integration.js'

describe('shell-integration markers', () => {
  it('nonce is hex-only and prefixed', () => {
    const n = makeShellNonce()
    expect(n).toMatch(/^cx[0-9a-f]+$/)
  })

  it('start marker matches the OSC 633 C sequence for the nonce only', () => {
    const re = oscCommandStart('cxabc123')
    expect(re.test('\x1b]633;C;cxabc123\x07')).toBe(true)
    expect(re.test('\x1b]633;C;cxdifferent\x07')).toBe(false)
    expect(re.test('plain text')).toBe(false)
  })

  it('done marker captures the exit code for the nonce', () => {
    const m = oscCommandDone('cxabc123').exec('\x1b]633;D;cxabc123;7\x07')
    expect(m).not.toBeNull()
    expect(m![1]).toBe('7')
    // wrong nonce → no match (anti-spoof)
    expect(oscCommandDone('cxabc123').test('\x1b]633;D;cxother;0\x07')).toBe(false)
  })

  it('captures negative exit codes', () => {
    const m = oscCommandDone('cxn').exec('\x1b]633;D;cxn;-1\x07')
    expect(m![1]).toBe('-1')
  })
})

describe('prepareShellIntegration', () => {
  it('integrates zsh — returns spawn config + writes the rc files', () => {
    const result = prepareShellIntegration({ shell: '/bin/zsh', processEnv: { ZDOTDIR: '/home/u/.zdot' } })
    expect(result).not.toBeNull()
    expect(result!.nonce).toMatch(/^cx[0-9a-f]+$/)
    expect(result!.shell).toBe('/bin/zsh')
    expect(result!.args).toContain('-l')
    expect(result!.args).toContain('-i')
    expect(result!.env['CORTEX_SHELL_NONCE']).toBe(result!.nonce)
    expect(result!.env['CORTEX_USER_ZDOTDIR']).toBe('/home/u/.zdot')
    const zdotdir = result!.env['ZDOTDIR']!
    expect(existsSync(join(zdotdir, '.zshrc'))).toBe(true)
    expect(existsSync(join(zdotdir, '.zshenv'))).toBe(true)
    // The integration installs the OSC hooks + a clean prompt.
    const rc = readFileSync(join(zdotdir, '.zshrc'), 'utf8')
    expect(rc).toContain('add-zsh-hook preexec')
    expect(rc).toContain('add-zsh-hook precmd')
    expect(rc).toContain('633;C')
    expect(rc).toContain('633;D')
    expect(rc).toContain("PROMPT='%# '")
    // It sources the user's config so PATH/aliases survive.
    expect(rc).toContain('.zshrc"')
  })

  it('empty user ZDOTDIR forwards as "" (rc falls back to $HOME)', () => {
    const result = prepareShellIntegration({ shell: '/usr/bin/zsh', processEnv: {} })
    expect(result!.env['CORTEX_USER_ZDOTDIR']).toBe('')
  })

  it('returns null for non-zsh shells (→ runner Stage-1 fallback)', () => {
    expect(prepareShellIntegration({ shell: '/bin/bash' })).toBeNull()
    expect(prepareShellIntegration({ shell: '/usr/bin/fish' })).toBeNull()
    expect(prepareShellIntegration({ shell: '' })).toBeNull()
  })
})
