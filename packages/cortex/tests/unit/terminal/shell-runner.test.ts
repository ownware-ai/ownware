import { describe, it, expect } from 'vitest'
import { PtySession } from '../../../src/terminal/pty-session.js'
import {
  PtyShellRunner,
  stripAnsi,
  type PtyLike,
} from '../../../src/terminal/shell-runner.js'
import { prepareShellIntegration } from '../../../src/terminal/shell-integration.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeSession(): { pty: PtyLike; emit: (s: string) => void; writes: string[] } {
  const writes: string[] = []
  const listeners: Array<(d: string) => void> = []
  const pty: PtyLike = {
    write(data) {
      writes.push(data)
    },
    onData(l) {
      listeners.push(l)
      return () => {
        const i = listeners.indexOf(l)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    exited: null,
  }
  return {
    pty,
    writes,
    emit: (s) => {
      for (const l of listeners.slice()) l(s)
    },
  }
}

/**
 * The runner generates a fresh random nonce per command and bakes it into the
 * single combined write. Tests can't predict it, so they read it back from the
 * write the runner sent (the same trick a real shell's echo would carry).
 */
function nonceOf(write: string): string {
  const m = write.match(/'(cx[0-9a-f]+)'/)
  if (m == null) throw new Error(`no nonce found in write: ${JSON.stringify(write)}`)
  return m[1]!
}

/**
 * Build the bytes a real PTY would emit for one completed command: the echoed
 * command line (which MUST be excluded from the parsed output), then the start
 * marker, the output, and the end marker with the exit code.
 */
function completion(echoedWrite: string, nonce: string, output: string, code: number): string {
  const echo = echoedWrite.replace(/\r$/, '')
  return `${echo}\r\n${nonce}:S\r\n${output}\r\n${nonce}:E:${code}\n`
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('stripAnsi', () => {
  it('removes CSI colour sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
  })

  it('removes OSC sequences', () => {
    expect(stripAnsi('before\x1b]0;title\x07after')).toBe('beforeafter')
  })

  it('leaves plain text unchanged', () => {
    expect(stripAnsi('hello world\n')).toBe('hello world\n')
  })
})

// ---------------------------------------------------------------------------
// Runner with a fake PTY (no real bash)
// ---------------------------------------------------------------------------

describe('PtyShellRunner (fake PTY)', () => {
  it('sends ONE combined write (command + start/end markers, single Enter)', async () => {
    const { pty, emit, writes } = makeFakeSession()
    const runner = new PtyShellRunner({ resolveSession: () => pty })
    const promise = runner.run({
      command: 'echo hello',
      cwd: '/tmp',
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    })
    await Promise.resolve()
    // One write only — the second-write race was the hang bug.
    expect(writes.length).toBe(1)
    const w = writes[0]!
    expect(w).toContain('echo hello')
    expect(w).toContain(':S')
    expect(w).toContain(':E:')
    expect(w).toContain('$__cx_ec')
    expect(w.endsWith('\r')).toBe(true)
    // exactly one carriage return → one logical line
    expect(w.split('\r').length - 1).toBe(1)
    const nonce = nonceOf(w)
    emit(completion(w, nonce, 'hello', 0))
    await promise
  })

  it('extracts clean output and exit code, excluding the command echo + markers', async () => {
    const { pty, emit, writes } = makeFakeSession()
    const runner = new PtyShellRunner({ resolveSession: () => pty })
    const promise = runner.run({
      command: 'echo hello',
      cwd: '/tmp',
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    })
    await Promise.resolve()
    const w = writes[0]!
    const nonce = nonceOf(w)
    emit(completion(w, nonce, 'hello', 0))
    const result = await promise
    expect(result.exitCode).toBe(0)
    expect(result.output).toBe('hello')
    expect(result.output).not.toContain(':S')
    expect(result.output).not.toContain(':E:')
    expect(result.output).not.toContain('echo hello')
    expect(result.terminated).toBeUndefined()
  })

  it('excludes a shell prompt prefix on the echo line', async () => {
    const { pty, emit, writes } = makeFakeSession()
    const runner = new PtyShellRunner({ resolveSession: () => pty })
    const promise = runner.run({
      command: 'ls',
      cwd: '/tmp',
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    })
    await Promise.resolve()
    const w = writes[0]!
    const nonce = nonceOf(w)
    // zsh-style prompt prefixing the echoed line — still before the start marker.
    emit(`user@host /tmp % ${w.replace(/\r$/, '')}\r\n${nonce}:S\r\nfoo\r\nbar\r\n${nonce}:E:0\n`)
    const result = await promise
    expect(result.exitCode).toBe(0)
    expect(result.output).toBe('foo\nbar')
  })

  it('returns non-zero exit when the command fails', async () => {
    const { pty, emit, writes } = makeFakeSession()
    const runner = new PtyShellRunner({ resolveSession: () => pty })
    const promise = runner.run({
      command: 'false',
      cwd: '/tmp',
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    })
    await Promise.resolve()
    const w = writes[0]!
    emit(completion(w, nonceOf(w), '', 1))
    const result = await promise
    expect(result.exitCode).toBe(1)
  })

  it('strips ANSI colour sequences from the output', async () => {
    const { pty, emit, writes } = makeFakeSession()
    const runner = new PtyShellRunner({ resolveSession: () => pty })
    const promise = runner.run({
      command: 'ls --color',
      cwd: '/tmp',
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    })
    await Promise.resolve()
    const w = writes[0]!
    emit(completion(w, nonceOf(w), '\x1b[0;32mgreen-file\x1b[0m', 0))
    const result = await promise
    expect(result.output).toContain('green-file')
    expect(result.output).not.toContain('\x1b[')
  })

  it('false-marker in command output cannot end the command early (nonce)', async () => {
    const { pty, emit, writes } = makeFakeSession()
    const runner = new PtyShellRunner({ resolveSession: () => pty })
    const promise = runner.run({
      command: 'echo done',
      cwd: '/tmp',
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    })
    await Promise.resolve()
    const w = writes[0]!
    const nonce = nonceOf(w)
    // Output prints a marker-shaped line with the WRONG nonce — must be ignored.
    emit(`${w.replace(/\r$/, '')}\r\n${nonce}:S\r\ncxdeadbeef:E:99\r\nreal-output\r\n${nonce}:E:0\n`)
    const result = await promise
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('real-output')
  })

  it('serializes concurrent commands through a mutex (one write each)', async () => {
    const { pty, emit, writes } = makeFakeSession()
    const runner = new PtyShellRunner({ resolveSession: () => pty })
    const a = runner.run({
      command: 'echo A',
      cwd: '/tmp',
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    })
    const b = runner.run({
      command: 'echo B',
      cwd: '/tmp',
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    })

    await Promise.resolve()
    await Promise.resolve()
    // One write per command now (not two).
    expect(writes.length).toBe(1)
    const wa = writes[0]!
    expect(wa).toContain('echo A')

    emit(completion(wa, nonceOf(wa), 'A', 0))
    const resA = await a
    expect(resA.output).toBe('A')

    await Promise.resolve()
    await Promise.resolve()
    expect(writes.length).toBe(2)
    const wb = writes[1]!
    expect(wb).toContain('echo B')

    emit(completion(wb, nonceOf(wb), 'B', 0))
    const resB = await b
    expect(resB.output).toBe('B')
  })

  it('timeout sends Ctrl+C and returns terminated=timeout', async () => {
    const { pty, emit, writes } = makeFakeSession()
    const runner = new PtyShellRunner({
      resolveSession: () => pty,
      recoveryGraceMs: 200,
    })
    const promise = runner.run({
      command: 'sleep 100',
      cwd: '/tmp',
      timeoutMs: 50,
      signal: new AbortController().signal,
    })
    await Promise.resolve()
    const nonce = nonceOf(writes[0]!)
    // Let the timeout fire → Ctrl+C + a rescue end-marker with code 124.
    await new Promise((r) => setTimeout(r, 80))
    expect(writes.some((w) => w.includes('\x03'))).toBe(true)
    expect(writes.some((w) => w.includes('124'))).toBe(true)
    emit(`\n${nonce}:E:124\n`)
    const result = await promise
    expect(result.terminated).toBe('timeout')
    expect(result.exitCode).toBe(124)
  })

  it('abort signal triggers terminated=aborted with exit code 130', async () => {
    const { pty, emit, writes } = makeFakeSession()
    const runner = new PtyShellRunner({
      resolveSession: () => pty,
      recoveryGraceMs: 200,
    })
    const ctrl = new AbortController()
    const promise = runner.run({
      command: 'sleep 100',
      cwd: '/tmp',
      timeoutMs: 5_000,
      signal: ctrl.signal,
    })
    await Promise.resolve()
    const nonce = nonceOf(writes[0]!)
    ctrl.abort()
    await new Promise((r) => setTimeout(r, 30))
    expect(writes.some((w) => w.includes('\x03'))).toBe(true)
    expect(writes.some((w) => w.includes('130'))).toBe(true)
    emit(`\n${nonce}:E:130\n`)
    const result = await promise
    expect(result.terminated).toBe('aborted')
    expect(result.exitCode).toBe(130)
  })

  // ── OSC-633 integration mode ──────────────────────────────────────────

  it('OSC mode: writes only the command (clean echo) and parses C/D markers', async () => {
    const { pty, emit, writes } = makeFakeSession()
    const nonce = 'cxosc123'
    const runner = new PtyShellRunner({
      resolveSession: () => pty,
      resolveIntegration: () => ({ nonce }),
    })
    const promise = runner.run({
      command: 'echo hi',
      cwd: '/tmp',
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    })
    await Promise.resolve()
    // Clean: just the command + Enter, no printf marker noise.
    expect(writes.length).toBe(1)
    expect(writes[0]).toBe('echo hi\r')
    emit(`echo hi\r\n\x1b]633;C;${nonce}\x07\r\nhi\r\n\x1b]633;D;${nonce};0\x07`)
    const result = await promise
    expect(result.exitCode).toBe(0)
    expect(result.output).toBe('hi')
    expect(result.output).not.toContain('633')
    expect(result.output).not.toContain('echo hi')
  })

  it('OSC mode: a startup D before our C does NOT resolve early', async () => {
    const { pty, emit, writes } = makeFakeSession()
    const nonce = 'cxosc456'
    const runner = new PtyShellRunner({
      resolveSession: () => pty,
      resolveIntegration: () => ({ nonce }),
    })
    const promise = runner.run({
      command: 'echo go',
      cwd: '/tmp',
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    })
    await Promise.resolve()
    // Stray startup precmd D (no preceding C) — must be ignored.
    emit(`\x1b]633;D;${nonce};0\x07`)
    expect(writes.length).toBe(1)
    // Now the real command cycle: C → output → D.
    emit(`\x1b]633;C;${nonce}\x07\r\ngo\r\n\x1b]633;D;${nonce};0\x07`)
    const result = await promise
    expect(result.exitCode).toBe(0)
    expect(result.output).toBe('go')
  })

  it('OSC mode: captures non-zero exit from the D marker', async () => {
    const { pty, emit } = makeFakeSession()
    const nonce = 'cxosc789'
    const runner = new PtyShellRunner({
      resolveSession: () => pty,
      resolveIntegration: () => ({ nonce }),
    })
    const promise = runner.run({
      command: 'false',
      cwd: '/tmp',
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    })
    await Promise.resolve()
    emit(`false\r\n\x1b]633;C;${nonce}\x07\r\n\x1b]633;D;${nonce};1\x07`)
    const result = await promise
    expect(result.exitCode).toBe(1)
  })

  it('returns terminated=aborted immediately when session is already exited', async () => {
    const exitedPty: PtyLike = {
      write: () => {},
      onData: () => () => {},
      exited: { exitCode: 0, signal: undefined },
    }
    const runner = new PtyShellRunner({ resolveSession: () => exitedPty })
    const result = await runner.run({
      command: 'echo x',
      cwd: '/tmp',
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    })
    expect(result.terminated).toBe('aborted')
    expect(result.exitCode).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// End-to-end against a real PTY
// ---------------------------------------------------------------------------
//
// Gated behind RUN_LIVE_SHELL_TESTS=1 (they spawn a real shell against the
// dev environment). The NEW marker protocol fixes the old printer-echo leak
// that originally forced this gate — output is sliced strictly between the
// start/end markers, so the echoed command line never reaches the body:
//
//   RUN_LIVE_SHELL_TESTS=1 npx vitest run tests/unit/terminal/shell-runner.test.ts

const RUN_LIVE = process.env['RUN_LIVE_SHELL_TESTS'] === '1'

function makeQuietSession(): PtySession {
  return new PtySession({
    cwd: '/tmp',
    shell: '/bin/bash',
    args: ['--noprofile', '--norc'],
    env: { PS1: '', PROMPT: '', PROMPT_COMMAND: '' },
  })
}

describe.skipIf(!RUN_LIVE)('PtyShellRunner (real PTY)', () => {
  it('runs echo and returns the output + exit code 0', async () => {
    const session = makeQuietSession()
    try {
      const runner = new PtyShellRunner({ resolveSession: () => session })
      const result = await runner.run({
        command: 'echo real-hello',
        cwd: '/tmp',
        timeoutMs: 5_000,
        signal: new AbortController().signal,
      })
      expect(result.exitCode).toBe(0)
      expect(result.output).toContain('real-hello')
      expect(result.output).not.toContain(':E:')
      expect(result.terminated).toBeUndefined()
    } finally {
      session.kill()
    }
  })

  it('preserves state between calls (cd then pwd)', async () => {
    const session = makeQuietSession()
    try {
      const runner = new PtyShellRunner({ resolveSession: () => session })
      await runner.run({
        command: 'cd /',
        cwd: '/tmp',
        timeoutMs: 5_000,
        signal: new AbortController().signal,
      })
      const result = await runner.run({
        command: 'pwd',
        cwd: '/tmp',
        timeoutMs: 5_000,
        signal: new AbortController().signal,
      })
      expect(result.exitCode).toBe(0)
      expect(result.output.trim()).toBe('/')
    } finally {
      session.kill()
    }
  })

  it('captures non-zero exit code for false', async () => {
    const session = makeQuietSession()
    try {
      const runner = new PtyShellRunner({ resolveSession: () => session })
      const result = await runner.run({
        command: 'false',
        cwd: '/tmp',
        timeoutMs: 5_000,
        signal: new AbortController().signal,
      })
      expect(result.exitCode).toBe(1)
    } finally {
      session.kill()
    }
  })
})

// ---------------------------------------------------------------------------
// End-to-end against a real PTY with OSC-633 shell integration (Stage 2)
// ---------------------------------------------------------------------------
//
// The gold path: a REAL zsh spawned with the integration rc (clean prompt +
// invisible OSC markers), driven by the runner in OSC mode. Asserts clean
// output, correct exit codes, state persistence, AND no prompt/path leak.
// Requires $SHELL-style zsh; skips cleanly elsewhere.
//
//   RUN_LIVE_SHELL_TESTS=1 npx vitest run tests/unit/terminal/shell-runner.test.ts

describe.skipIf(!RUN_LIVE)('PtyShellRunner (real PTY, OSC integration)', () => {
  it('runs commands cleanly via OSC markers — output, exit codes, no prompt leak', async () => {
    const integration = prepareShellIntegration({ shell: '/bin/zsh' })
    if (integration == null) return // non-zsh env — skip
    const session = new PtySession({
      cwd: '/tmp',
      shell: integration.shell,
      args: [...integration.args],
      env: integration.env,
    })
    try {
      const runner = new PtyShellRunner({
        resolveSession: () => session,
        resolveIntegration: () => ({ nonce: integration.nonce }),
      })
      const r1 = await runner.run({
        command: 'echo real-osc-output',
        cwd: '/tmp',
        timeoutMs: 10_000,
        signal: new AbortController().signal,
      })
      expect(r1.exitCode).toBe(0)
      expect(r1.output).toContain('real-osc-output')
      // Clean: no OSC marker bytes, no prompt/path noise leaking into output.
      expect(r1.output).not.toContain('633')
      expect(r1.output).not.toContain('%')

      // State persists across calls (same shell process).
      await runner.run({
        command: 'cd /',
        cwd: '/tmp',
        timeoutMs: 10_000,
        signal: new AbortController().signal,
      })
      const r2 = await runner.run({
        command: 'pwd',
        cwd: '/tmp',
        timeoutMs: 10_000,
        signal: new AbortController().signal,
      })
      expect(r2.output.trim()).toBe('/')

      // Non-zero exit captured from the D marker.
      const r3 = await runner.run({
        command: 'false',
        cwd: '/tmp',
        timeoutMs: 10_000,
        signal: new AbortController().signal,
      })
      expect(r3.exitCode).toBe(1)
    } finally {
      session.kill()
    }
  })
})
