import { describe, it, expect } from 'vitest'
import { summarize } from '../../../src/compaction/summarize.js'
import { createMockProvider } from '../../helpers/mock-provider.js'
import {
  systemMsg, userMsg, assistantMsg, assistantToolUseMsg,
  userToolResultMsg, userImageMsg, createConversation,
} from '../../helpers/fixtures.js'
import type { Message } from '../../../src/messages/types.js'

describe('summarize strategy', () => {
  it('calls provider.stream() with correct prompt structure', async () => {
    const conv = createConversation(5)
    const provider = createMockProvider({ summaryResponse: 'Test summary.' })

    await summarize(conv, '', { type: 'messages', count: 2 }, provider)

    expect(provider.streamCallCount).toBe(1)
    const req = provider.streamRequests[0]!
    expect(req.temperature).toBe(0)
    expect(req.tools).toEqual([])
    // System prompt should be the summarization prompt
    expect(typeof req.system === 'string' && req.system.includes('conversation summarizer')).toBe(true)
    // User message should contain conversation tags
    const userContent = req.messages[0]!.content as string
    expect(userContent).toContain('<conversation>')
    expect(userContent).toContain('</conversation>')
  })

  it('returns [summary_message, ...retained]', async () => {
    const conv = createConversation(5) // 10 messages
    const provider = createMockProvider({ summaryResponse: 'Here is the summary.' })

    const result = await summarize(conv, '', { type: 'messages', count: 4 }, provider)

    // summary (1) + retained (4) = 5
    expect(result.messages).toHaveLength(5)
    // First message is the summary
    expect(result.messages[0]!.role).toBe('user')
    // Last 4 are the retained messages
    expect(result.messages.slice(-4)).toEqual(conv.slice(-4))
  })

  it('summary message starts with automated summary marker', async () => {
    const conv = createConversation(5)
    const provider = createMockProvider({ summaryResponse: 'Summary content.' })

    const result = await summarize(conv, '', { type: 'messages', count: 2 }, provider)

    const summaryContent = result.messages[0]!.content as string
    expect(summaryContent).toContain('[This is an automated summary')
    expect(summaryContent).toContain('Summary content.')
  })

  it('formats tool_use blocks as [Tool call: name(...)]', async () => {
    const messages: Message[] = [
      userMsg('Read the file'),
      assistantToolUseMsg('read_file', { path: '/src/index.ts' }, 'tool_1'),
      userToolResultMsg('tool_1', 'file contents here'),
      assistantMsg('Done'),
      userMsg('Thanks'),
      assistantMsg('You are welcome'),
    ]
    const provider = createMockProvider({
      summaryResponse: 'Summary.',
      tokenCount: 1000,
    })

    await summarize(messages, '', { type: 'messages', count: 2 }, provider)

    const req = provider.streamRequests[0]!
    const userContent = req.messages[0]!.content as string
    expect(userContent).toContain('[Tool call: read_file(')
    expect(userContent).toContain('[Tool result:')
  })

  it('skips thinking blocks', async () => {
    const messages: Message[] = [
      userMsg('Hello'),
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'Let me think about this...' },
          { type: 'text', text: 'Hi there!' },
        ],
      },
      userMsg('Bye'),
      assistantMsg('Goodbye'),
    ]
    const provider = createMockProvider({ summaryResponse: 'Summary.', tokenCount: 500 })

    await summarize(messages, '', { type: 'messages', count: 2 }, provider)

    const req = provider.streamRequests[0]!
    const userContent = req.messages[0]!.content as string
    // Should include the text but not the thinking
    expect(userContent).toContain('Hi there!')
    expect(userContent).not.toContain('Let me think about this')
  })

  it('replaces images with [image]', async () => {
    const messages: Message[] = [
      userImageMsg(),
      assistantMsg('I see the image'),
      userMsg('Final'),
      assistantMsg('Done'),
    ]
    const provider = createMockProvider({ summaryResponse: 'Summary.', tokenCount: 500 })

    await summarize(messages, '', { type: 'messages', count: 2 }, provider)

    const req = provider.streamRequests[0]!
    const userContent = req.messages[0]!.content as string
    expect(userContent).toContain('[image]')
  })

  it('tracks summaryUsage', async () => {
    const conv = createConversation(5)
    const provider = createMockProvider({ summaryResponse: 'Summary.' })

    const result = await summarize(conv, '', { type: 'messages', count: 2 }, provider)

    expect(result.summaryUsage).toBeDefined()
    expect(result.summaryUsage!.inputTokens).toBe(100)
    expect(result.summaryUsage!.outputTokens).toBe(50)
  })

  it('throws on empty summary output', async () => {
    const conv = createConversation(5)
    const provider = createMockProvider({ summaryResponse: '' })

    await expect(
      summarize(conv, '', { type: 'messages', count: 2 }, provider),
    ).rejects.toThrow('Summarization produced empty output')
  })

  it('throws on stream_error', async () => {
    const conv = createConversation(5)
    const provider = createMockProvider({
      failOnStreamCall: 1,
      streamError: new Error('API rate limited'),
    })

    await expect(
      summarize(conv, '', { type: 'messages', count: 2 }, provider),
    ).rejects.toThrow('API rate limited')
  })

  it('no-ops when all messages are within retain window', async () => {
    const conv = createConversation(2) // 4 messages
    const provider = createMockProvider({ tokenCount: 200 })

    const result = await summarize(conv, '', { type: 'messages', count: 10 }, provider)

    expect(result.messages).toEqual(conv)
    expect(result.summaryUsage).toBeUndefined()
    expect(provider.streamCallCount).toBe(0)
  })

  it('preserves system messages', async () => {
    const messages = [systemMsg('Be helpful'), ...createConversation(5)]
    const provider = createMockProvider({ summaryResponse: 'Summary.', tokenCount: 1000 })

    const result = await summarize(messages, '', { type: 'messages', count: 2 }, provider)

    expect(result.messages[0]).toEqual(systemMsg('Be helpful'))
  })

  it('reports strategy as "summarize"', async () => {
    const conv = createConversation(5)
    const provider = createMockProvider({ summaryResponse: 'Summary.' })

    const result = await summarize(conv, '', { type: 'messages', count: 2 }, provider)

    expect(result.strategy).toBe('summarize')
  })

  // ─── Round-atomic split regression coverage ────────────────────────
  // The bug shape these guard against: an old message-count split could
  // fall between an assistant `tool_use` and the user `tool_result`
  // answering it. The retained tail would then start with an orphan
  // tool_result and the next provider call would 400.

  it('round-atomic split: retained tail starts with a real user message', async () => {
    // Two rounds. A message-count split with count=3 would have left
    // the retained tail as [tool_result, assistant, user, assistant],
    // i.e. starting with an orphan tool_result.
    const messages: Message[] = [
      userMsg('round 1 question'),
      assistantToolUseMsg('read_file', { path: '/a' }, 'tool_a'),
      userToolResultMsg('tool_a', 'contents A'),
      assistantMsg('round 1 reply'),
      userMsg('round 2 question'),
      assistantMsg('round 2 reply'),
    ]
    const provider = createMockProvider({
      summaryResponse: 'Summary.',
      tokenCount: 1000,
    })

    const result = await summarize(messages, '', { type: 'messages', count: 3 }, provider)

    // result.messages = [summary, ...retained]. The retained tail must
    // start with a real user message (round boundary).
    const retainedHead = result.messages[1]!
    expect(retainedHead.role).toBe('user')
    if (typeof retainedHead.content !== 'string') {
      const isToolResultOnly = retainedHead.content.every(
        (b) => b.type === 'tool_result',
      )
      expect(isToolResultOnly).toBe(false)
    }
  })

  it('round-atomic split: never produces orphan tool_results (assertPairing passes)', async () => {
    // This input is specifically shaped to trigger the old bug: a budget
    // that under message-count semantics would split mid-pair. The new
    // implementation snaps to a round boundary; the final assertPairing
    // call inside summarize() throws if any orphan slipped through.
    const messages: Message[] = [
      userMsg('first task'),
      assistantToolUseMsg('tool_x', { arg: 1 }, 'id_1'),
      userToolResultMsg('id_1', 'res 1'),
      assistantToolUseMsg('tool_y', { arg: 2 }, 'id_2'),
      userToolResultMsg('id_2', 'res 2'),
      assistantMsg('done first'),
      userMsg('next task'),
      assistantMsg('reply'),
    ]
    const provider = createMockProvider({
      summaryResponse: 'Summary.',
      tokenCount: 1000,
    })

    // count=3 would split the long round 1 chain mid-pair under old logic.
    await expect(
      summarize(messages, '', { type: 'messages', count: 3 }, provider),
    ).resolves.toBeTruthy()
  })

  it('always keeps at least the most-recent round even when count < round size', async () => {
    // Round 2 has 4 messages; retain budget of 2 can't fit it. The
    // invariant "always keep the last round" means we keep all 4 anyway.
    const messages: Message[] = [
      userMsg('round 1'),
      assistantMsg('reply 1'),
      userMsg('round 2'),
      assistantToolUseMsg('tool_x', {}, 'id'),
      userToolResultMsg('id', 'res'),
      assistantMsg('reply 2'),
    ]
    const provider = createMockProvider({
      summaryResponse: 'Summary.',
      tokenCount: 1000,
    })

    const result = await summarize(messages, '', { type: 'messages', count: 2 }, provider)

    // summary + all 4 messages of round 2
    expect(result.messages).toHaveLength(5)
    expect(result.messages.slice(-4)).toEqual(messages.slice(-4))
  })
})
