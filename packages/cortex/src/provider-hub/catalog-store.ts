import { randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  createModelsDevArtifact,
  modelsDevArtifactText,
  parseModelsDevArtifactText,
  transformModelsDevArtifact,
  type ModelsDevArtifact,
} from './models-dev.js'
import {
  CatalogRefreshHealthSchema,
  type CatalogRefreshHealth,
} from './schema.js'

const DEFAULT_STALE_AFTER_MS = 60 * 60 * 1_000
const DEFAULT_FETCH_TIMEOUT_MS = 10_000
const DEFAULT_LOCK_TIMEOUT_MS = 15_000
const DEFAULT_LOCK_RETRY_MS = 25
const DEFAULT_STALE_LOCK_MS = 30_000
const DEFAULT_MAX_PAYLOAD_BYTES = 32 * 1_024 * 1_024

export interface CatalogFetchResponse {
  readonly ok: boolean
  readonly status: number
  readonly statusText: string
  readonly text: string
}

export type CatalogFetcher = (
  url: string,
  signal: AbortSignal,
) => Promise<CatalogFetchResponse>

export type AtomicCatalogWriter = (path: string, text: string) => Promise<void>

export interface ProviderCatalogStoreOptions {
  readonly bundledPath: string
  readonly cachePath: string
  readonly previousCachePath?: string
  readonly sourceUrl: string
  readonly fetcher?: CatalogFetcher
  readonly atomicWriter?: AtomicCatalogWriter
  readonly now?: () => Date
  readonly staleAfterMs?: number
  readonly fetchTimeoutMs?: number
  readonly lockTimeoutMs?: number
  readonly lockRetryMs?: number
  readonly staleLockMs?: number
  readonly maxPayloadBytes?: number
}

export interface ProviderCatalogStoreState {
  readonly artifact: ModelsDevArtifact
  readonly source: 'bundled' | 'cache'
  readonly health: CatalogRefreshHealth
}

export class ProviderCatalogUnavailableError extends Error {
  readonly name = 'ProviderCatalogUnavailableError'

  constructor(message: string, readonly cause?: unknown) {
    super(message)
  }
}

class CatalogPayloadTooLargeError extends Error {}

/**
 * Validated Models.dev artifact store with offline bundled fallback and an
 * atomic, cross-process last-known-good cache.
 */
export class ProviderCatalogStore {
  private active: ProviderCatalogStoreState | null = null
  private refreshInFlight: Promise<ProviderCatalogStoreState> | null = null

  constructor(private readonly options: ProviderCatalogStoreOptions) {}

  async load(): Promise<ProviderCatalogStoreState> {
    if (this.active != null) return this.active
    const bundled = await readArtifact(this.options.bundledPath)
    if (bundled.artifact == null) {
      throw new ProviderCatalogUnavailableError(
        `Bundled provider catalog is unavailable at ${this.options.bundledPath}`,
        bundled.error,
      )
    }

    const cached = await readArtifact(this.options.cachePath)
    const previous = await readArtifact(this.previousCachePath())
    const diskArtifact = newestArtifact(cached.artifact, previous.artifact)
    const selected = diskArtifact != null && generatedAt(diskArtifact) >= generatedAt(bundled.artifact)
      ? { artifact: diskArtifact, source: 'cache' as const }
      : { artifact: bundled.artifact, source: 'bundled' as const }
    const status = this.isStale(selected.artifact) ? 'stale' : 'fresh'
    const rolledBack = selected.source === 'cache'
      && cached.artifact == null
      && previous.artifact === selected.artifact
    const cacheError = cached.error == null && !rolledBack
      ? {}
      : {
          errorCode: rolledBack ? 'cache_rollback' : 'cache_invalid',
          errorMessage: rolledBack
            ? 'The active catalog cache was unavailable; the previous valid generation is active'
            : safeErrorMessage(cached.error),
        }
    this.active = {
      ...selected,
      health: CatalogRefreshHealthSchema.parse({
        status: cached.error == null && !rolledBack ? status : 'error',
        activeGenerationId: generationId(selected.artifact),
        lastSuccessAt: selected.artifact.generated_at,
        ...cacheError,
      }),
    }
    return this.active
  }

