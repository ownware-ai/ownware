import {
  OpenAIResponsesProvider,
  ProviderError,
  type ProviderAdapter,
  type ProviderFetch,
} from '@ownware/loom'
import {
  OAUTH_PLACEHOLDER_KEY,
  makeOAuthTransport,
  type OAuthAccessTokenSource,
} from '../../credential/oauth-transport-binding.js'
import type { TokenRequestContext } from '../../credential/oauth-token-manager.js'
import { resolveRuntimeSelection, type RuntimeSelection } from '../selection.js'

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const PROTECTED_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'content-length',
  'proxy-authorization',
])

export type DirectOpenAIAccountTransport =
  | {
      readonly mode: 'required' | 'optional'
      readonly headerName: string
    }
  | {
      readonly mode: 'omit'
    }

/**
 * Operator/provider-observed transport configuration.
 *
 * This object proves only what Ownware was configured to send. The resulting
 * HTTP response remains the authority for whether the route accepts it.
 */
export interface DirectOpenAITransportConfig {
  readonly baseURL: string
  readonly account: DirectOpenAIAccountTransport
  readonly headers?: Readonly<Record<string, string>>
}

export type DirectOpenAIProviderConfigurationErrorCode =
  | 'selection_not_direct'
  | 'base_url_invalid'
  | 'account_invalid'
  | 'header_invalid'
  | 'header_protected'
  | 'account_header_conflict'

export class DirectOpenAIProviderConfigurationError extends Error {
  public override readonly name = 'DirectOpenAIProviderConfigurationError'

  constructor(
    public readonly code: DirectOpenAIProviderConfigurationErrorCode,
  ) {
    super(`Direct OpenAI provider configuration is invalid (${code}).`)
  }
}

export interface CreateOpenAIDirectProviderOptions {
  readonly selection: RuntimeSelection
  readonly tokenSource: OAuthAccessTokenSource
  readonly context: () => TokenRequestContext
  readonly transport: DirectOpenAITransportConfig
  readonly fetchImpl?: ProviderFetch
}

export function createOpenAIDirectProvider(
  options: CreateOpenAIDirectProviderOptions,
): ProviderAdapter {
  let selection: RuntimeSelection
  try {
    selection = resolveRuntimeSelection(options.selection)
  } catch {
    throw new DirectOpenAIProviderConfigurationError('selection_not_direct')
  }
  if (
    selection.runtime !== 'ownware'
    || selection.access.route !== 'openai-chatgpt-direct'
  ) {
    throw new DirectOpenAIProviderConfigurationError('selection_not_direct')
  }

  const baseURL = validateBaseURL(options.transport.baseURL)
  const account = validateAccount(options.transport.account)
  const headers = validateHeaders(options.transport.headers, account)

  const oauthTransport = makeOAuthTransport({
    manager: options.tokenSource,
    context: options.context,
    ...(options.fetchImpl !== undefined
      ? { fetchImpl: options.fetchImpl }
      : {}),
    authorize: ({ headers: requestHeaders, accountId }) => {
      if (account.mode === 'omit') return
      if (accountId === undefined) {
        if (account.mode === 'required') {
          throw new ProviderError(
            'Direct OpenAI route requires a credential-bound account identifier.',
            'openai',
          )
        }
        return
      }
      requestHeaders.set(account.headerName, accountId)
    },
  })

  return new OpenAIResponsesProvider({
    apiKey: OAUTH_PLACEHOLDER_KEY,
    baseURL,
    costBasis: 'subscription_allowance',
    maxRetries: 0,
    ...(headers === undefined ? {} : { defaultHeaders: headers }),
    ...oauthTransport,
  })
}

function validateBaseURL(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new DirectOpenAIProviderConfigurationError('base_url_invalid')
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
    || parsed.pathname.endsWith('/responses')
  ) {
    throw new DirectOpenAIProviderConfigurationError('base_url_invalid')
  }
  return value
}

function validateAccount(
  account: unknown,
): DirectOpenAIAccountTransport {
  if (
    account === null
    || typeof account !== 'object'
    || Array.isArray(account)
  ) {
    throw new DirectOpenAIProviderConfigurationError('account_invalid')
  }
  const record = account as Record<string, unknown>
  const keys = Object.keys(record)
  if (record.mode === 'omit') {
    if (keys.length !== 1) {
      throw new DirectOpenAIProviderConfigurationError('account_invalid')
    }
    return { mode: 'omit' }
  }
  if (
    (record.mode !== 'required' && record.mode !== 'optional')
    || typeof record.headerName !== 'string'
    || keys.length !== 2
  ) {
    throw new DirectOpenAIProviderConfigurationError('account_invalid')
  }
  if (!validHeaderName(record.headerName)) {
    throw new DirectOpenAIProviderConfigurationError('header_invalid')
  }
  if (PROTECTED_HEADERS.has(record.headerName.toLowerCase())) {
    throw new DirectOpenAIProviderConfigurationError('header_protected')
  }
  return {
    mode: record.mode,
    headerName: record.headerName,
  }
}

function validateHeaders(
  input: Readonly<Record<string, string>> | undefined,
  account: DirectOpenAIAccountTransport,
): Readonly<Record<string, string>> | undefined {
  if (input === undefined) return undefined
  const output: Record<string, string> = {}
  const accountHeader = account.mode === 'omit'
    ? null
    : account.headerName.toLowerCase()
  const seen = new Set<string>()
  for (const [name, value] of Object.entries(input)) {
    const normalized = name.toLowerCase()
    if (
      !validHeaderName(name)
      || typeof value !== 'string'
      || value.length > 8_192
      || /[\r\n]/.test(value)
      || seen.has(normalized)
    ) {
      throw new DirectOpenAIProviderConfigurationError('header_invalid')
    }
    seen.add(normalized)
    if (PROTECTED_HEADERS.has(normalized)) {
      throw new DirectOpenAIProviderConfigurationError('header_protected')
    }
    if (normalized === accountHeader) {
      throw new DirectOpenAIProviderConfigurationError(
        'account_header_conflict',
      )
    }
    output[name] = value
  }
  return output
}

function validHeaderName(value: string): boolean {
  return value.length > 0
    && value.length <= 256
    && HEADER_NAME.test(value)
}
