import { describe, it, expect } from 'vitest'
import { snapshot } from '../../../src/compaction/snapshot.js'
import { createMockProvider } from '../../helpers/mock-provider.js'
import {
  systemMsg,
  userMsg,
  assistantMsg,
  assistantToolUseMsg,
  userToolResultMsg,
} from '../../helpers/fixtures.js'
import type { Message } from '../../../src/messages/types.js'

describe('snapshot strategy', () => {
  it('is a no-op when retain covers the whole conversation', async () => {
    const conv: Message[] = [
      systemMsg('You are an agent'),
      userMsg('Hello'),
      assistantMsg('Hi'),
    ]
    const provider = createMockProvider({ tokenCount: 100 })
    const result = await snapshot(conv, '', { type: 'messages', count: 100 }, provider)
    expect(result.strategy).toBe('snapshot')
    expect(result.messages).toEqual(conv)
  })

  it('replaces the dropped prefix with one synthetic system message', async () => {
    const conv: Message[] = [
      systemMsg('System'),
      userMsg('first user msg'),
      assistantMsg('first reply'),
      userMsg('second user msg'),
      assistantMsg('second reply'),
      userMsg('latest user msg'),
      assistantMsg('latest reply'),
    ]
    const provider = createMockProvider({ tokenCount: 1000 })
    // Keep only the last 2 → 4 messages get summarized into a snapshot.
    const result = await snapshot(conv, '', { type: 'messages', count: 2 }, provider)

    // Output: original system + ONE snapshot system + retained tail
    expect(result.messages[0]!.role).toBe('system')
    expect(result.messages[0]!.content).toBe('System')
    expect(result.messages[1]!.role).toBe('system') // snapshot
    expect((result.messages[1]!.content as string)).toContain('<compaction-snapshot>')
    expect(result.messages.slice(2)).toEqual(conv.slice(-2))
  })

  it('captures the last user request in the snapshot XML', async () => {
    const conv: Message[] = [
      userMsg('please refactor the auth module to use JWT'),
      assistantMsg('OK starting now'),
      userMsg('actually wait'),
      assistantMsg('paused'),
      userMsg('continue, but use HMAC-SHA256'),
      assistantMsg('continuing with HMAC-SHA256'),
    ]
    const provider = createMockProvider({ tokenCount: 1000 })
    const result = await snapshot(conv, '', { type: 'messages', count: 1 }, provider)

    const snap = result.messages.find((m) => m.role === 'system')!
    // Should preserve the most recent user request from the dropped prefix
    expect(snap.content as string).toContain('continue, but use HMAC-SHA256')
  })

  it('lists files touched (read/write/edit) deduplicated, latest action wins', async () => {
    const conv: Message[] = [
      userMsg('do work'),
      assistantToolUseMsg('readFile', { file_path: 'a.ts' }, 'c1'),
      userToolResultMsg('c1', 'contents of a'),
      assistantToolUseMsg('editFile', { file_path: 'a.ts' }, 'c2'),
      userToolResultMsg('c2', 'edited a'),
      assistantToolUseMsg('writeFile', { file_path: 'b.ts' }, 'c3'),
      userToolResultMsg('c3', 'wrote b'),
      assistantMsg('done'),
    ]
    const provider = createMockProvider({ tokenCount: 1000 })
    // Drop everything except the final assistantMsg('done')
    const result = await snapshot(conv, '', { type: 'messages', count: 1 }, provider)
    const snapXml = (result.messages.find((m) => m.role === 'system')!.content as string)

    expect(snapXml).toContain('<file action="edit">a.ts</file>')   // edit, not read (latest)
    expect(snapXml).toContain('<file action="write">b.ts</file>')
    expect(snapXml).not.toContain('<file action="read">a.ts</file>')

    // Within just the <files-touched> section, a.ts appears exactly once
    // (the edit; the earlier read is deduplicated). It will also appear
    // inside <recent-tool-calls> as part of tool args — that's expected.
    const filesSection = snapXml.match(/<files-touched>([\s\S]*?)<\/files-touched>/)?.[1] ?? ''
    expect((filesSection.match(/a\.ts/g) ?? []).length).toBe(1)
  })

  it('captures the last tool error in the snapshot', async () => {
    const conv: Message[] = [
      userMsg('try this'),
      assistantToolUseMsg('shell', { command: 'rm /etc/foo' }, 'c1'),
      userToolResultMsg('c1', 'ENOENT: no such file', true),
      assistantMsg('that failed'),
    ]
    const provider = createMockProvider({ tokenCount: 1000 })
    const result = await snapshot(conv, '', { type: 'messages', count: 1 }, provider)
    const snapXml = (result.messages.find((m) => m.role === 'system')!.content as string)

    expect(snapXml).toContain('<last-error>')
    expect(snapXml).toContain('ENOENT')
  })

  it('captures the last assistant text snippet from the dropped prefix', async () => {
    const conv: Message[] = [
      userMsg('analyze X'),
      assistantMsg('I think the problem is in module Y because Z'),
      userMsg('next'),
      assistantMsg('next is to write a test'),
      userMsg('do it'),
      assistantMsg('on it'),
    ]
    const provider = createMockProvider({ tokenCount: 1000 })
    // Retain only the last 2 → assistantMsg('next is to write a test') is
    // the most recent assistant text in the dropped prefix.
    const result = await snapshot(conv, '', { type: 'messages', count: 2 }, provider)
    const snapXml = (result.messages.find((m) => m.role === 'system')!.content as string)
    expect(snapXml).toContain('<last-assistant-snippet>')
    expect(snapXml).toContain('next is to write a test')
  })

  it('byte-caps the snapshot to ~1500 bytes even with verbose input', async () => {
    const longText = 'word '.repeat(2000)
    const conv: Message[] = [
      userMsg(longText),
      assistantMsg(longText),
      userMsg('end'),
      assistantMsg('done'),
    ]
    const provider = createMockProvider({ tokenCount: 1000 })
    const result = await snapshot(conv, '', { type: 'messages', count: 1 }, provider)
    const snapXml = (result.messages.find((m) => m.role === 'system')!.content as string)
    expect(Buffer.byteLength(snapXml, 'utf8')).toBeLessThanOrEqual(1500)
  })

  it('makes no provider summarization call (only countTokens)', async () => {
    const conv: Message[] = [
      userMsg('hello'),
      assistantMsg('hi'),
      userMsg('again'),
      assistantMsg('again-reply'),
    ]
    const provider = createMockProvider({ tokenCount: 1000 })
    await snapshot(conv, '', { type: 'messages', count: 1 }, provider)
    // Snapshot is deterministic — no `stream`/`generate` calls happen.
    // (The mock provider's countTokens is allowed.)
    expect((provider as unknown as { streamCallCount?: number }).streamCallCount ?? 0).toBe(0)
  })
})
