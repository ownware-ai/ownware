import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ProviderCatalogStore,
  __catalogStoreInternal,
  createModelsDevArtifact,
  modelsDevArtifactText,
  parseModelsDevArtifactText,
  type CatalogFetcher,
  type ModelsDevCatalog,
} from '../../../src/provider-hub/index.js'

const SOURCE_URL = 'https://models.opencode.ai/api.json'
const OLD = '2026-08-01T00:00:00.000Z'
const NEW = '2026-08-08T12:00:00.000Z'
const NOW = new Date('2026-08-08T13:00:00.000Z')
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

function rawCatalog(modelId = 'model-v1'): ModelsDevCatalog {
  return {
    provider: {
      id: 'provider',
      name: 'Provider',
      env: ['PROVIDER_API_KEY'],
      npm: '@ai-sdk/openai-compatible',
      api: 'https://api.example.test/v1',
      models: {
        [modelId]: {
          id: modelId,
          name: modelId,
          tool_call: true,
          limit: { context: 100_000, output: 8_000 },
          cost: { input: 1, output: 2 },
        },
      },
    },
  }
}

async function paths(): Promise<{ directory: string; bundled: string; cache: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'ownware-provider-catalog-'))
  directories.push(directory)
  return {
    directory,
    bundled: join(directory, 'bundled.json'),
    cache: join(directory, 'cache', 'models.json'),
  }
}

async function writeArtifact(
  path: string,
  raw: ModelsDevCatalog,
  generatedAt: string,
): Promise<void> {
  await writeFile(path, modelsDevArtifactText(createModelsDevArtifact(raw, {
    generatedAt,
    sourceUrl: SOURCE_URL,
  })), 'utf8')
}

function fetchResponse(raw: ModelsDevCatalog): CatalogFetcher {
  return async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: JSON.stringify(raw),
  })
}

function store(options: {
  bundled: string
  cache: string
  fetcher?: CatalogFetcher
  atomicWriter?: (path: string, text: string) => Promise<void>
  maxPayloadBytes?: number
  staleLockMs?: number
}): ProviderCatalogStore {
  return new ProviderCatalogStore({
    bundledPath: options.bundled,
    cachePath: options.cache,
    sourceUrl: SOURCE_URL,
    now: () => NOW,
    staleAfterMs: 60 * 60 * 1_000,
    lockRetryMs: 5,
    lockTimeoutMs: 2_000,
    fetcher: options.fetcher,
    atomicWriter: options.atomicWriter,
    maxPayloadBytes: options.maxPayloadBytes,
    staleLockMs: options.staleLockMs,
  })
}