  refresh(force = false): Promise<ProviderCatalogStoreState> {
    if (this.refreshInFlight != null) return this.refreshInFlight
    this.refreshInFlight = this.runRefresh(force).finally(() => {
      this.refreshInFlight = null
    })
    return this.refreshInFlight
  }

  private async runRefresh(force: boolean): Promise<ProviderCatalogStoreState> {
    const current = await this.load()
    const attemptedAt = this.nowIso()
    if (!force && !this.isStale(current.artifact)) return current

    const baselineGeneration = generationId(current.artifact)
    let artifact: ModelsDevArtifact
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(new Error('Provider catalog refresh timed out')),
      this.options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    )
    try {
      const response = await (this.options.fetcher ?? defaultFetcher)(
        this.options.sourceUrl,
        controller.signal,
      )
      if (!response.ok) {
        return this.withFailure(
          current,
          'error',
          attemptedAt,
          'upstream_http_error',
          `Catalog upstream returned ${response.status} ${response.statusText}`,
        )
      }
      if (Buffer.byteLength(response.text, 'utf8') > this.maxPayloadBytes()) {
        return this.withFailure(
          current,
          'error',
          attemptedAt,
          'upstream_payload_too_large',
          `Catalog upstream exceeded the ${this.maxPayloadBytes()}-byte safety limit`,
        )
      }
      let raw: unknown
      try {
        raw = JSON.parse(response.text) as unknown
      } catch (error) {
        return this.withFailure(
          current,
          'error',
          attemptedAt,
          'upstream_malformed_json',
          safeErrorMessage(error),
        )
      }
      try {
        artifact = createModelsDevArtifact(raw, {
          generatedAt: attemptedAt,
          sourceUrl: this.options.sourceUrl,
        })
        // A raw-shape success must not be promoted if the transformed control
        // plane cannot satisfy the complete Provider Hub contract.
        transformModelsDevArtifact(artifact, { source: 'network' })
      } catch (error) {
        return this.withFailure(
          current,
          'error',
          attemptedAt,
          'upstream_schema_invalid',
          safeErrorMessage(error),
        )
      }
    } catch (error) {
      if (error instanceof CatalogPayloadTooLargeError) {
        return this.withFailure(
          current,
          'error',
          attemptedAt,
          'upstream_payload_too_large',
          error.message,
        )
      }
      const code = controller.signal.aborted ? 'upstream_timeout' : 'upstream_offline'
      return this.withFailure(current, 'offline', attemptedAt, code, safeErrorMessage(error))
    } finally {
      clearTimeout(timeout)
    }

    // Only the last-known-good comparison and rotation are serialized. Fetch,
    // JSON parsing, raw schema validation, and domain validation stay outside
    // the cross-process write lock.
    const release = await acquireFileLock(
      `${this.options.cachePath}.lock`,
      this.options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      this.options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS,
      this.options.staleLockMs ?? DEFAULT_STALE_LOCK_MS,
    )
    if (release == null) {
      const recovered = await this.adoptNewerCache(baselineGeneration)
      if (recovered != null) return recovered
      return this.withFailure(current, 'error', attemptedAt, 'refresh_lock_timeout', 'Timed out waiting for catalog refresh lock')
    }

