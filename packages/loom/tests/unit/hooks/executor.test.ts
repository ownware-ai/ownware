/**
 * Unit Tests — Hook Executor
 *
 * fn-hook coverage is the bulk of runtime tests; here we focus on the
 * command-hook spawn pathway: stdout convention, JSON parse, exit
 * codes, stderr, and timeout.
 */

import { describe, it, expect } from 'vitest'

import { executeHook } from '../../../src/hooks/executor.js'
import type { HookContext } from '../../../src/hooks/types.js'

const PRE_CTX: HookContext = {
  event: 'tool.pre',
  turnIndex: 0,
  toolName: 'shell',
  toolInput: { cmd: 'ls' },
}

describe('executeHook (fn)', () => {
  it('returns the function result verbatim', async () => {
    const result = await executeHook(
      { type: 'fn', name: 'hello', fn: () => ({ continue: true, output: 'hi' }) },
      PRE_CTX,
    )
    expect(result).toEqual({ continue: true, output: 'hi' })
  })

  it('awaits an async function', async () => {
    const result = await executeHook(
      {
        type: 'fn',
        name: 'async-hi',
        fn: async () => {
          await new Promise(r => setTimeout(r, 5))
          return { continue: true }
        },
      },
      PRE_CTX,
    )
    expect(result.continue).toBe(true)
  })

  it('passes the context to the function', async () => {
    let received: HookContext | undefined
    await executeHook(
      {
        type: 'fn',
        name: 'capture',
        fn: (ctx) => {
          received = ctx
          return { continue: true }
        },
      },
      PRE_CTX,
    )
    expect(received?.event).toBe('tool.pre')
    expect(received?.event === 'tool.pre' && received.toolName).toBe('shell')
  })

  it('converts a thrown error into a block', async () => {
    const result = await executeHook(
      {
        type: 'fn',
        name: 'throws',
        fn: () => {
          throw new Error('nope')
        },
      },
      PRE_CTX,
    )
    expect(result.continue).toBe(false)
    expect(result.reason).toBe('nope')
  })
})

describe('executeHook (command)', () => {
  it('treats exit 0 with non-JSON stdout as success with output', async () => {
    const result = await executeHook(
      { type: 'command', name: 'echo', command: 'echo hello' },
      PRE_CTX,
    )
    expect(result.continue).toBe(true)
    expect(result.output).toBe('hello')
  })

  it('parses JSON stdout as a HookResult', async () => {
    const json = '{"continue":false,"reason":"forbidden","output":"see logs"}'
    const result = await executeHook(
      { type: 'command', name: 'json', command: `printf '%s' '${json}'` },
      PRE_CTX,
    )
    expect(result).toEqual({ continue: false, reason: 'forbidden', output: 'see logs' })
  })

  it('treats non-zero exit as a block, with stderr as the reason', async () => {
    const result = await executeHook(
      { type: 'command', name: 'fail', command: 'echo bad >&2; exit 7' },
      PRE_CTX,
    )
    expect(result.continue).toBe(false)
    expect(result.reason).toBe('bad')
  })

  it('falls back to "exited with code" when stderr is empty', async () => {
    const result = await executeHook(
      { type: 'command', name: 'fail2', command: 'exit 5' },
      PRE_CTX,
    )
    expect(result.continue).toBe(false)
    expect(result.reason).toMatch(/exited with code 5/)
  })

  it('honors timeoutMs and converts to a block', async () => {
    const result = await executeHook(
      { type: 'command', name: 'sleeper', command: 'sleep 2', timeoutMs: 50 },
      PRE_CTX,
    )
    expect(result.continue).toBe(false)
    expect(result.reason).toMatch(/timed out after 50ms/)
  })

  it('does not raise an unhandled EPIPE when the command ignores stdin', async () => {
    // `true` never reads stdin and exits immediately, so our write to
    // child.stdin races the closed read-end and fails async with EPIPE.
    // A large payload widens that window. Without an 'error' listener on
    // stdin this surfaces as an unhandled exception that fails the run.
    const bigCtx: HookContext = {
      event: 'tool.pre',
      turnIndex: 0,
      toolName: 'shell',
      toolInput: { cmd: 'x'.repeat(256 * 1024) },
    }
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        executeHook({ type: 'command', name: 'ignores-stdin', command: 'true' }, bigCtx),
      ),
    )
    for (const result of results) expect(result.continue).toBe(true)
  })
})
