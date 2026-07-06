/**
 * Speech capability selection.
 *
 * Reads the SHARED chat credentials (category `'llm'`) and decides, from the
 * `SPEECH_PROVIDERS` catalogue, whether transcription is possible and which
 * provider to use by default. The gateway's `/transcribe` and
 * `/speech/capabilities` handlers are thin wrappers over these.
 */

import type { CredentialStore } from '../credential/store/index.js'
import { SPEECH_PROVIDERS } from '../gateway/speech-providers.js'
import { HttpSttProvider } from './http-stt-provider.js'

export { HttpSttProvider } from './http-stt-provider.js'

export interface SpeechCapabilities {
  readonly available: boolean
  readonly configuredProviders: readonly string[]
  /** First configured provider by catalogue priority — the default transcriber. */
  readonly defaultProvider: string | null
  readonly defaultModel: string | null
}

export async function getSpeechCapabilities(store: CredentialStore): Promise<SpeechCapabilities> {
  const creds = await store.list({ category: 'llm' })
  const have = new Set(creds.map((c) => c.variableName))
  const configured = SPEECH_PROVIDERS.filter((sp) => have.has(sp.variableName))
  const first = configured[0]
  return {
    available: configured.length > 0,
    configuredProviders: configured.map((sp) => sp.providerId),
    defaultProvider: first?.providerId ?? null,
    defaultModel: first?.defaultModel ?? null,
  }
}

/**
 * Build the STT provider bound to the highest-priority configured key, or
 * null when none is configured. The key is resolved lazily per call so a
 * later delete/rotate takes effect without rebuilding.
 */
export async function selectSttProvider(store: CredentialStore): Promise<HttpSttProvider | null> {
  const creds = await store.list({ category: 'llm' })
  for (const sp of SPEECH_PROVIDERS) {
    const cred = creds.find((c) => c.variableName === sp.variableName)
    if (!cred) continue
    return new HttpSttProvider({
      providerId: sp.providerId,
      shape: sp.shape,
      baseUrl: sp.baseUrl,
      model: sp.defaultModel,
      getKey: async () => (await store.decrypt(cred.id))?.value ?? null,
    })
  }
  return null
}
