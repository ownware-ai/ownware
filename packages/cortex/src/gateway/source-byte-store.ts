import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, open, rename, rm, stat, truncate } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { dirname, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SourceUploadCheckpoint } from './source-upload-store.js'

export type SourceByteStoreErrorCode =
  | 'chunk_too_large'
  | 'storage_inconsistent'
  | 'format_invalid'
  | 'object_missing'
  | 'object_mismatch'
  | 'range_invalid'
  | 'range_too_large'
  | 'search_invalid'
  | 'inspection_too_large'
  | 'inspection_timeout'

export class SourceByteStoreError extends Error {
  constructor(public readonly code: SourceByteStoreErrorCode) {
    super(code)
    this.name = 'SourceByteStoreError'
  }
}

export const SOURCE_UTF8_RANGE_MAX_BYTES = 64 * 1024
export const SOURCE_UTF8_MAX_FULL_BYTES = 16 * 1024 * 1024
const SOURCE_UTF8_RANGE_TIMEOUT_MS = 5_000
export const SOURCE_UTF8_SEARCH_MAX_QUERY_BYTES = 128
export const SOURCE_UTF8_SEARCH_MAX_MATCHES = 20
export const SOURCE_UTF8_SEARCH_MAX_CONTEXT_BYTES = 1_024
export const SOURCE_UTF8_SEARCH_TIMEOUT_MS = SOURCE_UTF8_RANGE_TIMEOUT_MS
export type SourceUtf8SearchMatchMode = 'exact_utf8' | 'ascii_case_insensitive'

export interface ReceivedChunk {
  readonly privatePath: string
  readonly byteCount: number
  readonly checksum: string
}

export interface InspectedSourceBytes {
  readonly byteCount: number
  readonly checksum: string
  readonly verifiedMediaType: 'text/plain' | 'application/pdf'
}

export interface SourceInspectionLimits {
  readonly maxBytes: number
  readonly timeoutMs: number
}

export interface SourceUtf8RangeReadInput {
  readonly objectKey: string
  readonly expectedByteCount: number
  readonly expectedChecksum: string
  readonly byteStart: number
  readonly byteEnd: number
}

export interface SourceUtf8RangeReadResult {
  readonly text: string
  readonly byteStart: number
  readonly byteEnd: number
  readonly byteCount: number
}

export interface SourceUtf8SearchInput {
  readonly objectKey: string
  readonly expectedByteCount: number
  readonly expectedChecksum: string
  readonly query: string
  readonly matchMode: SourceUtf8SearchMatchMode
  readonly maxMatches: number
  readonly contextBytes: number
}

export interface SourceUtf8SearchMatch {
  readonly text: string
  readonly byteStart: number
  readonly byteEnd: number
  readonly matchByteStart: number
  readonly matchByteEnd: number
}

export interface SourceUtf8SearchResult {
  readonly matches: readonly SourceUtf8SearchMatch[]
  readonly truncated: boolean
}

export class SourceByteStore {
  private readonly locks = new Map<string, Promise<void>>()

  constructor(private readonly root: string) {}

