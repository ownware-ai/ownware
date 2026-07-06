/**
 * Speech Tools — E2E Test
 *
 * Tests speech_synthesize and speech_transcribe with mock providers.
 * Verifies the model correctly invokes TTS/STT tools.
 */

import { describe, it, afterEach } from 'vitest'
import { createTestSession } from '../harness/index.js'
import {
  assertStreamCompleted,
  assertToolCalled,
  assertToolSucceeded,
  assertTextContains,
} from '../harness/assertions.js'
import type { TestSession } from '../harness/session.js'
import { speechTools } from '../../../src/tools/builtins/speech.js'
import type { TTSProvider, TTSResult, STTProvider, STTResult } from '../../../src/tools/builtins/speech.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

// ---------------------------------------------------------------------------
// Mock providers
// ---------------------------------------------------------------------------

class MockTTSProvider implements TTSProvider {
  lastText: string | null = null

  async synthesize(text: string, options?: { voice?: string; format?: string; speed?: number }): Promise<TTSResult> {
    this.lastText = text
    return {
      audioPath: `/tmp/test-audio-${Date.now()}.${options?.format ?? 'mp3'}`,
      format: options?.format ?? 'mp3',
      durationSeconds: text.length * 0.05,
      provider: 'mock-tts',
    }
  }
}

class MockSTTProvider implements STTProvider {
  async transcribe(audioPath: string, options?: { language?: string }): Promise<STTResult> {
    return {
      text: 'This is a mock transcription of the audio file.',
      language: options?.language ?? 'en',
      durationSeconds: 5.2,
      provider: 'mock-stt',
    }
  }
}

// ---------------------------------------------------------------------------
// E2E Tests
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_KEY)('Tool: speech (E2E)', () => {
  let ts: TestSession

  afterEach(async () => {
    if (ts) await ts.cleanup()
  })

  it('synthesizes speech when asked by the model', async () => {
    const ttsProvider = new MockTTSProvider()

    ts = await createTestSession({
      model: 'anthropic:claude-haiku-4-5-20251001',
      tools: speechTools,
      systemPrompt:
        'You are a concise assistant. When asked to speak or read text aloud, ' +
        'you MUST use the speech_synthesize tool.',
      maxTurns: 3,
      maxTokens: 512,
      permissionMode: 'allow-all',
      configOverrides: {
        ttsProvider: ttsProvider,
      } as Record<string, unknown>,
    })

    const stream = await ts.run('Please read this text aloud: "Hello, world! Welcome to Cortex."')
    assertStreamCompleted(stream)
    assertToolCalled(stream, 'speech_synthesize')
    assertToolSucceeded(stream, 'speech_synthesize')

    if (!ttsProvider.lastText) throw new Error('TTS provider was not called')
  }, 30_000)

  it('transcribes audio when asked by the model', async () => {
    const sttProvider = new MockSTTProvider()

    ts = await createTestSession({
      model: 'anthropic:claude-haiku-4-5-20251001',
      tools: speechTools,
      systemPrompt:
        'You are a concise assistant. When asked to transcribe, ' +
        'use the speech_transcribe tool. The file is at /tmp/test.mp3.',
      maxTurns: 3,
      maxTokens: 512,
      permissionMode: 'allow-all',
      createSandbox: false,
      configOverrides: {
        sttProvider: sttProvider,
        workspacePath: '/tmp',
      } as Record<string, unknown>,
    })

    const stream = await ts.run('Transcribe the audio file at /tmp/test.mp3')
    assertStreamCompleted(stream)
    assertToolCalled(stream, 'speech_transcribe')
    assertToolSucceeded(stream, 'speech_transcribe')
    assertTextContains(stream, 'mock transcription')
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Unit Tests
// ---------------------------------------------------------------------------

describe('Tool: speech (unit)', () => {
  it('speech_synthesize returns error when no provider', async () => {
    const tool = speechTools.find(t => t.name === 'speech_synthesize')!
    const result = await tool.execute(
      { text: 'hello' },
      {
        cwd: '/tmp',
        signal: new AbortController().signal,
        sessionId: 'test',
        agentId: null,
        workspacePath: '/tmp',
        config: {} as any,
        requestPermission: async () => true,
      },
    )
    const res = result as { content: string; isError: boolean }
    if (!res.isError) throw new Error('Expected error')
    if (!res.content.includes('not configured')) throw new Error('Expected "not configured"')
  })

  it('speech_synthesize rejects empty text', async () => {
    const tts = new MockTTSProvider()
    const tool = speechTools.find(t => t.name === 'speech_synthesize')!
    const result = await tool.execute(
      { text: '' },
      {
        cwd: '/tmp',
        signal: new AbortController().signal,
        sessionId: 'test',
        agentId: null,
        workspacePath: '/tmp',
        config: { ttsProvider: tts } as any,
        requestPermission: async () => true,
      },
    )
    const res = result as { content: string; isError: boolean }
    if (!res.isError) throw new Error('Expected error')
  })

  it('speech_transcribe rejects unsupported formats', async () => {
    const stt = new MockSTTProvider()
    const tool = speechTools.find(t => t.name === 'speech_transcribe')!
    const result = await tool.execute(
      { audioPath: 'file.txt' },
      {
        cwd: '/tmp',
        signal: new AbortController().signal,
        sessionId: 'test',
        agentId: null,
        workspacePath: '/tmp',
        config: { sttProvider: stt } as any,
        requestPermission: async () => true,
      },
    )
    const res = result as { content: string; isError: boolean }
    if (!res.isError) throw new Error('Expected error for .txt format')
    if (!res.content.includes('Unsupported audio format')) throw new Error('Expected format error')
  })

  it('speech_synthesize rejects invalid speed', async () => {
    const tts = new MockTTSProvider()
    const tool = speechTools.find(t => t.name === 'speech_synthesize')!
    const result = await tool.execute(
      { text: 'hello', speed: 5.0 },
      {
        cwd: '/tmp',
        signal: new AbortController().signal,
        sessionId: 'test',
        agentId: null,
        workspacePath: '/tmp',
        config: { ttsProvider: tts } as any,
        requestPermission: async () => true,
      },
    )
    const res = result as { content: string; isError: boolean }
    if (!res.isError) throw new Error('Expected error for speed 5.0')
  })
})
