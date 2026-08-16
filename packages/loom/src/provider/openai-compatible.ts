import OpenAI, { type ClientOptions } from 'openai'
import type { ModelPricing } from './pricing.js'
import { OpenAIProvider } from './openai.js'
import type { ProviderFeature, ProviderFetch, ProviderRequest } from './types.js'
import { createEgressFetch } from '../egress/fetch.js'

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const BLOCKED_HEADERS = new Set([
  'connection',
  'content-length',
  'cookie',
  'host',
  'keep-alive',
  'origin',
  'proxy-authenticate',
  'proxy-authorization',
  'referer',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
])

export type OpenAICompatibleAuth =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'bearer'
      readonly credentialProvider: () => Promise<string>
    }
  | {
      readonly kind: 'header'
      readonly name: string
      readonly prefix?: string
      readonly credentialProvider: () => Promise<string>
    }

export interface OpenAICompatibleProviderOptions {
  /**
   * Loom registry id. Custom connections use `oai_<12 hex>`; fixed
   * provider-operated presets use their canonical catalog slug.
   */
  readonly name: string
  /** Defaults to the stricter custom-connection namespace. */
  readonly registryKind?: 'connection' | 'preset'
  /** Exact user-approved OpenAI-compatible API root, normally ending `/v1`. */
  readonly baseURL: string
  readonly auth: OpenAICompatibleAuth
  /** Most compatible servers still implement `max_tokens`. */
  readonly maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /** Some compatible servers reject `stream_options`; opt in explicitly. */
  readonly includeUsage?: boolean
  /** Evidence-backed features only. Omitted means conservative streaming. */
  readonly verifiedFeatures?: ReadonlySet<ProviderFeature>
}

/**
 * Connection-scoped OpenAI Chat Completions transport.
 *
 * It deliberately inherits wire translation only. It does not inherit
 * OpenAI model facts, pricing, Kimi quirks, or capability claims. Credential
 * material is resolved once per request and injected only into that request's
 * SDK client; it is never retained in catalog/config state.
 */
export class OpenAICompatibleProvider extends OpenAIProvider {
  override readonly name: string
  private readonly compatibleBaseURL: string
  private readonly compatibleAuth: OpenAICompatibleAuth
  private readonly compatibleMaxTokensField: 'max_tokens' | 'max_completion_tokens'
  private readonly compatibleIncludeUsage: boolean
  private readonly verifiedFeatures: ReadonlySet<ProviderFeature>

  constructor(options: OpenAICompatibleProviderOptions) {
    // The base class client is never used because getClient() is overridden.
    // A non-secret placeholder keeps the SDK constructor side-effect free.
    super({ apiKey: 'ownware-openai-compatible-placeholder' })
    this.name = requireRegistryName(options.name, options.registryKind ?? 'connection')
    this.compatibleBaseURL = normalizeCompatibleBaseUrl(options.baseURL)
    this.compatibleAuth = validateAuth(options.auth)
    this.compatibleMaxTokensField = options.maxTokensField ?? 'max_tokens'
    this.compatibleIncludeUsage = options.includeUsage ?? false
    this.verifiedFeatures = options.verifiedFeatures ?? new Set(['streaming'])
  }

  protected override async getClient(request?: ProviderRequest): Promise<OpenAI> {
    const credential = this.compatibleAuth.kind === 'none'
      ? null
      : await this.compatibleAuth.credentialProvider()
    const authHeaders = compatibleAuthHeaders(this.compatibleAuth, credential)
    const compatibleFetch = (async (input: unknown, init?: unknown) => {
      // OpenAI 4.x declares its injected fetch using its node-fetch shim,
      // while Node 20 exposes a standards-native fetch. Their runtime shapes
      // are compatible, but their Response declarations are not assignable.
      const nativeInit = init as RequestInit | undefined
      const headers = new Headers(nativeInit?.headers)
      // The SDK generates Authorization from its required apiKey option.
      // Delete that placeholder before applying the connection's explicit
      // auth placement so it can never cross the OS boundary.
      headers.delete('authorization')
      for (const [name, value] of Object.entries(authHeaders)) headers.set(name, value)
      return globalThis.fetch(input as Parameters<typeof globalThis.fetch>[0], {
        ...nativeInit,
        headers,
      })
    }) as unknown as NonNullable<ClientOptions['fetch']>
    const observedFetch = request?.egressControl === undefined
      ? compatibleFetch
      : createEgressFetch({
          fetch: compatibleFetch as unknown as ProviderFetch,
          control: request.egressControl,
          sourceRef: this.name,
          mediation: 'platform_fetch',
        }) as unknown as NonNullable<ClientOptions['fetch']>
    return new OpenAI({
      apiKey: 'ownware-openai-compatible-placeholder',
      baseURL: this.compatibleBaseURL,
      fetch: observedFetch,
    })
  }