  async receive(
    req: IncomingMessage,
    maxBytes: number,
    uploadId: string,
  ): Promise<ReceivedChunk> {
    if (!isUuid(uploadId)) throw new SourceByteStoreError('storage_inconsistent')
    const quarantine = join(this.root, 'quarantine', 'uploads', uploadId)
    await mkdir(quarantine, { recursive: true, mode: 0o700 })
    const privatePath = join(quarantine, randomUUID())
    const hash = createHash('sha256')
    let byteCount = 0
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        byteCount += chunk.length
        if (byteCount > maxBytes) {
          callback(new SourceByteStoreError('chunk_too_large'))
          return
        }
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    try {
      await pipeline(req, meter, createWriteStream(privatePath, { flags: 'wx', mode: 0o600 }))
      return {
        privatePath,
        byteCount,
        checksum: `sha256:${hash.digest('hex')}`,
      }
    } catch (error) {
      await rm(privatePath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async discard(chunk: ReceivedChunk): Promise<void> {
    await rm(chunk.privatePath, { force: true })
  }

  async withUploadLock<T>(uploadId: string, action: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(uploadId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const queued = prior.then(() => current)
    this.locks.set(uploadId, queued)
    await prior
    try {
      return await action()
    } finally {
      release()
      if (this.locks.get(uploadId) === queued) this.locks.delete(uploadId)
    }
  }

  async reconcile(uploadId: string, durableOffset: number): Promise<void> {
    const staging = await this.stagingPath(uploadId)
    const size = await stat(staging).then((value) => value.size).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return 0
      throw error
    })
    if (size < durableOffset) throw new SourceByteStoreError('storage_inconsistent')
    if (size > durableOffset) await truncate(staging, durableOffset)
  }

  async recoverOpenUploads(
    checkpoints: readonly SourceUploadCheckpoint[],
  ): Promise<readonly string[]> {
    const inconsistent: string[] = []
    for (const checkpoint of checkpoints) {
      try {
        await this.reconcile(checkpoint.uploadId, checkpoint.durableOffset)
      } catch (error) {
        if (error instanceof SourceByteStoreError && error.code === 'storage_inconsistent') {
          inconsistent.push(checkpoint.uploadId)
          continue
        }
        throw error
      }
    }
    return inconsistent
  }

  async append(uploadId: string, chunk: ReceivedChunk): Promise<void> {
    const staging = await this.stagingPath(uploadId)
    await pipeline(
      createReadStream(chunk.privatePath),
      createWriteStream(staging, { flags: 'a', mode: 0o600 }),
    )
  }

  async inspectStaging(
    uploadId: string,
    declaredMediaType: InspectedSourceBytes['verifiedMediaType'],
  ): Promise<InspectedSourceBytes> {
    return this.inspect(await this.stagingPath(uploadId), declaredMediaType)
  }

  async place(uploadId: string, sourceId: string, versionId: string): Promise<string> {
    const objectKey = `sources/${sourceId}/versions/${versionId}/original`
    const target = join(this.root, objectKey)
    await mkdir(join(this.root, `sources/${sourceId}/versions/${versionId}`), {
      recursive: true,
      mode: 0o700,
    })
    const exists = await stat(target).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    if (!exists) await rename(await this.stagingPath(uploadId), target)
    return objectKey
  }

  async discardPlaced(objectKey: string): Promise<void> {
    if (!isSourceObjectKey(objectKey)) {
      throw new SourceByteStoreError('storage_inconsistent')
    }
    await rm(dirname(join(this.root, objectKey)), { recursive: true, force: true })
  }

  async removeVersionArtifacts(sourceId: string, versionId: string): Promise<void> {
    if (!isUuid(sourceId) || !isUuid(versionId)) {
      throw new SourceByteStoreError('storage_inconsistent')
    }
    await this.removeContained(['sources', sourceId, 'versions', versionId], true)
  }

  async versionArtifactsAbsent(sourceId: string, versionId: string): Promise<boolean> {
    if (!isUuid(sourceId) || !isUuid(versionId)) {
      throw new SourceByteStoreError('storage_inconsistent')
    }
    return this.containedTargetAbsent(['sources', sourceId, 'versions', versionId])
  }

  async removeUploadArtifacts(uploadId: string): Promise<void> {
    if (!isUuid(uploadId)) throw new SourceByteStoreError('storage_inconsistent')
    const targets: ReadonlyArray<{ parts: readonly string[]; recursive: boolean }> = [
      { parts: ['quarantine', 'uploads', uploadId], recursive: true },
      { parts: ['staging', `${uploadId}.part`], recursive: false },
    ]
    let firstFailure: unknown
    for (const target of targets) {
      try {
        await this.removeContained(target.parts, target.recursive)
      } catch (error) {
        firstFailure ??= error
      }
    }
    if (firstFailure) throw firstFailure
  }

  async uploadArtifactsAbsent(uploadId: string): Promise<boolean> {
    if (!isUuid(uploadId)) throw new SourceByteStoreError('storage_inconsistent')
    const targets = [
      ['quarantine', 'uploads', uploadId],
      ['staging', `${uploadId}.part`],
    ] as const
    let absent = true
    let firstFailure: unknown
    for (const target of targets) {
      try {
        absent = await this.containedTargetAbsent(target) && absent
      } catch (error) {
        firstFailure ??= error
      }
    }
    if (firstFailure) throw firstFailure
    return absent
  }

  async inspectPlaced(
    objectKey: string,
    declaredMediaType: InspectedSourceBytes['verifiedMediaType'],
    limits?: SourceInspectionLimits,
  ): Promise<InspectedSourceBytes> {
    if (!isSourceObjectKey(objectKey)) {
      throw new SourceByteStoreError('storage_inconsistent')
    }
    return this.inspect(join(this.root, objectKey), declaredMediaType, limits)
  }

  async readPlacedUtf8Range(
    input: SourceUtf8RangeReadInput,
  ): Promise<SourceUtf8RangeReadResult> {
    if (!isSourceObjectKey(input.objectKey)) {
      throw new SourceByteStoreError('storage_inconsistent')
    }
    if (!Number.isSafeInteger(input.expectedByteCount) ||
        !Number.isSafeInteger(input.byteStart) ||
        !Number.isSafeInteger(input.byteEnd) ||
        input.expectedByteCount <= 0 ||
        input.byteStart < 0 ||
        input.byteStart >= input.byteEnd ||
        input.byteEnd > input.expectedByteCount ||
        !/^sha256:[0-9a-f]{64}$/.test(input.expectedChecksum)) {
      throw new SourceByteStoreError('range_invalid')
    }
    const requestedByteCount = input.byteEnd - input.byteStart
    if (requestedByteCount > SOURCE_UTF8_RANGE_MAX_BYTES) {
      throw new SourceByteStoreError('range_too_large')
    }

    const selected = Buffer.alloc(requestedByteCount)
    await this.scanVerifiedPlacedUtf8(input, (chunk, chunkStart, chunkEnd) => {
      const overlapStart = Math.max(input.byteStart, chunkStart)
      const overlapEnd = Math.min(input.byteEnd, chunkEnd)
      if (overlapStart < overlapEnd) {
        chunk.copy(
          selected,
          overlapStart - input.byteStart,
          overlapStart - chunkStart,
          overlapEnd - chunkStart,
        )
      }
    })
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(selected)
    } catch {
      throw new SourceByteStoreError('format_invalid')
    }
    return {
      text,
      byteStart: input.byteStart,
      byteEnd: input.byteEnd,
      byteCount: requestedByteCount,
    }
  }

  async searchPlacedUtf8(input: SourceUtf8SearchInput): Promise<SourceUtf8SearchResult> {
    if (!isSourceObjectKey(input.objectKey) ||
        !validVerifiedUtf8Identity(input.expectedByteCount, input.expectedChecksum) ||
        !isValidSearchQuery(input.query, input.matchMode) ||
        !Number.isSafeInteger(input.maxMatches) || input.maxMatches < 1 ||
        input.maxMatches > SOURCE_UTF8_SEARCH_MAX_MATCHES ||
        !Number.isSafeInteger(input.contextBytes) || input.contextBytes < 0 ||
        input.contextBytes > SOURCE_UTF8_SEARCH_MAX_CONTEXT_BYTES) {
      throw new SourceByteStoreError('search_invalid')
    }
    const chunks: Buffer[] = []
    await this.scanVerifiedPlacedUtf8(input, (chunk) => chunks.push(chunk))
    const content = Buffer.concat(chunks, input.expectedByteCount)
    const query = Buffer.from(input.query, 'utf8')
    const searchable = input.matchMode === 'ascii_case_insensitive'
      ? asciiFold(content) : content
    const needle = input.matchMode === 'ascii_case_insensitive'
      ? asciiFold(query) : query
    const matches: SourceUtf8SearchMatch[] = []
    let from = 0
    let truncated = false
    while (from <= searchable.length - needle.length) {
      const matchByteStart = searchable.indexOf(needle, from)
      if (matchByteStart < 0) break
      const matchByteEnd = matchByteStart + needle.length
      if (matches.length >= input.maxMatches) {
        truncated = true
        break
      }
      const byteStart = utf8BoundaryAfter(
        content,
        Math.max(0, matchByteStart - input.contextBytes),
      )
      const byteEnd = utf8BoundaryBefore(
        content,
        Math.min(content.length, matchByteEnd + input.contextBytes),
      )
      matches.push({
        text: new TextDecoder('utf-8', { fatal: true }).decode(
          content.subarray(byteStart, byteEnd),
        ),
        byteStart,
        byteEnd,
        matchByteStart,
        matchByteEnd,
      })
      from = matchByteEnd
    }
    return { matches, truncated }
  }

  private async scanVerifiedPlacedUtf8(
    input: Pick<SourceUtf8RangeReadInput, 'objectKey' | 'expectedByteCount' | 'expectedChecksum'>,
    onChunk: (chunk: Buffer, byteStart: number, byteEnd: number) => void,
  ): Promise<void> {
    const parts = input.objectKey.split('/')
    const privatePath = join(this.root, ...parts)
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), SOURCE_UTF8_SEARCH_TIMEOUT_MS)
    timer.unref()
    const hash = createHash('sha256')
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let byteCount = 0
    let handle: Awaited<ReturnType<typeof open>> | null = null
    let openedDevice: number | null = null
    let openedInode: number | bigint | null = null
    try {
      await this.assertNoSymlink(parts)
      handle = await open(privatePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const opened = await handle.stat()
      if (!opened.isFile()) throw new SourceByteStoreError('storage_inconsistent')
      openedDevice = opened.dev
      openedInode = opened.ino
      for await (const raw of handle.createReadStream({
        autoClose: false,
        signal: abort.signal,
      })) {
        const chunk = Buffer.from(raw)
        const chunkStart = byteCount
        byteCount += chunk.length
        if (byteCount > SOURCE_UTF8_MAX_FULL_BYTES) {
          throw new SourceByteStoreError('inspection_too_large')
        }
        hash.update(chunk)
        try {
          decoder.decode(chunk, { stream: true })
        } catch {
          throw new SourceByteStoreError('format_invalid')
        }
        onChunk(chunk, chunkStart, byteCount)
      }
      try {
        decoder.decode()
      } catch {
        throw new SourceByteStoreError('format_invalid')
      }
      await this.assertNoSymlink(parts)
      const current = await lstat(privatePath)
      if (!current.isFile() || current.dev !== openedDevice || current.ino !== openedInode) {
        throw new SourceByteStoreError('storage_inconsistent')
      }
      const checksum = `sha256:${hash.digest('hex')}`
      if (byteCount !== input.expectedByteCount || checksum !== input.expectedChecksum) {
        throw new SourceByteStoreError('object_mismatch')
      }
    } catch (error) {
      if (abort.signal.aborted) throw new SourceByteStoreError('inspection_timeout')
      if (error instanceof SourceByteStoreError) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SourceByteStoreError('object_missing')
      }
      throw new SourceByteStoreError('storage_inconsistent')
    } finally {
      clearTimeout(timer)
      await handle?.close().catch(() => undefined)
    }
  }

  private async inspect(
    privatePath: string,
    declaredMediaType: InspectedSourceBytes['verifiedMediaType'],
    limits?: SourceInspectionLimits,
  ): Promise<InspectedSourceBytes> {
    const abort = limits ? new AbortController() : null
    const timer = abort ? setTimeout(() => abort.abort(), limits!.timeoutMs) : null
    timer?.unref()
    const hash = createHash('sha256')
    const decoder = declaredMediaType === 'text/plain'
      ? new TextDecoder('utf-8', { fatal: true }) : null
    let byteCount = 0
    let prefix = Buffer.alloc(0)
    let suffix = Buffer.alloc(0)
    try {
      for await (const raw of createReadStream(privatePath, {
        signal: abort?.signal,
      })) {
        const chunk = Buffer.from(raw)
        byteCount += chunk.length
        if (limits && byteCount > limits.maxBytes) {
          throw new SourceByteStoreError('inspection_too_large')
        }
        hash.update(chunk)
        if (prefix.length < 5) prefix = Buffer.concat([prefix, chunk]).subarray(0, 5)
        suffix = Buffer.concat([suffix, chunk]).subarray(-1024)
        if (decoder) {
          let text: string
          try {
            text = decoder.decode(chunk, { stream: true })
          } catch {
            throw new SourceByteStoreError('format_invalid')
          }
          if (text.includes('\0')) throw new SourceByteStoreError('storage_inconsistent')
        }
      }
    } catch (error) {
      if (abort?.signal.aborted) throw new SourceByteStoreError('inspection_timeout')
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SourceByteStoreError('object_missing')
      }
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (decoder) {
      try {
        decoder.decode()
      } catch {
        throw new SourceByteStoreError('format_invalid')
      }
    }
    if (declaredMediaType === 'application/pdf' &&
        (!prefix.equals(Buffer.from('%PDF-')) || !suffix.includes(Buffer.from('%%EOF')))) {
      throw new SourceByteStoreError('format_invalid')
    }
    return {
      byteCount,
      checksum: `sha256:${hash.digest('hex')}`,
      verifiedMediaType: declaredMediaType,
    }
  }

  private async stagingPath(uploadId: string): Promise<string> {
    const staging = join(this.root, 'staging')
    await mkdir(staging, { recursive: true, mode: 0o700 })
    return join(staging, `${uploadId}.part`)
  }

  private async removeContained(parts: readonly string[], recursive: boolean): Promise<void> {
    await this.assertNoSymlink(parts)
    await rm(join(this.root, ...parts), { recursive, force: true })
  }

  private async containedTargetAbsent(parts: readonly string[]): Promise<boolean> {
    await this.assertNoSymlink(parts)
    return lstat(join(this.root, ...parts)).then(
      () => false,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return true
        throw error
      },
    )
  }

  private async assertNoSymlink(parts: readonly string[]): Promise<void> {
    let current = this.root
    for (const part of parts) {
      current = join(current, part)
      const entry = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (entry === null) return
      if (entry.isSymbolicLink()) {
        throw new SourceByteStoreError('storage_inconsistent')
      }
    }
  }
}