    try {
      const recovered = await this.adoptNewerCache(baselineGeneration)
      if (recovered != null) return recovered
      const writer = this.options.atomicWriter ?? writeAtomically
      const prior = await readArtifact(this.options.cachePath)
      try {
        if (prior.artifact != null) {
          await writer(this.previousCachePath(), modelsDevArtifactText(prior.artifact))
        }
        await writer(this.options.cachePath, modelsDevArtifactText(artifact))
      } catch (error) {
        return this.withFailure(
          current,
          'error',
          attemptedAt,
          'cache_write_failed',
          safeErrorMessage(error),
        )
      }

      this.active = {
        artifact,
        source: 'cache',
        health: CatalogRefreshHealthSchema.parse({
          status: 'fresh',
          activeGenerationId: generationId(artifact),
          lastAttemptAt: attemptedAt,
          lastSuccessAt: attemptedAt,
        }),
      }
      return this.active
    } finally {
      await release()
    }
  }

  private async adoptNewerCache(
    baselineGeneration: string,
  ): Promise<ProviderCatalogStoreState | null> {
    const cached = await readArtifact(this.options.cachePath)
    if (cached.artifact == null || generationId(cached.artifact) === baselineGeneration) return null
    this.active = {
      artifact: cached.artifact,
      source: 'cache',
      health: CatalogRefreshHealthSchema.parse({
        status: this.isStale(cached.artifact) ? 'stale' : 'fresh',
        activeGenerationId: generationId(cached.artifact),
        lastSuccessAt: cached.artifact.generated_at,
      }),
    }
    return this.active
  }

  private withFailure(
    current: ProviderCatalogStoreState,
    status: 'offline' | 'error',
    attemptedAt: string,
    errorCode: string,
    errorMessage: string,
  ): ProviderCatalogStoreState {
    this.active = {
      ...current,
      health: CatalogRefreshHealthSchema.parse({
        status,
        activeGenerationId: generationId(current.artifact),
        lastAttemptAt: attemptedAt,
        lastSuccessAt: current.health.lastSuccessAt ?? current.artifact.generated_at,
        errorCode,
        errorMessage,
      }),
    }
    return this.active
  }

  private isStale(artifact: ModelsDevArtifact): boolean {
    return this.now().getTime() - generatedAt(artifact) > (this.options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS)
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))()
  }

  private nowIso(): string {
    return this.now().toISOString()
  }

  private previousCachePath(): string {
    return this.options.previousCachePath ?? `${this.options.cachePath}.previous`
  }

  private maxPayloadBytes(): number {
    const configured = this.options.maxPayloadBytes
    return configured != null && Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_MAX_PAYLOAD_BYTES
  }
}

async function defaultFetcher(url: string, signal: AbortSignal): Promise<CatalogFetchResponse> {
  const response = await fetch(url, {
    signal,
    headers: { Accept: 'application/json', 'User-Agent': 'Ownware-Provider-Hub/1' },
  })
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    text: await readBoundedResponse(response, DEFAULT_MAX_PAYLOAD_BYTES),
  }
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared != null && Number(declared) > maxBytes) {
    throw new CatalogPayloadTooLargeError(`Catalog upstream exceeded the ${maxBytes}-byte safety limit`)
  }
  if (response.body == null) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
    throw new CatalogPayloadTooLargeError(`Catalog upstream exceeded the ${maxBytes}-byte safety limit`)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    bytes += chunk.value.byteLength
    if (bytes > maxBytes) {
      await reader.cancel()
      throw new CatalogPayloadTooLargeError(`Catalog upstream exceeded the ${maxBytes}-byte safety limit`)
    }
    chunks.push(chunk.value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readArtifact(path: string): Promise<{
  readonly artifact: ModelsDevArtifact | null
  readonly error: unknown | null
}> {
  try {
    return { artifact: parseModelsDevArtifactText(await readFile(path, 'utf8')), error: null }
  } catch (error) {
    if (isNotFound(error)) return { artifact: null, error: null }
    return { artifact: null, error }
  }
}

async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  await handle.close()
  try {
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r').catch(() => null)
  if (handle == null) return
  await handle.sync().catch(() => undefined)
  await handle.close().catch(() => undefined)
}

async function acquireFileLock(
  path: string,
  timeoutMs: number,
  retryMs: number,
  staleAfterMs: number,
): Promise<(() => Promise<void>) | null> {
  await mkdir(dirname(path), { recursive: true })
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    try {
      const handle = await open(path, 'wx', 0o600)
      await handle.writeFile(`${process.pid}\n`, 'utf8')
      return async () => {
        await handle.close().catch(() => undefined)
        await unlink(path).catch(() => undefined)
      }
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
      const lock = await stat(path).catch(() => null)
      if (lock != null && Date.now() - lock.mtimeMs > staleAfterMs) {
        await unlink(path).catch(() => undefined)
        continue
      }
      await delay(retryMs)
    }
  }
  return null
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function generationId(artifact: ModelsDevArtifact): string {
  return `models-dev:${artifact.sha256.slice(0, 16)}`
}

function generatedAt(artifact: ModelsDevArtifact): number {
  return Date.parse(artifact.generated_at)
}

function newestArtifact(
  left: ModelsDevArtifact | null,
  right: ModelsDevArtifact | null,
): ModelsDevArtifact | null {
  if (left == null) return right
  if (right == null) return left
  return generatedAt(left) >= generatedAt(right) ? left : right
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 2_000) || 'Unknown provider catalog error'
}

export const __catalogStoreInternal = {
  writeAtomically,
}
