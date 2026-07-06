/**
 * Generalized Credential Vault
 *
 * Stores per-connector credential bundles locally on the user's machine,
 * encrypted with AES-256-GCM using a random master key.
 *
 * Master-key source (in order):
 *   1. `OWNWARE_MASTER_KEY` env var (hex-encoded 32 bytes) — the preferred
 *      path. On the Electron desktop ship the supervisor seals the key in
 *      the OS keychain (safeStorage) and injects it here, so the key never
 *      sits in cleartext on disk.
 *   2. `~/.ownware/.master-key` (mode 0600) — the on-disk fallback for the
 *      cloud packaging, dev, and headless hosts with no keychain. Generated
 *      on first use if absent.
 *
 * This vault is the canonical storage layer for every connector kind —
 * built-in, MCP, Composio (future), custom (future). It is keyed by an
 * opaque `connectorId` string that the caller supplies. For MCP servers
 * the connectorId is the registry server id (preserving the exact
 * on-disk filenames the previous `MCPCredentialStore` produced so
 * existing encrypted credential files remain readable without migration).
 *
 * The on-disk format is unchanged from the previous `MCPCredentialStore`:
 *
 *   ~/.ownware/credentials/<connectorId>.json
 *     Payload (plaintext form, serialized as JSON, then encrypted):
 *       { serverId: string, env: Record<string,string>, updatedAt: string }
 *     The outer file is "v2:<ivHex>:<authTagHex>:<cipherHex>" (current) or
 *     "<ivHex>:<authTagHex>:<cipherHex>" (legacy v1, auto-migrated on read).
 *
 * The payload keeps the historical field name `serverId` inside the JSON for
 * byte-for-byte compatibility with files written by the pre-vault code. The
 * vault API exposes it as `connectorId` externally; the field name is an
 * internal storage detail.
 */

import { readFile, writeFile, mkdir, rm, readdir, rename, chmod } from 'node:fs/promises'
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  chmodSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir, hostname, userInfo } from 'node:os'
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto'

import { DEFAULT_DATA_DIR_NAME } from '../../constants.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Data dir resolved LAZILY (per call, not at import) and honoring
 * `OWNWARE_DATA_DIR` — the same env contract the gateway uses
 * (`gateway/server.ts`: `opts.dataDir ?? OWNWARE_DATA_DIR ?? ~/.ownware`).
 * A module-scope `join(homedir(), …)` constant here made the vault
 * write into the user's real `~/.ownware` even when the host process was
 * configured for a different data dir.
 */
function dataDir(): string {
  return process.env['OWNWARE_DATA_DIR'] ?? join(homedir(), DEFAULT_DATA_DIR_NAME)
}
function defaultCredentialsDir(): string {
  return join(dataDir(), 'credentials')
}
function masterKeyFile(): string {
  return join(dataDir(), '.master-key')
}
/**
 * Env var carrying the master key (hex-encoded 32 bytes). Set by the
 * Electron supervisor from the OS keychain so the key stays off disk.
 */
const MASTER_KEY_ENV = 'OWNWARE_MASTER_KEY'
const ENCRYPTION_SALT = 'cortex-credential-store-v1'
const ALGORITHM = 'aes-256-gcm' as const
const IV_LENGTH = 16
const KEY_LENGTH = 32

// ---------------------------------------------------------------------------
// Public payload shape
// ---------------------------------------------------------------------------

/**
 * Decrypted credential bundle for a connector.
 *
 * Note: the on-disk JSON uses `serverId` (legacy field name) for the
 * connectorId so pre-vault files keep working without migration. The
 * public API uses `connectorId` and translates.
 */
export interface CredentialBundle {
  readonly connectorId: string
  readonly env: Record<string, string>
  readonly updatedAt: string
}

/** On-disk shape (do not rename — back-compat with pre-vault files). */
interface OnDiskBundle {
  readonly serverId: string
  readonly env: Record<string, string>
  readonly updatedAt: string
}

// ---------------------------------------------------------------------------
// Master key (v2 encryption) — random 32-byte key persisted to disk.
//
// Previously lived in `connector/mcp/credentials.ts`. Logic is byte-for-byte
// identical; only the home is different.
// ---------------------------------------------------------------------------

let cachedMasterKey: Buffer | null = null

function getMasterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey

  // Preferred source: the host injects the key via env (sealed in the OS
  // keychain on desktop). When present we use it verbatim and never touch
  // the on-disk file. A malformed value (wrong length) falls through to
  // the file path rather than silently encrypting under a truncated key.
  const fromEnv = process.env[MASTER_KEY_ENV]
  if (fromEnv) {
    const decoded = Buffer.from(fromEnv, 'hex')
    if (decoded.length === KEY_LENGTH) {
      cachedMasterKey = decoded
      return decoded
    }
  }

  try {
    const data = readFileSync(masterKeyFile())
    if (data.length === KEY_LENGTH) {
      cachedMasterKey = data
      return data
    }
  } catch {
    // ENOENT / unreadable — fall through to generate
  }

  try {
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 })
    try { chmodSync(dataDir(), 0o700) } catch { /* best-effort */ }
  } catch {
    // Fall back to in-memory-only key — next run retries.
  }

  const newKey = randomBytes(KEY_LENGTH)
  const keyFile = masterKeyFile()
  const tmpPath = `${keyFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmpPath, newKey, { mode: 0o600 })
    renameSync(tmpPath, keyFile)
    try { chmodSync(keyFile, 0o600) } catch { /* best-effort */ }
  } catch {
    try { unlinkSync(tmpPath) } catch { /* best-effort */ }
  }

  cachedMasterKey = newKey
  return newKey
}

/** Test-only hook — clears the in-process master-key cache. */
export function __resetMasterKeyCacheForTests(): void {
  cachedMasterKey = null
}

// ---------------------------------------------------------------------------
// Legacy v1 helpers (kept for backward-compat reads + the existing test
// surface that exported these from `mcp/credentials.ts`).
// ---------------------------------------------------------------------------

function deriveLegacyKey(): Buffer {
  const material = `${hostname()}-${userInfo().username}`
  return scryptSync(material, ENCRYPTION_SALT, 32)
}

/**
 * Encrypt plaintext → "iv:authTag:ciphertext" (legacy v1 format).
 *
 * Kept only for back-compat with the previously-exported `encryptCredential`
 * from `mcp/credentials.ts`. New writes go through `encryptV2`.
 */
export function encryptV1(plaintext: string): string {
  const key = deriveLegacyKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  let encrypted = cipher.update(plaintext, 'utf-8', 'hex')
  encrypted += cipher.final('hex')
  const authTag = cipher.getAuthTag().toString('hex')
  return `${iv.toString('hex')}:${authTag}:${encrypted}`
}

/**
 * Decrypt v1 ("iv:authTag:ciphertext") OR v2 ("v2:iv:authTag:ciphertext").
 * Returns null on any failure.
 */
export function decrypt(data: string): string | null {
  try {
    const parts = data.split(':')

    let key: Buffer
    let ivHex: string
    let authTagHex: string
    let ciphertext: string

    if (parts.length === 4 && parts[0] === 'v2') {
      key = getMasterKey()
      ivHex = parts[1]!
      authTagHex = parts[2]!
      ciphertext = parts[3]!
    } else if (parts.length === 3) {
      key = deriveLegacyKey()
      ivHex = parts[0]!
      authTagHex = parts[1]!
      ciphertext = parts[2]!
    } else {
      return null
    }

    const iv = Buffer.from(ivHex, 'hex')
    const authTag = Buffer.from(authTagHex, 'hex')
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)
    let decrypted = decipher.update(ciphertext, 'hex', 'utf-8')
    decrypted += decipher.final('utf-8')
    return decrypted
  } catch {
    return null
  }
}

/**
 * Encrypt using the v2 master key. Returns "v2:iv:authTag:cipher".
 */
export function encryptV2(plaintext: string): string {
  const key = getMasterKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  let encrypted = cipher.update(plaintext, 'utf-8', 'hex')
  encrypted += cipher.final('hex')
  const authTag = cipher.getAuthTag().toString('hex')
  return `v2:${iv.toString('hex')}:${authTag}:${encrypted}`
}

// ---------------------------------------------------------------------------
// CredentialVault
// ---------------------------------------------------------------------------

/**
 * Per-connector credential vault. Safe to instantiate multiple times with
 * different directories (e.g. for tests). All instances share the same
 * master key via the module-level cache; tests that need isolation should
 * call `__resetMasterKeyCacheForTests()` between runs and set
 * `OWNWARE_DATA_DIR` so the master-key file points somewhere disposable.
 */
export class CredentialVault {
  private readonly dir: string

  constructor(dir?: string) {
    this.dir = dir ?? defaultCredentialsDir()
  }

  /**
   * Save credentials for a connector.
   *
   * Atomicity: writes to a temp file in the same directory and renames it
   * into place. POSIX rename(2) is atomic for the destination — a process
   * crash mid-write leaves either the old file or the new file, never a
   * half-written one. The temp filename includes pid + random so
   * concurrent saves don't collide. Directory and file are created with
   * restrictive modes (0700 / 0600).
   */
  async save(connectorId: string, env: Record<string, string>): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    try { await chmod(this.dir, 0o700) } catch { /* best-effort */ }

    const payload: OnDiskBundle = {
      serverId: connectorId, // on-disk field name preserved for back-compat
      env,
      updatedAt: new Date().toISOString(),
    }

    const encrypted = encryptV2(JSON.stringify(payload))
    const filePath = this.filePath(connectorId)
    const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`

    try {
      await writeFile(tmpPath, encrypted, { encoding: 'utf-8', mode: 0o600 })
      await rename(tmpPath, filePath)
      try { await chmod(filePath, 0o600) } catch { /* best-effort */ }
    } catch (err) {
      try { await rm(tmpPath, { force: true }) } catch { /* best-effort */ }
      throw err
    }
  }

  /**
   * Load credentials for a connector.
   *
   * Decryption order: v2 (master key) → v1 (legacy host-derived key) →
   * plain JSON (oldest format). Successful read in a non-current format
   * triggers immediate re-save as v2 (auto-migration). Returns null if
   * the file doesn't exist or all decoders fail.
   */
  async load(connectorId: string): Promise<CredentialBundle | null> {
    let raw: string
    try {
      raw = await readFile(this.filePath(connectorId), 'utf-8')
    } catch {
      return null
    }

    const decrypted = decrypt(raw)
    if (decrypted !== null) {
      try {
        const onDisk = JSON.parse(decrypted) as OnDiskBundle
        if (!onDisk.serverId || !onDisk.env) return null
        const isV2 = raw.startsWith('v2:')
        if (!isV2) {
          try {
            await this.save(onDisk.serverId, onDisk.env)
          } catch {
            // Migration is best-effort.
          }
        }
        return {
          connectorId: onDisk.serverId,
          env: onDisk.env,
          updatedAt: onDisk.updatedAt,
        }
      } catch {
        return null
      }
    }

    // Legacy plaintext JSON
    try {
      const onDisk = JSON.parse(raw) as OnDiskBundle
      if (onDisk.serverId && onDisk.env) {
        await this.save(onDisk.serverId, onDisk.env)
        return {
          connectorId: onDisk.serverId,
          env: onDisk.env,
          updatedAt: onDisk.updatedAt,
        }
      }
      return null
    } catch {
      return null
    }
  }

  async delete(connectorId: string): Promise<void> {
    try {
      await rm(this.filePath(connectorId))
    } catch {
      // File doesn't exist — that's fine
    }
  }

  async list(): Promise<string[]> {
    try {
      const files = await readdir(this.dir)
      return files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''))
    } catch {
      return []
    }
  }

  /**
   * Check which env vars are set for a connector (stored creds OR process.env).
   */
  async checkEnvVars(
    connectorId: string,
    requiredVars: readonly string[],
  ): Promise<Record<string, boolean>> {
    const creds = await this.load(connectorId)
    const result: Record<string, boolean> = {}
    for (const varName of requiredVars) {
      result[varName] = !!(creds?.env[varName] ?? process.env[varName])
    }
    return result
  }

  /**
   * Resolve env values (stored creds take priority over process.env).
   */
  async resolveEnv(
    connectorId: string,
    requiredVars: readonly string[],
  ): Promise<Record<string, string>> {
    const creds = await this.load(connectorId)
    const resolved: Record<string, string> = {}
    for (const varName of requiredVars) {
      const value = creds?.env[varName] ?? process.env[varName]
      if (value) resolved[varName] = value
    }
    return resolved
  }

  private filePath(connectorId: string): string {
    const safe = connectorId.replace(/[^a-zA-Z0-9._-]/g, '_')
    return join(this.dir, `${safe}.json`)
  }
}

/** Default vault at ~/.ownware/credentials/. */
export const credentialVault = new CredentialVault()