describe('ProviderCatalogStore', () => {
  it('loads a fresh, newer last-known-good cache before the bundled fallback', async () => {
    const path = await paths()
    await writeArtifact(path.bundled, rawCatalog('bundled'), OLD)
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(path.directory, 'cache')))
    await writeArtifact(path.cache, rawCatalog('cached'), NEW)

    const loaded = await store({ bundled: path.bundled, cache: path.cache }).load()

    expect(loaded.source).toBe('cache')
    expect(loaded.health.status).toBe('fresh')
    expect(loaded.artifact.providers.provider?.models.cached).toBeDefined()
  })

  it('refreshes a stale bundled catalog and atomically adopts the validated artifact', async () => {
    const path = await paths()
    await writeArtifact(path.bundled, rawCatalog('old'), OLD)
    const refreshed = await store({
      bundled: path.bundled,
      cache: path.cache,
      fetcher: fetchResponse(rawCatalog('new')),
    }).refresh()

    expect(refreshed.source).toBe('cache')
    expect(refreshed.health.status).toBe('fresh')
    expect(refreshed.artifact.providers.provider?.models.new).toBeDefined()
    expect(parseModelsDevArtifactText(await readFile(path.cache, 'utf8')).sha256).toBe(
      refreshed.artifact.sha256,
    )
  })

  it('keeps the bundled catalog usable when refresh is offline', async () => {
    const path = await paths()
    await writeArtifact(path.bundled, rawCatalog('offline-safe'), OLD)
    const refreshed = await store({
      bundled: path.bundled,
      cache: path.cache,
      fetcher: async () => { throw new Error('network unavailable') },
    }).refresh()

    expect(refreshed.source).toBe('bundled')
    expect(refreshed.health.status).toBe('offline')
    expect(refreshed.health.errorCode).toBe('upstream_offline')
    expect(refreshed.artifact.providers.provider?.models['offline-safe']).toBeDefined()
  })

  it('rejects malformed and schema-invalid refreshes without replacing last-known-good data', async () => {
    const path = await paths()
    await writeArtifact(path.bundled, rawCatalog('last-good'), OLD)
    const malformed = await store({
      bundled: path.bundled,
      cache: path.cache,
      fetcher: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: '{not json',
      }),
    }).refresh()
    expect(malformed.health.errorCode).toBe('upstream_malformed_json')
    expect(malformed.artifact.providers.provider?.models['last-good']).toBeDefined()

    const invalid = await store({
      bundled: path.bundled,
      cache: path.cache,
      fetcher: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: JSON.stringify({ broken: { id: 'broken' } }),
      }),
    }).refresh()
    expect(invalid.health.errorCode).toBe('upstream_schema_invalid')
    expect(invalid.artifact.providers.provider?.models['last-good']).toBeDefined()
  })

  it('validates concurrently, then serializes one last-known-good write across store instances', async () => {
    const path = await paths()
    await writeArtifact(path.bundled, rawCatalog('old'), OLD)
    let fetches = 0
    let writes = 0
    const fetcher: CatalogFetcher = async () => {
      fetches += 1
      await new Promise((resolve) => setTimeout(resolve, 40))
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: JSON.stringify(rawCatalog('concurrent-new')),
      }
    }
    const atomicWriter = async (target: string, text: string) => {
      writes += 1
      await __catalogStoreInternal.writeAtomically(target, text)
    }
    const first = store({ bundled: path.bundled, cache: path.cache, fetcher, atomicWriter })
    const second = store({ bundled: path.bundled, cache: path.cache, fetcher, atomicWriter })

    const [one, two] = await Promise.all([first.refresh(true), second.refresh(true)])

    expect(fetches).toBe(2)
    expect(writes).toBe(1)
    expect(one.artifact.sha256).toBe(two.artifact.sha256)
    expect(two.artifact.providers.provider?.models['concurrent-new']).toBeDefined()
  })

  it('rolls back a cache-write failure and leaves the prior cache byte-identical', async () => {
    const path = await paths()
    await writeArtifact(path.bundled, rawCatalog('bundled'), OLD)
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(path.directory, 'cache')))
    await writeArtifact(path.cache, rawCatalog('prior-cache'), OLD)
    const before = await readFile(path.cache, 'utf8')

    const refreshed = await store({
      bundled: path.bundled,
      cache: path.cache,
      fetcher: fetchResponse(rawCatalog('would-be-new')),
      atomicWriter: async () => { throw new Error('disk full') },
    }).refresh(true)

    expect(refreshed.health.errorCode).toBe('cache_write_failed')
    expect(refreshed.artifact.providers.provider?.models['prior-cache']).toBeDefined()
    expect(await readFile(path.cache, 'utf8')).toBe(before)
  })

  it('ignores a corrupt cache on startup and reports the fallback health', async () => {
    const path = await paths()
    await writeArtifact(path.bundled, rawCatalog('bundled-safe'), NEW)
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(path.directory, 'cache')))
    await writeFile(path.cache, '{corrupt', 'utf8')

    const loaded = await store({ bundled: path.bundled, cache: path.cache }).load()

    expect(loaded.source).toBe('bundled')
    expect(loaded.health.status).toBe('error')
    expect(loaded.health.errorCode).toBe('cache_invalid')
    expect(loaded.artifact.providers.provider?.models['bundled-safe']).toBeDefined()
  })

  it('rotates the prior generation and rolls back to it when the active cache is corrupt', async () => {
    const path = await paths()
    await writeArtifact(path.bundled, rawCatalog('bundled'), OLD)
    await store({
      bundled: path.bundled,
      cache: path.cache,
      fetcher: fetchResponse(rawCatalog('generation-one')),
    }).refresh(true)
    await store({
      bundled: path.bundled,
      cache: path.cache,
      fetcher: fetchResponse(rawCatalog('generation-two')),
    }).refresh(true)

    const previousPath = `${path.cache}.previous`
    expect(parseModelsDevArtifactText(await readFile(previousPath, 'utf8'))
      .providers.provider?.models['generation-one']).toBeDefined()
    await writeFile(path.cache, '{corrupt-active', 'utf8')

    const rolledBack = await store({ bundled: path.bundled, cache: path.cache }).load()
    expect(rolledBack.source).toBe('cache')
    expect(rolledBack.health.status).toBe('error')
    expect(rolledBack.health.errorCode).toBe('cache_rollback')
    expect(rolledBack.artifact.providers.provider?.models['generation-one']).toBeDefined()
  })

  it('rejects oversized payloads before parsing or replacing the active catalog', async () => {
    const path = await paths()
    await writeArtifact(path.bundled, rawCatalog('bounded-safe'), OLD)
    const refreshed = await store({
      bundled: path.bundled,
      cache: path.cache,
      maxPayloadBytes: 16,
      fetcher: fetchResponse(rawCatalog('too-large')),
    }).refresh(true)

    expect(refreshed.health.status).toBe('error')
    expect(refreshed.health.errorCode).toBe('upstream_payload_too_large')
    expect(refreshed.artifact.providers.provider?.models['bounded-safe']).toBeDefined()
  })

  it('reports a valid old catalog as stale without discarding it', async () => {
    const path = await paths()
    await writeArtifact(path.bundled, rawCatalog('stale-safe'), OLD)

    const loaded = await store({ bundled: path.bundled, cache: path.cache }).load()
    expect(loaded.health.status).toBe('stale')
    expect(loaded.artifact.providers.provider?.models['stale-safe']).toBeDefined()
  })

  it('recovers an abandoned stale refresh lock before fetching', async () => {
    const path = await paths()
    await writeArtifact(path.bundled, rawCatalog('old'), OLD)
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(path.directory, 'cache')))
    const lockPath = `${path.cache}.lock`
    await writeFile(lockPath, '999999\n', 'utf8')
    const old = new Date('2026-08-08T00:00:00.000Z')
    await utimes(lockPath, old, old)

    const refreshed = await store({
      bundled: path.bundled,
      cache: path.cache,
      fetcher: fetchResponse(rawCatalog('after-stale-lock')),
      staleLockMs: 10,
    }).refresh(true)

    expect(refreshed.health.status).toBe('fresh')
    expect(refreshed.artifact.providers.provider?.models['after-stale-lock']).toBeDefined()
  })
})
