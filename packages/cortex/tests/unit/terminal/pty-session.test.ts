import { describe, it, expect } from 'vitest'
import { PtySession, computeReadLines } from '../../../src/terminal/pty-session.js'

/**
 * These tests spawn a real bash — they only run in environments where
 * `node-pty` loaded and `spawn-helper` has the exec bit set. Any CI
 * that skips postinstall will fail here with `posix_spawnp failed`;
 * that's the signal to rebuild native deps, not to skip the test.
 */

function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`waitFor timed out after ${timeoutMs}ms`))
      }
      setTimeout(tick, 20)
    }
    tick()
  })
}

describe('PtySession', () => {
  it('spawns a shell and streams echoed input back to listeners', async () => {
    const session = new PtySession({ cwd: '/tmp', args: ['-l'] })
    let captured = ''
    session.onData((d) => {
      captured += d
    })
    session.write('echo READY-MARKER\n')
    try {
      await waitFor(() => captured.includes('READY-MARKER'))
    } finally {
      session.kill()
    }
    expect(captured).toContain('READY-MARKER')
  })

  it('scrollback returns the concatenated output', async () => {
    const session = new PtySession({ cwd: '/tmp', args: ['-l'] })
    session.write('echo SCROLL-ONE\n')
    try {
      await waitFor(() => session.scrollback().includes('SCROLL-ONE'))
    } finally {
      session.kill()
    }
    expect(session.scrollback()).toContain('SCROLL-ONE')
  })

  it('ring buffer enforces the byte cap', async () => {
    // 2 KiB cap + 200 × ~10-byte lines = deliberate overflow. The
    // test verifies both that the cap holds and that the TAIL of the
    // stream survives (trimming is head-first). Cap needs to be a
    // handful of lines' worth — 256 was too tight to guarantee
    // LINE-200 stayed in the buffer under different shells + widths.
    const session = new PtySession({
      cwd: '/tmp',
      args: ['-l'],
      scrollbackBytes: 2_048,
      scrollbackLines: 10_000,
    })
    session.write('for i in $(seq 1 200); do echo "LINE-$i"; done\n')
    try {
      await waitFor(() => session.scrollback().includes('LINE-200'))
    } finally {
      session.kill()
    }
    // The byte cap is soft for the trailing chunk. Total must stay
    // within a small multiple of the configured cap — we're proving
    // that old lines are trimmed, not that the cap is exact.
    expect(Buffer.byteLength(session.scrollback(), 'utf8')).toBeLessThan(
      2_048 * 4,
    )
    // LINE-1 and LINE-2 should be gone (they were at the head).
    expect(session.scrollback()).not.toContain('LINE-1\n')
  })

  it('exit listener fires on kill', async () => {
    const session = new PtySession({ cwd: '/tmp', args: ['-l'] })
    let exited = false
    session.onExit(() => {
      exited = true
    })
    session.kill()
    await waitFor(() => exited, 2_000)
    expect(exited).toBe(true)
    expect(session.exited).not.toBeNull()
  })

  it('status is "running" initially, "killing" after kill() (before exit), then "killed"', async () => {
    const session = new PtySession({ cwd: '/tmp', args: ['-l'] })
    expect(session.status).toBe('running')
    session.kill()
    // Immediately after kill(): the child hasn't been reaped yet;
    // status must be `killing`. On some macOS configs node-pty's exit
    // listener fires synchronously on kill() and flips us straight to
    // `killed` — accept either here, but require that once the exit
    // listener has fired the status settles on `killed` (not `exited`).
    expect(['killing', 'killed']).toContain(session.status)
    await waitFor(() => session.exited != null, 2_000)
    expect(session.status).toBe('killed')
  })

  it('write after kill is a no-op (no throw)', () => {
    const session = new PtySession({ cwd: '/tmp', args: ['-l'] })
    session.kill()
    expect(() => session.write('echo after-kill\n')).not.toThrow()
  })

  it('resize validates inputs and ignores non-positive values', () => {
    const session = new PtySession({ cwd: '/tmp', args: ['-l'] })
    try {
      expect(() => session.resize(0, 0)).not.toThrow()
      expect(() => session.resize(-5, 100)).not.toThrow()
      expect(() => session.resize(80, 24)).not.toThrow()
    } finally {
      session.kill()
    }
  })

  // readLines is a pure line-based view over the scrollback ring
  // buffer. To drive deterministic input we rely on the PTY echoing
  // typed bytes back (the `\n` → `\r\n` translation from the kernel
  // ptty driver is the entire "shell running" these tests need). This
  // keeps the assertions stable across environments where a real
  // shell may or may not execute follow-up commands inside the PTY.

  it('readLines paginates the scrollback by offset/limit', async () => {
    const session = new PtySession({ cwd: '/tmp', args: ['-l'] })
    session.write('ALPHA\nBETA\nGAMMA\nDELTA\n')
    try {
      await waitFor(() => session.scrollback().includes('DELTA'))
      // Seed landed; readLines should see four lines.
      const all = session.readLines({ limit: 100 })
      expect(all.lines.map((l) => l.text)).toEqual([
        'ALPHA',
        'BETA',
        'GAMMA',
        'DELTA',
      ])
      expect(all.lines[0]!.lineNumber).toBe(1)
      expect(all.totalLines).toBe(4)
      expect(all.hasMore).toBe(false)
      expect(all.filter).toBeNull()

      // Middle slice — offset 1, limit 2 → BETA, GAMMA. hasMore is
      // true because DELTA (line 4) remains past the window.
      const mid = session.readLines({ offset: 1, limit: 2 })
      expect(mid.lines.map((l) => l.text)).toEqual(['BETA', 'GAMMA'])
      expect(mid.lines.map((l) => l.lineNumber)).toEqual([2, 3])
      expect(mid.totalLines).toBe(4)
      expect(mid.offset).toBe(1)
      expect(mid.hasMore).toBe(true)
    } finally {
      session.kill()
    }
  })

  it('readLines with a pattern filters matches and reports matchCount', async () => {
    const session = new PtySession({ cwd: '/tmp', args: ['-l'] })
    session.write('err-one\nnormal\nerr-two\nfinal\n')
    try {
      await waitFor(() => session.scrollback().includes('final'))
      const result = session.readLines({ pattern: /^err-/, limit: 100 })
      expect(result.lines.map((l) => l.text)).toEqual(['err-one', 'err-two'])
      // Line numbers reference the ORIGINAL buffer, not the filtered
      // position: err-one is line 1, err-two is line 3.
      expect(result.lines.map((l) => l.lineNumber)).toEqual([1, 3])
      expect(result.totalLines).toBe(2) // matches, not raw lines
      expect(result.filter).toEqual({
        pattern: '^err-',
        ignoreCase: false,
        matchCount: 2,
      })
      expect(result.hasMore).toBe(false)
    } finally {
      session.kill()
    }
  })

})

