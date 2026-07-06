/**
 * MCP Credential Store — thin back-compat wrapper over the generalized
 * `CredentialVault` in `../credentials/vault.ts`.
 *
 * Location on disk: ~/.ownware/credentials/<serverId>.json.
 * File format: AES-256-GCM v2 (UNCHANGED). v1/legacy reads auto-migrate.
 *
 * Every previously-exported symbol keeps the same name + semantics:
 *   - MCPCredentialStore (class)
 *   - credentialStore (default instance)
 *   - encryptCredential / decryptCredential (legacy helpers exposed for
 *     tests and any downstream caller that linked to them directly)
 *   - __resetMasterKeyCacheForTests (same module-level master-key cache
 *     is shared with the new vault, so a single reset works for both)
 *
 * The canonical logic lives in `connector/credentials/vault.ts`. This file
 * exists so existing imports (`../connector/mcp/credentials.js` from the
 * assembler, the gateway handlers, and existing tests) keep resolving.
 */

import type { MCPCredentials } from '../types.js'
import {
  CredentialVault,
  encryptV1,
  encryptV2,
  decrypt,
  __resetMasterKeyCacheForTests as resetMasterKeyCache,
} from '../credentials/vault.js'

// ---------------------------------------------------------------------------
// Legacy encryption exports
// ---------------------------------------------------------------------------

/**
 * Encrypt plaintext → legacy v1 format ("iv:authTag:ciphertext").
 *
 * Kept only because existing tests import this name. Production writes go
 * through `MCPCredentialStore.save()` which uses v2 encryption.
 */
export function encryptCredential(plaintext: string): string {
  return encryptV1(plaintext)
}

/**
 * Decrypt v2 ("v2:iv:authTag:ciphertext") OR v1 ("iv:authTag:ciphertext").
 * Returns null on any failure.
 */
export function decryptCredential(data: string): string | null {
  return decrypt(data)
}

/** Test-only hook — clear the in-process master-key cache. */
export function __resetMasterKeyCacheForTests(): void {
  resetMasterKeyCache()
}

// Re-export v2 encryption for any consumer that was reaching for it.
export { encryptV2 }

// ---------------------------------------------------------------------------
// MCPCredentialStore — back-compat facade over CredentialVault
// ---------------------------------------------------------------------------

export class MCPCredentialStore {
  private readonly vault: CredentialVault

  constructor(dir?: string) {
    this.vault = new CredentialVault(dir)
  }

  async save(serverId: string, env: Record<string, string>): Promise<void> {
    await this.vault.save(serverId, env)
  }

  async load(serverId: string): Promise<MCPCredentials | null> {
    const bundle = await this.vault.load(serverId)
    if (!bundle) return null
    // Translate vault's `connectorId` back to `serverId` for MCP callers.
    return {
      serverId: bundle.connectorId,
      env: bundle.env,
      updatedAt: bundle.updatedAt,
    }
  }

  async delete(serverId: string): Promise<void> {
    await this.vault.delete(serverId)
  }

  async list(): Promise<string[]> {
    return this.vault.list()
  }

  async checkEnvVars(
    serverId: string,
    requiredVars: readonly string[],
  ): Promise<Record<string, boolean>> {
    return this.vault.checkEnvVars(serverId, requiredVars)
  }

  async resolveEnv(
    serverId: string,
    requiredVars: readonly string[],
  ): Promise<Record<string, string>> {
    return this.vault.resolveEnv(serverId, requiredVars)
  }
}

// ---------------------------------------------------------------------------
// Default instance
// ---------------------------------------------------------------------------

/** Default credential store at ~/.ownware/credentials/. */
export const credentialStore = new MCPCredentialStore()
