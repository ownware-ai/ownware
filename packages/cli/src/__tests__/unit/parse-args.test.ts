import { describe, expect, it } from 'vitest'
import { forwardGlobals, parseArgs, pickDefaultProfile, splitSubcommand } from '../../index.js'

describe('parseArgs', () => {
  it('parses the S1 flag set', () => {
    const flags = parseArgs([
      '--profile', 'ownware-code',
      '--model', 'ollama:llama3.2',
      '--base-url', 'http://127.0.0.1:4000',
      '--resume',
      '--debug-events',
    ])
    expect(flags).toMatchObject({
      profile: 'ownware-code',
      model: 'ollama:llama3.2',
      baseUrl: 'http://127.0.0.1:4000',
      resume: true,
      debugEvents: true,
    })
  })

  it('rejects unknown options honestly instead of guessing', () => {
    expect(() => parseArgs(['--frobnicate'])).toThrow(/Unknown option/)
  })
})

describe('pickDefaultProfile', () => {
  it('prefers ownware-code, falls back to the first profile, null when empty', () => {
    expect(pickDefaultProfile([{ id: 'ari' }, { id: 'ownware-code' }])).toBe('ownware-code')
    expect(pickDefaultProfile([{ id: 'ari' }, { id: 'law' }])).toBe('ari')
    expect(pickDefaultProfile([])).toBeNull()
  })
})

describe('splitSubcommand — globals before a subcommand', () => {
  it('finds a subcommand that follows global flags (F5)', () => {
    // Was: `Unknown option: exec` — the error blamed the subcommand for
    // the ordering that every other CLI accepts.
    const split = splitSubcommand(['--data-dir', '/tmp/x', 'exec', '-p', 'hi'])
    expect(split).toEqual({
      globals: ['--data-dir', '/tmp/x'],
      command: 'exec',
      rest: ['-p', 'hi'],
    })
  })

  it('steps over the values that global flags consume', () => {
    // 'exec' here is the VALUE of --profile, not a subcommand.
    expect(splitSubcommand(['--profile', 'exec'])).toBeNull()
    expect(splitSubcommand(['--model', 'attach', '--simple'])).toBeNull()
  })

  it('still finds a subcommand at position 0', () => {
    expect(splitSubcommand(['exec', '-p', 'hi'])?.command).toBe('exec')
    expect(splitSubcommand(['attach', 'http://x'])?.command).toBe('attach')
  })

  it('leaves ordinary chat argv, unknown flags and bare words alone', () => {
    expect(splitSubcommand([])).toBeNull()
    expect(splitSubcommand(['--resume'])).toBeNull()
    expect(splitSubcommand(['--nonsense', 'exec'])).toBeNull()
    expect(splitSubcommand(['notacommand'])).toBeNull()
  })
})

describe('forwardGlobals', () => {
  it('forwards short forms in their long form', () => {
    // `-p` is --profile to the chat loop but --prompt to exec; passing
    // the short form through would silently change its meaning.
    expect(forwardGlobals(['-p', 'ownware-code', '-m', 'ollama:llama3.2'], 'exec')).toEqual([
      '--profile', 'ownware-code',
      '--model', 'ollama:llama3.2',
    ])
  })

  it('passes long forms through unchanged', () => {
    expect(forwardGlobals(['--data-dir', '/tmp/x', '--token', 't'], 'exec')).toEqual([
      '--data-dir', '/tmp/x',
      '--token', 't',
    ])
  })

  it('names a chat-only flag rather than dropping it silently', () => {
    // Dropping it would run something the customer did not ask for.
    expect(() => forwardGlobals(['--simple'], 'exec')).toThrow(/--simple applies to the chat loop/)
    expect(() => forwardGlobals(['--resume'], 'exec')).toThrow(/--resume/)
  })
})
