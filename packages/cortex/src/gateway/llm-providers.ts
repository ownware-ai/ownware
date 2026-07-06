/**
 * Catalogue of every LLM provider the gateway knows how to wire.
 *
 * One descriptor per provider — `providerId` is the loom registry key,
 * `variableName` is the canonical credential identifier (the env var an
 * SDK adapter would expect). Both `handlers/providers.ts` (Settings UI)
 * and `server.ts` (model catalog `hasCredentials` flag) consult this
 * list so a new provider lands in both places by adding one row here.
 */

export interface LlmProviderDescriptor {
  readonly providerId: string
  readonly name: string
  readonly variableName: string
}

export const LLM_PROVIDERS: readonly LlmProviderDescriptor[] = [
  { providerId: 'anthropic', name: 'Anthropic API Key', variableName: 'ANTHROPIC_API_KEY' },
  { providerId: 'openai', name: 'OpenAI API Key', variableName: 'OPENAI_API_KEY' },
  { providerId: 'google', name: 'Google API Key', variableName: 'GOOGLE_API_KEY' },
  { providerId: 'openrouter', name: 'OpenRouter API Key', variableName: 'OPENROUTER_API_KEY' },
]

/** Reverse lookup: variableName → providerId. */
export const VARIABLE_NAME_TO_PROVIDER_ID: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(LLM_PROVIDERS.map((d) => [d.variableName, d.providerId])),
)

/** Lookup helper used by handlers when they have a providerId in hand. */
export function llmProviderById(providerId: string): LlmProviderDescriptor | undefined {
  return LLM_PROVIDERS.find((d) => d.providerId === providerId)
}
