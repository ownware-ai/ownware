/**
 * Built-in Speech Tools
 *
 * Text-to-speech synthesis and speech-to-text transcription.
 * Both backed by pluggable provider interfaces — consumers inject
 * their own implementations (ElevenLabs, Whisper, Google, etc.) via config.
 *
 * Engine-level — agents may need to produce audio output or
 * transcribe audio input for voice-based interactions.
 *
 * Design:
 *   - Zero external deps (provider implementations live in Cortex)
 *   - TTSProvider injected via config.ttsProvider
 *   - STTProvider injected via config.sttProvider
 *   - If no provider is configured, tools return clear errors
 *   - TTS returns file path in metadata.audioPath
 *   - STT returns transcribed text directly in content
 *
 * @security
 *   - TTS requires permission (produces user-visible content)
 *   - STT is read-only (just transcribes audio)
 *   - Audio file paths validated against workspace boundary
 */

import * as path from 'node:path'
import { defineTool } from '../types.js'
import type { Tool } from '../types.js'

// The speech provider interfaces now live in core/speech-types.ts so that
// LoomConfig can reference them without an import cycle (tools/types.ts already
// imports LoomConfig). Re-exported here to keep the public API stable —
// index.ts re-exports these names from this module.
export type {
  TTSProvider,
  TTSResult,
  Voice,
  STTProvider,
  STTResult,
} from '../../core/speech-types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TTS_TEXT_LENGTH = 10_000
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.webm', '.aac'])

// ---------------------------------------------------------------------------
// speech_synthesize
// ---------------------------------------------------------------------------

export const speechSynthesize: Tool = defineTool({
  name: 'speech_synthesize',
  description:
    'Convert text to spoken audio.\n' +
    '- Generates an audio file from the provided text.\n' +
    '- Use for voice output, narration, or audio content creation.\n' +
    '- Supports voice selection and speed control.\n' +
    '- Maximum text length: 10,000 characters.\n' +
    '- Output is saved as an audio file (path returned in result).',
  category: 'custom',
  isReadOnly: true,
  requiresPermission: true,
  timeoutMs: 60_000,
  uiDescriptor: {
    kind: 'external-action',
    summary: { verb: 'Spoke', primaryField: 'text' },
  },
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The text to convert to speech.',
      },
      voice: {
        type: 'string',
        description:
          'Voice identifier. Available voices depend on the provider. ' +
          'Omit to use the default voice.',
      },
      format: {
        type: 'string',
        enum: ['mp3', 'wav', 'ogg', 'flac'],
        description: 'Output audio format. Default: "mp3".',
      },
      speed: {
        type: 'number',
        description: 'Speaking speed multiplier (0.5 = half speed, 2.0 = double speed). Default: 1.0.',
      },
    },
    required: ['text'],
  },
  async execute(input, context) {
    const provider = context.config.ttsProvider

    if (!provider) {
      return {
        content:
          'Text-to-speech is not configured in this session. ' +
          'No TTS provider is available.',
        isError: true,
        metadata: { reason: 'no_provider' },
      }
    }

    const { text, voice, format, speed } = input as {
      text: string
      voice?: string
      format?: 'mp3' | 'wav' | 'ogg' | 'flac'
      speed?: number
    }

    if (!text || text.trim().length === 0) {
      return { content: 'Text cannot be empty.', isError: true }
    }

    if (text.length > MAX_TTS_TEXT_LENGTH) {
      return {
        content: `Text too long (${text.length} chars). Maximum is ${MAX_TTS_TEXT_LENGTH} characters. Split into smaller segments.`,
        isError: true,
      }
    }

    if (speed !== undefined && (speed < 0.5 || speed > 2.0)) {
      return { content: 'Speed must be between 0.5 and 2.0.', isError: true }
    }

    try {
      const result = await provider.synthesize(text.trim(), {
        voice,
        format: format ?? 'mp3',
        speed: speed ?? 1.0,
      })

      const parts = [`Audio generated: ${result.audioPath}`]
      parts.push(`Format: ${result.format}`)
      parts.push(`Provider: ${result.provider}`)
      if (result.durationSeconds) {
        parts.push(`Duration: ${result.durationSeconds.toFixed(1)}s`)
      }

      return {
        content: parts.join('\n'),
        isError: false,
        metadata: {
          audioPath: result.audioPath,
          format: result.format,
          durationSeconds: result.durationSeconds,
          provider: result.provider,
        },
      }
    } catch (e) {
      return {
        content: `Speech synthesis failed: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
        metadata: { error: String(e) },
      }
    }
  },
})

// ---------------------------------------------------------------------------
// speech_transcribe
// ---------------------------------------------------------------------------

export const speechTranscribe: Tool = defineTool({
  name: 'speech_transcribe',
  description:
    'Transcribe an audio file to text.\n' +
    '- Converts spoken audio to written text.\n' +
    '- Supports common audio formats (mp3, wav, ogg, flac, m4a, webm, aac).\n' +
    '- Optionally specify a language hint for better accuracy.\n' +
    '- Returns the full transcription as text.',
  category: 'custom',
  isReadOnly: true,
  requiresPermission: false,
  timeoutMs: 120_000,
  uiDescriptor: {
    kind: 'external-action',
    summary: { verb: 'Transcribed', primaryField: 'audioPath' },
    preview: { contentField: 'text', format: 'plain', truncateAtLines: 10 },
  },
  inputSchema: {
    type: 'object',
    properties: {
      audioPath: {
        type: 'string',
        description: 'Path to the audio file to transcribe.',
      },
      language: {
        type: 'string',
        description:
          'Language hint (ISO 639-1 code, e.g., "en", "es", "fr", "de"). ' +
          'Improves accuracy for non-English audio.',
      },
    },
    required: ['audioPath'],
  },
  async execute(input, context) {
    const provider = context.config.sttProvider

    if (!provider) {
      return {
        content:
          'Speech-to-text is not configured in this session. ' +
          'No STT provider is available.',
        isError: true,
        metadata: { reason: 'no_provider' },
      }
    }

    const { audioPath, language } = input as {
      audioPath: string
      language?: string
    }

    // Validate file extension
    const ext = path.extname(audioPath).toLowerCase()
    if (!AUDIO_EXTENSIONS.has(ext)) {
      return {
        content: `Unsupported audio format "${ext}". Supported: ${[...AUDIO_EXTENSIONS].join(', ')}`,
        isError: true,
      }
    }

    // Validate path is within workspace
    const resolved = path.resolve(context.cwd, audioPath)
    if (context.workspacePath && !resolved.startsWith(context.workspacePath)) {
      return {
        content: `Audio file "${audioPath}" is outside the workspace.`,
        isError: true,
      }
    }

    try {
      const result = await provider.transcribe(resolved, { language })

      const parts: string[] = [result.text]
      if (result.language) {
        parts.push(`\nDetected language: ${result.language}`)
      }
      if (result.durationSeconds) {
        parts.push(`Audio duration: ${result.durationSeconds.toFixed(1)}s`)
      }

      return {
        content: parts.join('\n'),
        isError: false,
        metadata: {
          language: result.language,
          durationSeconds: result.durationSeconds,
          provider: result.provider,
          textLength: result.text.length,
        },
      }
    } catch (e) {
      return {
        content: `Transcription failed: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
        metadata: { audioPath, error: String(e) },
      }
    }
  },
})

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const speechTools: Tool[] = [speechSynthesize, speechTranscribe]
