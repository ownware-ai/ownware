/**
 * ChannelStore — the "vault" for channel tokens (SH1 part 3).
 *
 * `FileChannelStore` persists channel configs **encrypted at rest** (AES-256-GCM),
 * mode 0600, so bot tokens never sit in plaintext on disk. The key comes from
 * `OWNWARE_CHANNEL_SECRET` (derived via scrypt) or a per-install random key file.
 * `InMemoryChannelStore` is for tests.
 *
 * This is separate from the gateway's model-credential vault on purpose:
 * channel tokens belong to the channel runner (a gateway *client*), not to the
 * agent — keeping channels outside the engine (the whole Shuttle principle).
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChannelConfig } from './config.js'

export interface ChannelStore {
  list(): Promise<ChannelConfig[]>
  get(id: string): Promise<ChannelConfig | undefined>
  put(config: ChannelConfig): Promise<void>
  remove(id: string): Promise<void>
}

export class InMemoryChannelStore implements ChannelStore {
  private readonly map = new Map<string, ChannelConfig>()
  async list(): Promise<ChannelConfig[]> {
    return [...this.map.values()]
  }
  async get(id: string): Promise<ChannelConfig | undefined> {
    return this.map.get(id)
  }
  async put(config: ChannelConfig): Promise<void> {
    this.map.set(config.id, config)
  }
  async remove(id: string): Promise<void> {
    this.map.delete(id)
  }
}

export interface FileChannelStoreOptions {
  /** Directory for the encrypted store + key (e.g. `~/.ownware/channels`). */
  readonly dir: string
  /** Master secret; if omitted a per-install random key file is used. */
  readonly secret?: string
}

export class FileChannelStore implements ChannelStore {
  private readonly file: string
  private readonly key: Buffer

  constructor(opts: FileChannelStoreOptions) {
    mkdirSync(opts.dir, { recursive: true })
    this.file = join(opts.dir, 'channels.enc')
    this.key = resolveKey(opts.dir, opts.secret)
  }

  private read(): ChannelConfig[] {
    if (!existsSync(this.file)) return []
    return decrypt(readFileSync(this.file), this.key) as ChannelConfig[]
  }

  private write(configs: ChannelConfig[]): void {
    writeFileSync(this.file, encrypt(configs, this.key), { mode: 0o600 })
  }

  async list(): Promise<ChannelConfig[]> {
    return this.read()
  }
  async get(id: string): Promise<ChannelConfig | undefined> {
    return this.read().find((c) => c.id === id)
  }
  async put(config: ChannelConfig): Promise<void> {
    this.write([...this.read().filter((c) => c.id !== config.id), config])
  }
  async remove(id: string): Promise<void> {
    this.write(this.read().filter((c) => c.id !== id))
  }
}

// ── crypto ───────────────────────────────────────────────────────────────────
// layout: [12-byte IV][16-byte auth tag][ciphertext]

function encrypt(data: unknown, key: Buffer): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(data), 'utf-8')), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), enc])
}

function decrypt(buf: Buffer, key: Buffer): unknown {
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const enc = buf.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const dec = Buffer.concat([decipher.update(enc), decipher.final()])
  return JSON.parse(dec.toString('utf-8'))
}

function resolveKey(dir: string, secret?: string): Buffer {
  if (secret) return scryptSync(secret, 'ownware-channel-store', 32)
  const keyFile = join(dir, 'channel.key')
  if (existsSync(keyFile)) return Buffer.from(readFileSync(keyFile, 'utf-8'), 'hex')
  const key = randomBytes(32)
  writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 })
  return key
}
