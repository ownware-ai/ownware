import {
  AuthenticationError,
  type ProviderAdapter,
  type ProviderChunk,
  type ProviderRequest,
} from '@ownware/loom'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseProviderVerificationEnvironment,
  providerCommand,
  providerVerificationUsage,
} from '../../../src/cli/provider.js'
import {
  PROVIDER_VERIFICATION_HARNESS_VERSION,
  createVerificationEvidence,
  createVerificationEvidenceBundle,
  evaluateVerificationProbe,
  parseVerificationEvidenceBundleText,
} from '../../../src/provider-hub/index.js'

const NOW = '2026-08-09T04:00:00.000Z'
const SECRET_KEY = 'secret-key-must-never-escape'
const SECRET_RESPONSE = 'secret-response-must-never-escape'
const SECRET_ERROR = 'secret-error-must-never-escape'
const SECRET_MODEL = 'secret-wire-model-must-never-escape'
const SECRET_ENDPOINT = 'https://secret-endpoint.invalid/v1'
const createdDirectories: string[] = []

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('provider verification environment', () => {
  it('requires explicit live, adapter, route, model, generation, and output inputs', () => {
    const required = [
      'OWNWARE_PROVIDER_VERIFY_LIVE',
      'OWNWARE_PROVIDER_VERIFY_ADAPTER',
      'OWNWARE_PROVIDER_VERIFY_ADAPTER_ID',
      'OWNWARE_PROVIDER_VERIFY_MODEL',
      'OWNWARE_PROVIDER_VERIFY_PROVIDER_ROUTE_ID',
      'OWNWARE_PROVIDER_VERIFY_MODEL_ROUTE_ID',
      'OWNWARE_PROVIDER_VERIFY_CATALOG_GENERATION_ID',
      'OWNWARE_PROVIDER_VERIFY_OUTPUT',
    ]
    for (const name of required) {
      const env = verificationEnv()
      delete env[name]
      expect(() => parseProviderVerificationEnvironment(env)).toThrow(name)
    }
  })

  it('parses defaults, unique probes, exact feature opt-ins, and positive integers', () => {
    expect(parseProviderVerificationEnvironment(verificationEnv())).toMatchObject({
      adapterKind: 'openai',
      adapterId: 'openai',
      probes: ['text_streaming', 'terminal_events', 'usage_reporting'],
      authKind: 'bearer',
      expectRateLimit: false,
      includeUsage: false,
    })

    const parsed = parseProviderVerificationEnvironment(verificationEnv({
      OWNWARE_PROVIDER_VERIFY_PROBES: 'text_streaming, structured_output,text_streaming',
      OWNWARE_PROVIDER_VERIFY_ABORT_AFTER_MS: '25',
      OWNWARE_PROVIDER_VERIFY_CONTEXT_CHARS: '1000',
      OWNWARE_PROVIDER_VERIFY_TOOL_USE: '1',
      OWNWARE_PROVIDER_VERIFY_STREAM_USAGE: '1',
    }))
    expect(parsed.probes).toEqual(['text_streaming', 'structured_output'])
    expect(parsed.abortAfterMs).toBe(25)
    expect(parsed.contextChars).toBe(1_000)
    expect(parsed.features).toEqual(new Set(['tool_use']))
    expect(parsed.includeUsage).toBe(true)
  })

  it('rejects unknown enums, empty probe entries, bad opt-ins, and invalid integers', () => {
    expect(() => parseProviderVerificationEnvironment(verificationEnv({
      OWNWARE_PROVIDER_VERIFY_ADAPTER: 'unknown',
    }))).toThrow(/must be one of/)
    expect(() => parseProviderVerificationEnvironment(verificationEnv({
      OWNWARE_PROVIDER_VERIFY_PROBES: 'text_streaming,',
    }))).toThrow(/without empty entries/)
    expect(() => parseProviderVerificationEnvironment(verificationEnv({
      OWNWARE_PROVIDER_VERIFY_STREAM_USAGE: 'true',
    }))).toThrow(/must be 1/)
    expect(() => parseProviderVerificationEnvironment(verificationEnv({
      OWNWARE_PROVIDER_VERIFY_ABORT_AFTER_MS: '0',
    }))).toThrow(/positive integer/)
    expect(() => parseProviderVerificationEnvironment(verificationEnv({
      OWNWARE_PROVIDER_VERIFY_CONTEXT_CHARS: '1.5',
    }))).toThrow(/positive integer/)
  })

  it('binds canonical adapter identities and validates compatible connection ids', () => {
    expect(() => parseProviderVerificationEnvironment(verificationEnv({
      OWNWARE_PROVIDER_VERIFY_ADAPTER_ID: 'different',
    }))).toThrow(/must equal openai/)
    expect(() => parseProviderVerificationEnvironment(verificationEnv({
      OWNWARE_PROVIDER_VERIFY_ADAPTER: 'openai-compatible',
      OWNWARE_PROVIDER_VERIFY_ADAPTER_ID: 'Not Valid',
      OWNWARE_PROVIDER_VERIFY_BASE_URL: 'http://127.0.0.1:1234/v1',
    }))).toThrow(/provider slug/)
    expect(parseProviderVerificationEnvironment(verificationEnv({
      OWNWARE_PROVIDER_VERIFY_ADAPTER: 'openai-compatible',
      OWNWARE_PROVIDER_VERIFY_ADAPTER_ID: 'oai_0123456789ab',
      OWNWARE_PROVIDER_VERIFY_BASE_URL: 'http://127.0.0.1:1234/v1',
      OWNWARE_PROVIDER_VERIFY_AUTH_KIND: 'none',
    }))).toMatchObject({
      adapterKind: 'openai-compatible',
      adapterId: 'oai_0123456789ab',
      authKind: 'none',
    })
  })
})

