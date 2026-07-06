import { describe, it, expect, vi } from 'vitest'
import { speechTranscribe, speechSynthesize } from '../speech.js'
import type { ToolContext } from '../../types.js'
import type { STTProvider, TTSProvider } from '../../../core/speech-types.js'
import { createDefaultConfig, type LoomConfig } from '../../../core/config.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeContext(overrides?: Partial<LoomConfig>): ToolContext {
  const config: LoomConfig = { ...createDefaultConfig('test:model'), ...overrides }
  return {
    cwd: '/tmp',
    signal: new AbortController().signal,
    sessionId: 'test-session',
    agentId: null,
    workspacePath: '/tmp',
    config,
    requestPermission: vi.fn().mockResolvedValue(true),
    requestCredential: async () => null,
    resolveCredential: () => null,
    listEnvCredentials: () => [],
    listAllCredentialValues: () => [],
  }
}

// ---------------------------------------------------------------------------
// speech_transcribe — the typed sttProvider slot
// ---------------------------------------------------------------------------

describe('speech_transcribe', () => {
  it('returns a no_provider error when no sttProvider is injected', async () => {
    const res = await speechTranscribe.execute({ audioPath: 'note.wav' }, makeContext())
    expect(res.isError).toBe(true)
    expect(res.metadata?.reason).toBe('no_provider')
  })

  it('uses the injected sttProvider and returns its transcript', async () => {
    const stt: STTProvider = {
      transcribe: vi.fn().mockResolvedValue({
        text: 'make the headline bigger',
        language: 'en',
        durationSeconds: 2.4,
        provider: 'mock-whisper',
      }),
    }
    const res = await speechTranscribe.execute(
      { audioPath: 'note.wav', language: 'en' },
      makeContext({ sttProvider: stt }),
    )

    expect(stt.transcribe).toHaveBeenCalledWith('/tmp/note.wav', { language: 'en' })
    expect(res.isError).toBe(false)
    expect(res.content).toContain('make the headline bigger')
    expect(res.metadata?.provider).toBe('mock-whisper')
  })

  it('rejects unsupported audio extensions before calling the provider', async () => {
    const stt: STTProvider = { transcribe: vi.fn() }
    const res = await speechTranscribe.execute({ audioPath: 'note.txt' }, makeContext({ sttProvider: stt }))
    expect(res.isError).toBe(true)
    expect(stt.transcribe).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// speech_synthesize — the typed ttsProvider slot
// ---------------------------------------------------------------------------

describe('speech_synthesize', () => {
  it('returns a no_provider error when no ttsProvider is injected', async () => {
    const res = await speechSynthesize.execute({ text: 'hello' }, makeContext())
    expect(res.isError).toBe(true)
    expect(res.metadata?.reason).toBe('no_provider')
  })

  it('uses the injected ttsProvider', async () => {
    const tts: TTSProvider = {
      synthesize: vi.fn().mockResolvedValue({ audioPath: '/tmp/out.mp3', format: 'mp3', provider: 'mock-tts' }),
    }
    const res = await speechSynthesize.execute({ text: 'hello world' }, makeContext({ ttsProvider: tts }))
    expect(tts.synthesize).toHaveBeenCalled()
    expect(res.isError).toBe(false)
  })
})