// ---------------------------------------------------------------------------
// Pure helper tests — exercised against computeReadLines so the
// truncation / filter / pagination edge-cases are pinned without
// fighting the macOS PTY 1024-byte canonical-mode line cap.
// ---------------------------------------------------------------------------

describe('computeReadLines', () => {
  it('clips lines longer than the per-line cap and flags them', () => {
    const longLine = 'Q'.repeat(2500)
    const result = computeReadLines([longLine, 'tail-sentinel'])
    const truncated = result.lines.find((l) => l.truncated === true)
    expect(truncated).toBeDefined()
    expect(truncated!.lineNumber).toBe(1)
    expect(truncated!.text).toMatch(/^Q+… \(\+500 more chars\)$/)
    // Clipped text = 2000 Qs + "… (+500 more chars)" = 2019 chars.
    expect(truncated!.text.length).toBeLessThan(2_000 + 64)
    // Non-truncated neighbour is returned unmarked.
    const sentinel = result.lines.find((l) => l.text === 'tail-sentinel')
    expect(sentinel).toBeDefined()
    expect(sentinel!.truncated).toBeUndefined()
  })

  it('returns an empty result on an empty buffer', () => {
    expect(computeReadLines([])).toEqual({
      lines: [],
      totalLines: 0,
      offset: 0,
      hasMore: false,
      filter: null,
    })
  })

  it('floors a non-integer offset and clamps negative offsets to 0', () => {
    const r1 = computeReadLines(['a', 'b', 'c'], { offset: 1.7 })
    expect(r1.offset).toBe(1)
    expect(r1.lines.map((l) => l.text)).toEqual(['b', 'c'])
    const r2 = computeReadLines(['a', 'b', 'c'], { offset: -5 })
    expect(r2.offset).toBe(0)
    expect(r2.lines.map((l) => l.text)).toEqual(['a', 'b', 'c'])
  })

  it('a limit of 0 returns no lines but still reports totalLines', () => {
    const r = computeReadLines(['a', 'b', 'c'], { limit: 0 })
    expect(r.lines).toEqual([])
    expect(r.totalLines).toBe(3)
    expect(r.hasMore).toBe(true)
  })

  it('pattern with no matches returns empty lines and matchCount 0', () => {
    const r = computeReadLines(['info', 'info', 'info'], { pattern: /error/ })
    expect(r.lines).toEqual([])
    expect(r.totalLines).toBe(0)
    expect(r.filter).toEqual({ pattern: 'error', ignoreCase: false, matchCount: 0 })
  })

  it('pattern paginates the matches, preserving original line numbers', () => {
    const buf = ['err-1', 'ok', 'err-2', 'ok', 'err-3', 'ok', 'err-4']
    const r = computeReadLines(buf, { pattern: /^err-/, offset: 1, limit: 2 })
    expect(r.lines).toEqual([
      { lineNumber: 3, text: 'err-2' },
      { lineNumber: 5, text: 'err-3' },
    ])
    expect(r.totalLines).toBe(4) // total matches
    expect(r.offset).toBe(1)
    expect(r.hasMore).toBe(true) // err-4 still past the window
  })

  it('ignoreCase is reflected in the filter echo', () => {
    const r = computeReadLines(['ERROR', 'error', 'info'], {
      pattern: /error/i,
    })
    expect(r.lines.map((l) => l.text)).toEqual(['ERROR', 'error'])
    expect(r.filter?.ignoreCase).toBe(true)
  })

  it('onData unsubscribe is idempotent', async () => {
    const session = new PtySession({ cwd: '/tmp', args: ['-l'] })
    let count = 0
    const off = session.onData(() => {
      count++
    })
    session.write('echo FIRST\n')
    await waitFor(() => count > 0)
    off()
    off() // second call — must be safe
    const countAfterOff = count
    session.write('echo SECOND\n')
    // Give the PTY a moment to produce output. The listener is
    // detached; count shouldn't grow further.
    await new Promise((resolve) => setTimeout(resolve, 150))
    session.kill()
    expect(count).toBe(countAfterOff)
  })
})