describe('ownware provider command', () => {
  it('routes help without live opt-in and never accepts credential arguments', async () => {
    const output: string[] = []
    await providerCommand([], { env: {}, stdout: value => output.push(value) })
    expect(output).toEqual([providerVerificationUsage()])

    const secretArgument = 'argv-secret-must-not-be-echoed'
    let thrown: unknown
    try {
      await providerCommand(['verify', '--api-key', secretArgument], { env: {} })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('accepts no arguments')
    expect((thrown as Error).message).not.toContain(secretArgument)
  })

  it('runs pass, skip, and typed-error probes while printing and storing only normalized facts', async () => {
    const directory = await tempDirectory()
    const outputPath = join(directory, 'verification-evidence.json')
    const stdout: string[] = []
    const env = verificationEnv({
      OWNWARE_PROVIDER_VERIFY_MODEL: SECRET_MODEL,
      OWNWARE_PROVIDER_VERIFY_BASE_URL: SECRET_ENDPOINT,
      OWNWARE_PROVIDER_VERIFY_OUTPUT: outputPath,
      OWNWARE_PROVIDER_VERIFY_PROBES: 'text_streaming,structured_output,image_input,auth_error',
      OWNWARE_PROVIDER_VERIFY_IMAGE_PATH: '/private/secret-image.png',
      OWNWARE_PROVIDER_VERIFY_VISION: '1',
    })

    await providerCommand(['verify'], {
      env,
      now: () => new Date(NOW),
      stdout: value => stdout.push(value),
      readFixture: async () => Buffer.from('secret-image-bytes-must-never-escape'),
      createAdapter: (_config, credential) => fixtureAdapter({
        name: 'openai',
        error: credential === 'ownware-deliberately-invalid-verification-key'
          ? new AuthenticationError(SECRET_ERROR, 'fixture')
          : undefined,
      }),
    })

    expect(stdout).toHaveLength(1)
    const normalized = stdout[0]!.replace(
      /(verification|evidence):[a-f0-9]{64}/g,
      '$1:<sha256>',
    )
    expect(normalized).toMatchInlineSnapshot(`
      "{
        \"bundleId\": \"verification:<sha256>\",
        \"evidenceId\": \"evidence:<sha256>\",
        \"providerRouteId\": \"route:openai\",
        \"modelRouteId\": \"openai:test-model\",
        \"results\": [
          {
            \"probeId\": \"text_streaming\",
            \"status\": \"passed\"
          },
          {
            \"probeId\": \"structured_output\",
            \"status\": \"skipped\",
            \"reason\": \"unsupported_by_adapter\"
          },
          {
            \"probeId\": \"image_input\",
            \"status\": \"passed\"
          },
          {
            \"probeId\": \"auth_error\",
            \"status\": \"passed\"
          }
        ]
      }"
    `)

    const persistedText = await readFile(outputPath, 'utf8')
    const persisted = parseVerificationEvidenceBundleText(persistedText)
    expect(persisted.mode).toBe('live')
    expect(persisted.entries[0]).toMatchObject({
      providerRouteId: 'route:openai',
      modelRouteId: 'openai:test-model',
      runtimeId: 'loom',
      adapterId: 'openai',
      protocol: 'openai_chat_completions',
      catalogGenerationId: 'catalog:test-generation',
    })
    const publicSurfaces = `${stdout[0]}\n${persistedText}`
    for (const secret of [
      SECRET_KEY,
      SECRET_RESPONSE,
      SECRET_ERROR,
      SECRET_MODEL,
      SECRET_ENDPOINT,
      '/private/secret-image.png',
      'secret-image-bytes-must-never-escape',
    ]) {
      expect(publicSurfaces).not.toContain(secret)
    }
  })

  it('keeps the prior bundle byte-for-byte when a candidate result is malformed', async () => {
    const directory = await tempDirectory()
    const outputPath = join(directory, 'verification-evidence.json')
    const env = verificationEnv({ OWNWARE_PROVIDER_VERIFY_OUTPUT: outputPath })
    await providerCommand(['verify'], {
      env,
      now: () => new Date(NOW),
      stdout: () => {},
      createAdapter: () => fixtureAdapter({ name: 'openai' }),
    })
    const before = await readFile(outputPath, 'utf8')

    await expect(providerCommand(['verify'], {
      env,
      now: () => new Date('2026-08-09T05:00:00.000Z'),
      stdout: () => {},
      createAdapter: () => fixtureAdapter({ name: 'openai' }),
      runVerification: async () => [{
        probeId: 'text_streaming',
        status: 'passed',
        rawResponse: SECRET_RESPONSE,
      }] as never,
    })).rejects.toThrow('failed safely')

    expect(await readFile(outputPath, 'utf8')).toBe(before)
  })

  it('refuses to overwrite invalid or incompatible active evidence', async () => {
    const directory = await tempDirectory()
    const outputPath = join(directory, 'verification-evidence.json')
    const env = verificationEnv({ OWNWARE_PROVIDER_VERIFY_OUTPUT: outputPath })
    const dependencies = {
      env,
      now: () => new Date(NOW),
      stdout: () => {},
      createAdapter: () => fixtureAdapter({ name: 'openai' }),
    }

    await writeFile(outputPath, `invalid-${SECRET_RESPONSE}`)
    await expect(providerCommand(['verify'], dependencies)).rejects.toThrow(/invalid and was not overwritten/)
    expect(await readFile(outputPath, 'utf8')).toBe(`invalid-${SECRET_RESPONSE}`)

    const incompatible = fixtureBundle('fixture')
    await writeFile(outputPath, `${JSON.stringify(incompatible, null, 2)}\n`)
    const before = await readFile(outputPath, 'utf8')
    await expect(providerCommand(['verify'], dependencies)).rejects.toThrow(/incompatible and was not overwritten/)
    expect(await readFile(outputPath, 'utf8')).toBe(before)
  })

  it('normalizes malformed adapter failures without leaking their content', async () => {
    let message = ''
    try {
      await providerCommand(['verify'], {
        env: verificationEnv(),
        stdout: () => {},
        createAdapter: () => {
          throw new Error(`${SECRET_ERROR} at ${SECRET_ENDPOINT}`)
        },
      })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toBe('Provider verification failed safely; no unvalidated evidence was promoted.')
    expect(message).not.toContain(SECRET_ERROR)
    expect(message).not.toContain(SECRET_ENDPOINT)
  })
})

function verificationEnv(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return {
    OWNWARE_PROVIDER_VERIFY_LIVE: '1',
    OWNWARE_PROVIDER_VERIFY_ADAPTER: 'openai',
    OWNWARE_PROVIDER_VERIFY_ADAPTER_ID: 'openai',
    OWNWARE_PROVIDER_VERIFY_MODEL: 'fixture-wire-model',
    OWNWARE_PROVIDER_VERIFY_PROVIDER_ROUTE_ID: 'route:openai',
    OWNWARE_PROVIDER_VERIFY_MODEL_ROUTE_ID: 'openai:test-model',
    OWNWARE_PROVIDER_VERIFY_CATALOG_GENERATION_ID: 'catalog:test-generation',
    OWNWARE_PROVIDER_VERIFY_OUTPUT: '/unused/verification-evidence.json',
    OWNWARE_PROVIDER_VERIFY_API_KEY: SECRET_KEY,
    ...overrides,
  }
}

function fixtureAdapter(options: { readonly name: string; readonly error?: Error }): ProviderAdapter {
  return {
    name: options.name,
    async *stream(request: ProviderRequest): AsyncGenerator<ProviderChunk> {
      if (options.error != null) throw options.error
      yield { type: 'text_delta', text: SECRET_RESPONSE }
      yield {
        type: 'message_complete',
        content: [{ type: 'text', text: SECRET_RESPONSE }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      }
      void request
    },
    async countTokens() { return 1 },
    supportsFeature() { return true },
    formatTools(tools) { return tools },
    getModelPricing() { return null },
  }
}

function fixtureBundle(mode: 'fixture' | 'live') {
  const evidence = createVerificationEvidence({
    schemaVersion: 1,
    harnessVersion: PROVIDER_VERIFICATION_HARNESS_VERSION,
    providerRouteId: 'route:other',
    modelRouteId: 'other:model',
    runtimeId: 'loom',
    adapterId: 'other',
    protocol: 'other',
    mode,
    observedAt: NOW,
    catalogGenerationId: 'catalog:test-generation',
    results: [evaluateVerificationProbe('text_streaming', {
      eventTypes: ['text_delta', 'message_complete'],
      terminalOutcome: 'completed',
      toolCallBatches: [],
      cancellationRequested: false,
      timeoutConfigured: false,
      request: {
        reasoningOption: false,
        inputKinds: ['text'],
        structuredOutputSchema: false,
        cacheMarkers: 0,
      },
      response: { reasoningObserved: false, structuredOutputValid: false },
      usage: { inputTokens: 1, outputTokens: 1 },
      errorCategory: 'none',
    })],
  })
  return createVerificationEvidenceBundle({
    harnessVersion: PROVIDER_VERIFICATION_HARNESS_VERSION,
    mode,
    createdAt: NOW,
    entries: [evidence],
  })
}

async function tempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ownware-provider-cli-'))
  createdDirectories.push(path)
  return path
}
