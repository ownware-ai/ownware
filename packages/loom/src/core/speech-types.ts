/**
 * Speech provider interfaces — the canonical home.
 *
 * These types are referenced by `LoomConfig` (core) AND implemented by the
 * `speech_synthesize` / `speech_transcribe` builtins (tools). They live here,
 * in core with zero imports, so `config.ts` can reference them without creating
 * a cycle (`tools/types.ts` already imports `LoomConfig` from `config.ts`).
 *
 * Loom only declares the SHAPE. Implementations (OpenAI Whisper, Deepgram,
 * Google, local whisper.cpp, ElevenLabs, …) are injected by the consumer —
 * in Ownware, that's Cortex, which owns the credentials.
 */

// ---------------------------------------------------------------------------
// Text-to-speech
// ---------------------------------------------------------------------------

export interface TTSProvider {
  /** Convert text to audio. Returns the path to the generated audio file. */
  synthesize(
    text: string,
    options?: {
      /** Voice identifier (provider-specific) */
      voice?: string
      /** Model identifier (provider-specific) */
      model?: string
      /** Output format */
      format?: 'mp3' | 'wav' | 'ogg' | 'flac'
      /** Speaking speed multiplier (0.5 - 2.0) */
      speed?: number
    },
  ): Promise<TTSResult>

  /** List available voices. Optional — some providers may not support this. */
  listVoices?(): Promise<Voice[]>
}

export interface TTSResult {
  /** Path to the generated audio file */
  readonly audioPath: string
  /** Audio format */
  readonly format: string
  /** Duration in seconds (if known) */
  readonly durationSeconds?: number
  /** Provider name */
  readonly provider: string
}

export interface Voice {
  readonly id: string
  readonly name: string
  readonly language?: string
  readonly description?: string
}

// ---------------------------------------------------------------------------
// Speech-to-text
// ---------------------------------------------------------------------------

export interface STTProvider {
  /** Transcribe an audio file to text. */
  transcribe(
    audioPath: string,
    options?: {
      /** Language hint (ISO 639-1 code, e.g., "en", "es", "fr") */
      language?: string
      /** Include timestamps */
      timestamps?: boolean
    },
  ): Promise<STTResult>
}

export interface STTResult {
  /** Transcribed text */
  readonly text: string
  /** Detected language (if available) */
  readonly language?: string
  /** Duration of audio in seconds */
  readonly durationSeconds?: number
  /** Provider name */
  readonly provider: string
}
