/**
 * HTTP speech-to-text provider — covers the two cloud request shapes that
 * share the `/audio/transcriptions` path but differ on the wire:
 *
 *   - `'openai'`  (OpenAI, Groq): multipart/form-data with a `file` part.
 *   - `'openrouter'`: JSON body `{ model, input_audio: { data: base64, format } }`.
 *     (OpenRouter rejects multipart — verified E2E 2026-05-31.)
 *
 * Both return `{ text }`. The provider is bound to one chosen provider
 * (shape + baseUrl + model) with a lazy key getter resolved per call.
 *
 * Implements Loom's `STTProvider` (path-based `transcribe`) so the SAME
 * instance can later be injected into the agent's `speech_transcribe` tool
 * (Path B). The HTTP dictation endpoint uses `transcribeBuffer` directly.
 */

import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { STTProvider, STTResult } from '@ownware/loom'
import type { SpeechShape } from '../gateway/speech-providers.js'

export interface HttpSttProviderOptions {
  readonly providerId: string
  readonly shape: SpeechShape
  readonly baseUrl: string
  readonly model: string
  /** Resolve the API key per call (null when unavailable). */
  readonly getKey: () => Promise<string | null>
}

interface TranscribeOptions {
  readonly language?: string
  readonly mimeType?: string
}

/** Map a MIME type (or filename) to the short format token OpenRouter wants. */
const MIME_TO_FORMAT: Readonly<Record<string, string>> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
  'audio/aac': 'aac',
}

function formatFor(mimeType: string | undefined, filename: string): string {
  if (mimeType && MIME_TO_FORMAT[mimeType.toLowerCase()]) return MIME_TO_FORMAT[mimeType.toLowerCase()]!
  const ext = path.extname(filename).slice(1).toLowerCase()
  return ext || 'wav'
}

export class HttpSttProvider implements STTProvider {
  constructor(private readonly opts: HttpSttProviderOptions) {}

  get model(): string {
    return this.opts.model
  }

  get providerId(): string {
    return this.opts.providerId
  }

  /** Loom `STTProvider` contract: transcribe a file on disk. */
  async transcribe(
    audioPath: string,
    options?: { language?: string; timestamps?: boolean },
  ): Promise<STTResult> {
    const buffer = await readFile(audioPath)
    const filename = path.basename(audioPath) || 'audio.wav'
    return this.transcribeBuffer(buffer, filename, { language: options?.language })
  }

  /** Bytes path — used by the HTTP `/transcribe` endpoint (no temp file). */
  async transcribeBuffer(
    buffer: Uint8Array,
    filename: string,
    options?: TranscribeOptions,
  ): Promise<STTResult> {
    const key = await this.opts.getKey()
    if (!key) {
      throw new Error(`Transcription provider "${this.opts.providerId}" has no API key configured.`)
    }

    const url = `${this.opts.baseUrl}/audio/transcriptions`
    const res =
      this.opts.shape === 'openrouter'
        ? await this.postJson(url, key, buffer, filename, options)
        : await this.postMultipart(url, key, buffer, filename, options)

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      throw new Error(`Transcription failed (${this.opts.providerId} HTTP ${res.status}): ${detail}`)
    }

    const data = (await res.json()) as { text?: string; language?: string; duration?: number }
    return {
      text: data.text ?? '',
      language: data.language,
      durationSeconds: data.duration,
      provider: this.opts.providerId,
    }
  }

  // OpenAI / Groq: multipart/form-data with a `file` part.
  private async postMultipart(
    url: string,
    key: string,
    buffer: Uint8Array,
    filename: string,
    options?: TranscribeOptions,
  ): Promise<Response> {
    const form = new FormData()
    form.append('file', new Blob([buffer], { type: options?.mimeType ?? 'application/octet-stream' }), filename)
    form.append('model', this.opts.model)
    form.append('response_format', 'json')
    if (options?.language) form.append('language', options.language)
    return fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form })
  }

  // OpenRouter: JSON with base64 audio under `input_audio`.
  private async postJson(
    url: string,
    key: string,
    buffer: Uint8Array,
    filename: string,
    options?: TranscribeOptions,
  ): Promise<Response> {
    const body: Record<string, unknown> = {
      model: this.opts.model,
      input_audio: {
        data: Buffer.from(buffer).toString('base64'),
        format: formatFor(options?.mimeType, filename),
      },
    }
    if (options?.language) body['language'] = options.language
    return fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }
}
