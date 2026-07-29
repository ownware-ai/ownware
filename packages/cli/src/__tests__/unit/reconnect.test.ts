/**
 * S5: the stream survives drops — reconnect with `since=lastSeq`, no
 * duplicated output, status told via onRetry, user cancel never retried.
 * A scripted client drops the stream once mid-run; the second
 * subscription must be asked for `since=<last delivered seq>`.
 */

import { describe, expect, it } from 'vitest'
import type { OwnwareClient, GatewayEvent } from '@ownware/client'
import { TranscriptRenderer } from '../../render.js'
import { PLAIN_STYLE } from '../../style.js'
import { streamRun } from '../../stream-run.js'

function makeDroppingClient(log: { sinceAsked: Array<number | undefined> }) {
  const first: GatewayEvent[] = [
    { type: 'turn.start', seq: 1, data: { type: 'turn.start', seq: 1 } },
    { type: 'text.delta', seq: 2, data: { type: 'text.delta', seq: 2, text: 'Hello ' } },
  ]
  const second: GatewayEvent[] = [
    { type: 'text.delta', seq: 3, data: { type: 'text.delta', seq: 3, text: 'world.\n' } },
    {
      type: 'turn.end',
      seq: 4,
      data: { type: 'turn.end', seq: 4, stopReason: 'end_turn' },
    },
  ]
  let call = 0
  return {
    async *events(_id: string, opts: { since?: number } = {}): AsyncIterable<GatewayEvent> {
      log.sinceAsked.push(opts.since)
      call += 1
      if (call === 1) {
        yield* first
        throw new Error('connection reset')
      }
      yield* second
    },
  } as unknown as OwnwareClient
}

describe('streamRun reconnect (S5)', () => {
  it('resumes from since=lastSeq after a drop — one transcript, no duplicates', async () => {
    const log = { sinceAsked: [] as Array<number | undefined> }
    const client = makeDroppingClient(log)
    let buf = ''
    const retries: number[] = []
    const renderer = new TranscriptRenderer({ style: PLAIN_STYLE, out: (c) => { buf += c } })

    await streamRun(
      {
        client,
        renderer,
        style: PLAIN_STYLE,
        out: (c) => { buf += c },
        keys: null,
        askLine: async () => '',
        onRetry: (attempt) => retries.push(attempt),
      },
      { streamId: 'run-1', runId: 'run-1', threadId: 'thread-1' },
    )

    // First subscribe from the start, reconnect from the last seq seen.
    expect(log.sinceAsked).toEqual([undefined, 2])
    expect(buf).toContain('⟳ reconnecting…')
    // The partial line closes before the reconnect note; the resumed
    // text continues after — nothing lost, nothing duplicated.
    expect(buf).toContain('Hello')
    expect(buf).toContain('world.')
    expect(buf.match(/Hello/g)).toHaveLength(1)
    expect(buf.match(/world/g)).toHaveLength(1)
    // Retry announced, then cleared on recovery (and again in finally).
    expect(retries[0]).toBe(1)
    expect(retries).toContain(0)
  })

  it('gives up honestly after bounded retries', async () => {
    let calls = 0
    const client = {
      async *events(): AsyncIterable<GatewayEvent> {
        calls += 1
        throw new Error('down')
      },
    } as unknown as OwnwareClient
    let buf = ''
    const renderer = new TranscriptRenderer({ style: PLAIN_STYLE, out: (c) => { buf += c } })
    await streamRun(
      {
        client,
        renderer,
        style: PLAIN_STYLE,
        out: (c) => { buf += c },
        keys: null,
        askLine: async () => '',
      },
      { streamId: 'run-1', runId: 'run-1', threadId: 'thread-1' },
    )
    expect(calls).toBe(6) // initial + 5 retries
    expect(buf).toContain('stream lost after 5 reconnect attempts')
  }, 30_000)
})
