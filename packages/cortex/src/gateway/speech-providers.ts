/**
 * Catalogue of every speech-to-text provider the gateway knows how to wire.
 *
 * Mirrors `llm-providers.ts`. Presence in this list IS the "can transcribe"
 * capability — there is no boolean flag and no column on `LLM_PROVIDERS`
 * (Principle 22: a new concern gets its own vertical). Anthropic is absent
 * because it has no transcription endpoint.
 *
 * `variableName` is the SHARED credential identifier — the same key a user
 * saves for chat (category `'llm'`) is reused for transcription. No
 * double-entry: if you have an OpenAI key for chat, you can transcribe with
 * it too. The order of this array is the priority used to pick a default
 * transcriber when more than one key is configured.
 *
 * Two request shapes ship today, both hitting `/audio/transcriptions`:
 *   - `'openai'`     — multipart/form-data (OpenAI, Groq).
 *   - `'openrouter'` — JSON `{ input_audio: { data: base64, format } }`
 *     (OpenRouter rejects multipart — verified E2E 2026-05-31).
 * Gemini (audio-on-generateContent), Deepgram (own API), and local
 * whisper.cpp get their own shapes + adapters in follow-up chunks — added
 * here only when their adapter actually ships.
 *
 * Model defaults web-researched 2026-05-31 (see voice-input board): Groq
 * `whisper-large-v3-turbo` ≈$0.04/hr is the cheapest/fastest; OpenRouter
 * routes the same turbo model on the key many users already have; OpenAI
 * `gpt-4o-mini-transcribe` is the accuracy fallback.
 */

export type SpeechShape = 'openai' | 'openrouter'

export interface SpeechProviderDescriptor {
  readonly providerId: string
  readonly name: string
  /** Shared credential identifier — same row as the chat key (category 'llm'). */
  readonly variableName: string
  readonly baseUrl: string
  readonly defaultModel: string
  readonly shape: SpeechShape
}

export const SPEECH_PROVIDERS: readonly SpeechProviderDescriptor[] = [
  {
    providerId: 'groq',
    name: 'Groq',
    variableName: 'GROQ_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'whisper-large-v3-turbo',
    shape: 'openai',
  },
  {
    providerId: 'openrouter',
    name: 'OpenRouter',
    variableName: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/whisper-large-v3-turbo',
    shape: 'openrouter',
  },
  {
    providerId: 'openai',
    name: 'OpenAI',
    variableName: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini-transcribe',
    shape: 'openai',
  },
]

export function speechProviderById(providerId: string): SpeechProviderDescriptor | undefined {
  return SPEECH_PROVIDERS.find((d) => d.providerId === providerId)
}
