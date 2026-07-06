/**
 * Speech-to-text dictation handlers — Path A ("talk instead of type").
 *
 * GET  /api/v1/speech/capabilities — can the current setup transcribe, and with whom
 * POST /api/v1/transcribe          — base64 audio → text
 *
 * This path does NOT touch Loom or the agent loop: it's a direct
 * audio → text service the UI calls, then drops the text into the composer.
 * Credentials are the shared chat keys (category 'llm'), resolved in cortex.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJSON, sendError, readJSON } from '../router.js'
import { TranscribeSchema } from '../validation/schemas.js'
import type { CredentialStore } from '../../credential/store/index.js'
import { getSpeechCapabilities, selectSttProvider } from '../../speech/index.js'

export interface TranscribeHandlerDeps {
  readonly store: CredentialStore
}

/** Pick a filename whose extension lets the upstream infer the audio format. */
const MIME_TO_EXT: Readonly<Record<string, string>> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
  'audio/aac': 'aac',
}

function filenameForMime(mimeType: string): string {
  const ext = MIME_TO_EXT[mimeType.toLowerCase()] ?? 'wav'
  return `audio.${ext}`
}

export function createTranscribeHandlers(deps: TranscribeHandlerDeps) {
  const { store } = deps

  // GET /api/v1/speech/capabilities
  async function capabilities(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const caps = await getSpeechCapabilities(store)
    sendJSON(res, 200, { stt: caps })
  }

  // POST /api/v1/transcribe
  async function transcribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJSON(req)
    if (!body) {
      sendError(res, 400, 'Request body required')
      return
    }

    const parsed = TranscribeSchema.safeParse(body)
    if (!parsed.success) {
      sendError(res, 400, parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '))
      return
    }

    const provider = await selectSttProvider(store)
    if (!provider) {
      sendError(
        res,
        400,
        'No transcription provider configured. Add a Groq, OpenRouter, or OpenAI API key in Settings to enable voice.',
        undefined,
        'auth',
      )
      return
    }

    const { audio, mimeType, language } = parsed.data
    const buffer = Buffer.from(audio, 'base64')
    if (buffer.length === 0) {
      sendError(res, 400, 'Decoded audio is empty.')
      return
    }

    try {
      const result = await provider.transcribeBuffer(buffer, filenameForMime(mimeType), { language, mimeType })
      sendJSON(res, 200, {
        text: result.text,
        language: result.language,
        durationSeconds: result.durationSeconds,
        provider: result.provider,
        model: provider.model,
      })
    } catch (err) {
      sendError(
        res,
        502,
        err instanceof Error ? err.message : 'Transcription failed.',
        undefined,
        'overload',
      )
    }
  }

  return { transcribe, capabilities }
}
