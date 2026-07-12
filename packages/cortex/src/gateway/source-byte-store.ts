import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat, truncate } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SourceUploadCheckpoint } from './source-upload-store.js'

export class SourceByteStoreError extends Error {
  constructor(public readonly code: 'chunk_too_large' | 'storage_inconsistent' | 'format_invalid') {
    super(code)
    this.name = 'SourceByteStoreError'
  }
}

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

export class SourceByteStore {
  private readonly locks = new Map<string, Promise<void>>()

  constructor(private readonly root: string) {}

  async receive(req: IncomingMessage, maxBytes: number): Promise<ReceivedChunk> {
    const quarantine = join(this.root, 'quarantine')
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

  async inspectPlaced(
    objectKey: string,
    declaredMediaType: InspectedSourceBytes['verifiedMediaType'],
  ): Promise<InspectedSourceBytes> {
    return this.inspect(join(this.root, objectKey), declaredMediaType)
  }

  private async inspect(
    privatePath: string,
    declaredMediaType: InspectedSourceBytes['verifiedMediaType'],
  ): Promise<InspectedSourceBytes> {
    const hash = createHash('sha256')
    const decoder = declaredMediaType === 'text/plain'
      ? new TextDecoder('utf-8', { fatal: true }) : null
    let byteCount = 0
    let prefix = Buffer.alloc(0)
    let suffix = Buffer.alloc(0)
    for await (const raw of createReadStream(privatePath)) {
      const chunk = Buffer.from(raw)
      byteCount += chunk.length
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
}