function isSourceObjectKey(objectKey: string): boolean {
  return /^sources\/[0-9a-f-]{36}\/versions\/[0-9a-f-]{36}\/original$/.test(objectKey)
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value)
}

function validVerifiedUtf8Identity(byteCount: number, checksum: string): boolean {
  return Number.isSafeInteger(byteCount) && byteCount > 0 &&
    /^sha256:[0-9a-f]{64}$/.test(checksum)
}

function isValidSearchQuery(query: string, mode: SourceUtf8SearchMatchMode): boolean {
  if (mode !== 'exact_utf8' && mode !== 'ascii_case_insensitive') return false
  if (query.length === 0 || query.trim() !== query || /[\u0000-\u001f\u007f]/.test(query)) {
    return false
  }
  const encoded = Buffer.from(query, 'utf8')
  if (encoded.length === 0 || encoded.length > SOURCE_UTF8_SEARCH_MAX_QUERY_BYTES ||
      encoded.toString('utf8') !== query) return false
  return mode !== 'ascii_case_insensitive' ||
    encoded.every((byte) => byte >= 0x20 && byte <= 0x7e)
}

function asciiFold(input: Buffer): Buffer {
  const folded = Buffer.from(input)
  for (let index = 0; index < folded.length; index++) {
    const byte = folded[index]!
    if (byte >= 0x41 && byte <= 0x5a) folded[index] = byte + 0x20
  }
  return folded
}

function utf8BoundaryAfter(content: Buffer, candidate: number): number {
  let boundary = candidate
  while (boundary < content.length && isUtf8Continuation(content[boundary]!)) boundary++
  return boundary
}

function utf8BoundaryBefore(content: Buffer, candidate: number): number {
  let boundary = candidate
  while (boundary > 0 && boundary < content.length &&
         isUtf8Continuation(content[boundary]!)) boundary--
  return boundary
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80
}