  protected override modelInfoForRequest(_model: string): null {
    return null
  }

  protected override normalizeKimiToolCallIds(_model: string): boolean {
    return false
  }

  protected override maxTokensRequestField(): 'max_tokens' | 'max_completion_tokens' {
    return this.compatibleMaxTokensField
  }

  protected override includeStreamUsage(): boolean {
    return this.compatibleIncludeUsage
  }

  override supportsFeature(feature: ProviderFeature): boolean {
    return this.verifiedFeatures.has(feature)
  }

  override getModelPricing(_model: string): ModelPricing | null {
    return null
  }

  /**
   * Optional OpenAI-compatible discovery. Results are identifiers only:
   * an endpoint's model list is not evidence for capabilities or pricing.
   */
  async discoverModels(signal?: AbortSignal): Promise<readonly string[]> {
    const client = await this.getClient()
    const page = await client.models.list(signal == null ? undefined : { signal })
    const ids = page.data
      .map(model => model.id.trim())
      .filter(id => id.length > 0 && id.length <= 1_000)
    return [...new Set(ids)].slice(0, 1_000).sort((left, right) => left.localeCompare(right))
  }
}

export function normalizeCompatibleBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('OpenAI-compatible base URL must be a valid absolute URL')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('OpenAI-compatible base URL must not contain credentials')
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error('OpenAI-compatible base URL must not contain a query or fragment')
  }
  const loopback = isLoopbackHostname(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('OpenAI-compatible endpoints require HTTPS; HTTP is allowed only on loopback')
  }
  if (isMetadataHostname(url.hostname)) {
    throw new Error('Cloud metadata endpoints cannot be used as provider base URLs')
  }
  return url.toString().replace(/\/$/, '')
}

export function assertSafeCredentialHeaderName(name: string): string {
  const normalized = name.trim()
  if (!HEADER_NAME.test(normalized)) throw new Error('Invalid credential header name')
  const lower = normalized.toLowerCase()
  if (lower === 'authorization') {
    throw new Error('Use bearer auth for the Authorization header')
  }
  if (BLOCKED_HEADERS.has(lower)) throw new Error(`Credential header "${normalized}" is not allowed`)
  return normalized
}

function validateAuth(auth: OpenAICompatibleAuth): OpenAICompatibleAuth {
  if (auth.kind !== 'header') return auth
  const name = assertSafeCredentialHeaderName(auth.name)
  const prefix = auth.prefix
  if (prefix != null && /[\r\n\0]/.test(prefix)) {
    throw new Error('Credential header prefix contains invalid control characters')
  }
  if (prefix != null && !/^[\x20-\x7E]*$/.test(prefix)) {
    throw new Error('Credential header prefix must contain visible ASCII characters only')
  }
  if (prefix != null && prefix.length > 100) throw new Error('Credential header prefix is too long')
  return {
    ...auth,
    name,
    ...(prefix == null || prefix.length === 0 ? {} : { prefix }),
  }
}

function compatibleAuthHeaders(
  auth: OpenAICompatibleAuth,
  credential: string | null,
): Readonly<Record<string, string>> {
  if (auth.kind === 'none') return {}
  if (credential == null || credential.length === 0) throw new Error('Compatible credential is empty')
  if (auth.kind === 'bearer') return { Authorization: `Bearer ${credential}` }
  return { [auth.name]: `${auth.prefix ?? ''}${credential}` }
}

function requireRegistryName(
  value: string,
  kind: 'connection' | 'preset',
): string {
  const cleaned = value.trim()
  if (kind === 'connection' && !/^oai_[a-f0-9]{12}$/.test(cleaned)) {
    throw new Error('Compatible provider registry name must match /^oai_[a-f0-9]{12}$/')
  }
  if (kind === 'preset' && !/^[a-z][a-z0-9-]{0,63}$/.test(cleaned)) {
    throw new Error('Compatible provider preset name must be a canonical lowercase slug')
  }
  return cleaned
}

function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return value === 'localhost' || value === '127.0.0.1' || value === '::1'
}

function isMetadataHostname(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return value === '169.254.169.254'
    || value.startsWith('169.254.')
    || value === '100.100.100.200'
    || value === 'fd00:ec2::254'
    || value === 'metadata.google.internal'
    || value === 'metadata.google.internal.'
    || value === 'metadata.azure.internal'
    || value === 'metadata.azure.internal.'
}
