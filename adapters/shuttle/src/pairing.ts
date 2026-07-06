/**
 * Pairing (SH2) — how an unknown person is authorized to talk to a personal-line
 * agent. Fail-closed: an unknown DMer gets a one-time code; the owner approves it
 * once; then they're allowed. Codes are hashed (never stored in plaintext),
 * rate-limited per user, and brute-force is locked out per channel.
 *
 * Learned from Hermes' pairing.py — the elegant bit is "no static ID lists."
 */

import { createHash, randomInt } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export class PairingRateLimitError extends Error {
  constructor(message = 'a pairing code was requested too recently') {
    super(message)
    this.name = 'PairingRateLimitError'
  }
}

export interface PairingStore {
  /** Is this user already approved on this channel? */
  isApproved(channel: string, userId: string): Promise<boolean>
  /** Mint a one-time code for an unknown user (returns plaintext once). Throws {@link PairingRateLimitError} if on cooldown. */
  requestCode(channel: string, userId: string): Promise<string>
  /** Owner approves a code → the bound user becomes approved. */
  approveCode(channel: string, code: string): Promise<{ approved: boolean; userId?: string; locked?: boolean }>
}

/** Unambiguous alphabet (no 0/O/1/I) for human-typable codes. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export interface InMemoryPairingOptions {
  /** Injectable clock (tests). Default Date.now. */
  readonly now?: () => number
  /** Code lifetime. Default 1h. */
  readonly codeTtlMs?: number
  /** Per-user cooldown between code requests. Default 10min. */
  readonly cooldownMs?: number
  /** Failed approvals before a channel lockout. Default 5. */
  readonly maxFailedApprovals?: number
  /** Lockout duration after too many failures. Default 15min. */
  readonly lockoutMs?: number
  /** Injectable code generator (tests). */
  readonly generateCode?: () => string
  readonly codeLength?: number
}

export class InMemoryPairingStore implements PairingStore {
  private readonly approved = new Set<string>()
  private readonly pending = new Map<string, { channel: string; userId: string; expiresAt: number }>()
  private readonly lastRequest = new Map<string, number>()
  private readonly failCount = new Map<string, number>()
  private readonly lockUntil = new Map<string, number>()
  private readonly salt: string
  private readonly now: () => number
  private readonly codeTtlMs: number
  private readonly cooldownMs: number
  private readonly maxFailed: number
  private readonly lockoutMs: number
  private readonly gen: () => string

  constructor(opts: InMemoryPairingOptions = {}) {
    this.now = opts.now ?? Date.now
    this.codeTtlMs = opts.codeTtlMs ?? 60 * 60 * 1000
    this.cooldownMs = opts.cooldownMs ?? 10 * 60 * 1000
    this.maxFailed = opts.maxFailedApprovals ?? 5
    this.lockoutMs = opts.lockoutMs ?? 15 * 60 * 1000
    const len = opts.codeLength ?? 8
    this.gen = opts.generateCode ?? (() => randomCode(len))
    this.salt = randomCode(16)
  }

  private key(channel: string, userId: string): string {
    return `${channel}:${userId}`
  }

  private hash(channel: string, code: string): string {
    return createHash('sha256').update(`${this.salt}:${channel}:${code}`).digest('hex')
  }

  private purgeExpired(): void {
    const t = this.now()
    for (const [h, e] of this.pending) if (e.expiresAt <= t) this.pending.delete(h)
  }

  async isApproved(channel: string, userId: string): Promise<boolean> {
    return this.approved.has(this.key(channel, userId))
  }

  async requestCode(channel: string, userId: string): Promise<string> {
    const k = this.key(channel, userId)
    const t = this.now()
    const last = this.lastRequest.get(k)
    if (last !== undefined && t - last < this.cooldownMs) throw new PairingRateLimitError()

    this.purgeExpired()
    const code = this.gen()
    this.pending.set(this.hash(channel, code), { channel, userId, expiresAt: t + this.codeTtlMs })
    this.lastRequest.set(k, t)
    return code
  }

  async approveCode(channel: string, code: string): Promise<{ approved: boolean; userId?: string; locked?: boolean }> {
    const t = this.now()
    const lock = this.lockUntil.get(channel)
    if (lock !== undefined && t < lock) return { approved: false, locked: true }

    this.purgeExpired()
    const entry = this.pending.get(this.hash(channel, code.trim().toUpperCase()))
    if (entry && entry.channel === channel && entry.expiresAt > t) {
      this.pending.delete(this.hash(channel, code.trim().toUpperCase()))
      this.approved.add(this.key(channel, entry.userId))
      this.failCount.set(channel, 0)
      return { approved: true, userId: entry.userId }
    }

    const fails = (this.failCount.get(channel) ?? 0) + 1
    if (fails >= this.maxFailed) {
      this.lockUntil.set(channel, t + this.lockoutMs)
      this.failCount.set(channel, 0)
      return { approved: false, locked: true }
    }
    this.failCount.set(channel, fails)
    return { approved: false }
  }
}

function randomCode(length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET.charAt(randomInt(ALPHABET.length))
  return out
}

