/**
 * Catalogue of every LLM provider the gateway knows how to wire.
 *
 * One descriptor per provider — `providerId` is the loom registry key,
 * `variableName` is the canonical credential identifier (the env var an
 * SDK adapter would expect). Both `handlers/providers.ts` (Settings UI)
 * and `server.ts` (model catalog `hasCredentials` flag) consult this
 * list so a new provider lands in both places by adding one row here.
 */

/**
 * How a provider may be powered.
 *
 * - `api-key` — a static developer key the account holder pastes in.
 * - `oauth` — a token set obtained by the account holder authorising us, held
 *   and refreshed on their behalf.
 */
export type LlmCredentialKind = 'api-key' | 'oauth'

export interface LlmProviderDescriptor {
  readonly providerId: string
  readonly name: string
  readonly variableName: string
  /**
   * The credential kinds this provider may be powered by.
   *
   * This is only a construction capability: what the current gateway provider
   * adapter can accept. It is not a billing, subscription, legal, or permission
   * conclusion. Those route-level decisions live in the runtime/access
   * contract and its accepted evidence, not in a provider catalogue comment.
   */
  readonly credentialKinds: readonly LlmCredentialKind[]
}

export const LLM_PROVIDERS: readonly LlmProviderDescriptor[] = [
  {
    providerId: 'anthropic',
    name: 'Anthropic API Key',
    variableName: 'ANTHROPIC_API_KEY',
    credentialKinds: ['api-key'],
  },
  {
    providerId: 'openai',
    name: 'OpenAI API Key',
    variableName: 'OPENAI_API_KEY',
    credentialKinds: ['api-key'],
  },
  {
    providerId: 'google',
    name: 'Google API Key',
    variableName: 'GOOGLE_API_KEY',
    credentialKinds: ['api-key'],
  },
  {
    providerId: 'openrouter',
    name: 'OpenRouter API Key',
    variableName: 'OPENROUTER_API_KEY',
    credentialKinds: ['api-key'],
  },
]

/**
 * Whether this provider may be powered by the given credential kind.
 *
 * Returns `false` for an unknown provider id because no adapter capability was
 * declared. This does not answer whether a provider permits a route.
 */
export function supportsCredentialKind(providerId: string, kind: LlmCredentialKind): boolean {
  return llmProviderById(providerId)?.credentialKinds.includes(kind) ?? false
}

/** Reverse lookup: variableName → providerId. */
export const VARIABLE_NAME_TO_PROVIDER_ID: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(LLM_PROVIDERS.map((d) => [d.variableName, d.providerId])),
)

/** Lookup helper used by handlers when they have a providerId in hand. */
export function llmProviderById(providerId: string): LlmProviderDescriptor | undefined {
  return LLM_PROVIDERS.find((d) => d.providerId === providerId)
}
