/**
 * Assembler wiring test for profile hooks — proves the bridge is
 * connected end-to-end at the assembly layer:
 *
 *   agent.json hooks → loadProfile → assembleAgent → AssembledAgent
 *   carries a live HookRuntime + the ReminderInjector it emits into.
 *
 * Runs the real loader + real assembler (no mocks); no network calls
 * happen at assembly.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { assembleAgent } from '../../../src/profile/assembler.js'
import { loadProfile } from '../../../src/profile/loader.js'
import { HookConfigError } from '../../../src/profile/hooks.js'
import { createTempProfile } from '../../helpers/fixtures.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

function track<T extends { cleanup: () => Promise<void> }>(p: T): T {
  cleanups.push(p.cleanup)
  return p
}

describe('assembleAgent — hook wiring', () => {
  it('assembles a hooked profile with a live runtime + injector pair', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({
        name: 'hooked-agent',
        hooks: {
          onToolCall: [{ action: 'log' }],
          onStart: [{ action: 'webhook', url: 'https://ops.example.com/audit' }],
        },
      }),
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)

    expect(agent.hookRuntime).not.toBeNull()
    expect(agent.reminderInjector).not.toBeNull()
    expect(agent.hookRuntime!.has('tool.pre')).toBe(true)
    expect(agent.hookRuntime!.has('session.start')).toBe(true)
    expect(agent.hookRuntime!.has('tool.post')).toBe(false)
  })

  it('assembles a hook-free profile with null hook fields (no-hook path unchanged)', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'plain-agent' }),
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)

    expect(agent.hookRuntime).toBeNull()
    expect(agent.reminderInjector).toBeNull()
  })

  it('fails assembly loudly on a malformed hook (loud-or-dead)', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({
        name: 'bad-hook-agent',
        hooks: { onToolCall: [{ action: 'webhook', url: 'http://example.com/x' }] },
      }),
    }))
    const profile = await loadProfile(dir)
    await expect(assembleAgent(profile)).rejects.toThrow(HookConfigError)
  })

  it('fails assembly on a command hook without operator opt-in', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({
        name: 'cmd-hook-agent',
        hooks: { onToolCall: [{ action: 'command', command: 'echo hi' }] },
      }),
    }))
    const profile = await loadProfile(dir)
    await expect(assembleAgent(profile)).rejects.toThrow(/disabled by default/)
    // …and succeeds when the operator opts in.
    const agent = await assembleAgent(profile, { hooks: { allowCommandHooks: true } })
    expect(agent.hookRuntime).not.toBeNull()
  })
})