// ── file-backed store ────────────────────────────────────────────────────────

/**
 * On-disk pairing state. The salt persists so code hashes survive a
 * restart, and — the point of this store — so `ownware channel approve`
 * (a separate, short-lived CLI process) can approve a code that the
 * long-running channel process minted. An in-memory store's per-process
 * salt makes that cross-process handshake impossible.
 */
interface PairingFileState {
  salt: string
  approved: string[]
  pending: Record<string, { channel: string; userId: string; expiresAt: number }>
  lastRequest: Record<string, number>
  failCount: Record<string, number>
  lockUntil: Record<string, number>
}

export interface FilePairingStoreOptions extends InMemoryPairingOptions {
  /** JSON state file (e.g. `~/.ownware/channels/pairing.json`). Created 0600. */
  readonly file: string
}

/**
 * Same rules as {@link InMemoryPairingStore} (hashed codes, cooldown,
 * lockout), persisted to a 0600 JSON file. Every operation reloads the
 * file first — the runner process and the `approve` CLI process both
 * mutate the same state, and message-rate traffic makes a per-op JSON
 * read/write a non-cost.
 */
export class FilePairingStore implements PairingStore {
  private readonly file: string
  private readonly now: () => number
  private readonly codeTtlMs: number
  private readonly cooldownMs: number
  private readonly maxFailed: number
  private readonly lockoutMs: number
  private readonly gen: () => string

  constructor(opts: FilePairingStoreOptions) {
    this.file = opts.file
    this.now = opts.now ?? Date.now
    this.codeTtlMs = opts.codeTtlMs ?? 60 * 60 * 1000
    this.cooldownMs = opts.cooldownMs ?? 10 * 60 * 1000
    this.maxFailed = opts.maxFailedApprovals ?? 5
    this.lockoutMs = opts.lockoutMs ?? 15 * 60 * 1000
    const len = opts.codeLength ?? 8
    this.gen = opts.generateCode ?? (() => randomCode(len))
  }

  private load(): PairingFileState {
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PairingFileState>
        if (typeof raw.salt === 'string' && raw.salt.length > 0) {
          return {
            salt: raw.salt,
            approved: Array.isArray(raw.approved) ? raw.approved : [],
            pending: raw.pending ?? {},
            lastRequest: raw.lastRequest ?? {},
            failCount: raw.failCount ?? {},
            lockUntil: raw.lockUntil ?? {},
          }
        }
      } catch {
        // Corrupt state file → start fresh below. Fail-closed either way:
        // a fresh state approves nobody.
      }
    }
    return { salt: randomCode(16), approved: [], pending: {}, lastRequest: {}, failCount: {}, lockUntil: {} }
  }

  private save(state: PairingFileState): void {
    mkdirSync(dirname(this.file), { recursive: true })
    // Write-then-rename so a crash mid-write can't leave a truncated file.
    const tmp = join(dirname(this.file), `.pairing-${process.pid}.tmp`)
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  private hash(salt: string, channel: string, code: string): string {
    return createHash('sha256').update(`${salt}:${channel}:${code}`).digest('hex')
  }

  private purgeExpired(state: PairingFileState): void {
    const t = this.now()
    for (const [h, e] of Object.entries(state.pending)) {
      if (e.expiresAt <= t) delete state.pending[h]
    }
  }

  async isApproved(channel: string, userId: string): Promise<boolean> {
    return this.load().approved.includes(`${channel}:${userId}`)
  }

  async requestCode(channel: string, userId: string): Promise<string> {
    const state = this.load()
    const k = `${channel}:${userId}`
    const t = this.now()
    const last = state.lastRequest[k]
    if (last !== undefined && t - last < this.cooldownMs) throw new PairingRateLimitError()

    this.purgeExpired(state)
    const code = this.gen()
    state.pending[this.hash(state.salt, channel, code)] = { channel, userId, expiresAt: t + this.codeTtlMs }
    state.lastRequest[k] = t
    this.save(state)
    return code
  }

  async approveCode(channel: string, code: string): Promise<{ approved: boolean; userId?: string; locked?: boolean }> {
    const state = this.load()
    const t = this.now()
    const lock = state.lockUntil[channel]
    if (lock !== undefined && t < lock) return { approved: false, locked: true }

    this.purgeExpired(state)
    const h = this.hash(state.salt, channel, code.trim().toUpperCase())
    const entry = state.pending[h]
    if (entry && entry.channel === channel && entry.expiresAt > t) {
      delete state.pending[h]
      const k = `${channel}:${entry.userId}`
      if (!state.approved.includes(k)) state.approved.push(k)
      state.failCount[channel] = 0
      this.save(state)
      return { approved: true, userId: entry.userId }
    }

    const fails = (state.failCount[channel] ?? 0) + 1
    if (fails >= this.maxFailed) {
      state.lockUntil[channel] = t + this.lockoutMs
      state.failCount[channel] = 0
      this.save(state)
      return { approved: false, locked: true }
    }
    state.failCount[channel] = fails
    this.save(state)
    return { approved: false }
  }
}
