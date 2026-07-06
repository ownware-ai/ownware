/**
 * Per-thread credential runtime.
 *
 * One instance exists per live thread. Owns:
 *
 *   - The list of `CredentialHandle`s visible to the session — both
 *     auto-imported from the workspace `.env` AND runtime-requested
 *     via the `request_credential` tool.
 *   - An in-memory value cache (credentialId → plaintext) kept small
 *     enough that the shell tool's `resolveCredential` callback can be
 *     synchronous. Values are loaded from the vault lazily on first
 *     use and invalidated on `cleanup`.
 *   - The wire-up surface Loom needs: four `CredentialCallbacks`
 *     closures that `assembler.ts` plugs into the Session constructor.
 *
 * **Naming convention** (load-bearing — gateway cleanup relies on it):
 *
 *   `runtime_<threadId>_<VARIABLE_NAME>`
 *
 * On `deleteThread`, the gateway walks the vault's file list and deletes
 * every entry whose id begins with `runtime_<threadId>_`. This is why
 * MCP credentials (which use the server id as their vault key) are
 * untouched — their ids never start with `runtime_`.
 *
 * **Security invariants**:
 *
 *   1. The runtime NEVER emits a plaintext value. The single surface
 *      that reads values is `resolveCredential(id)`, which is called
 *      only by shell env-injection and the output redactor — two code
 *      paths that already have the full value flowing through them
 *      for legitimate purposes.
 *   2. The in-memory cache is per-instance; a `cleanup()` clears it
 *      and also deletes the on-disk runtime-scoped vault files.
 *   3. Loading the cache is best-effort; a vault read failure logs and
 *      leaves the entry unresolved rather than crashing the session.
 */

import type {
  CredentialHandle,
  CredentialPlacement,
  CredentialValue,
  EnvCredentialEntry,
} from '@ownware/loom'
import { readFile, access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { join } from 'node:path'
import type { CredentialVault } from '../connector/credentials/vault.js'
import { parseDotenv } from './dotenv.js'
import { classifyImportedDotenvKey } from './patterns.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Standard dotenv precedence order (highest priority first). `.env.local`
 * overrides `.env` — matching how every popular dotenv loader behaves so
 * a user's existing workflow keeps working.
 */
const DOTENV_FILENAMES: readonly string[] = Object.freeze([
  '.env.local',
  '.env',
])

/**
 * Vault-id prefix used for every credential this runtime creates. The
 * gateway's `deleteThread` path scans vault ids by this prefix to scope
 * cleanup to the thread without touching persistent (e.g. MCP) entries.
 *
 * Trailing `.` is deliberate: the id format is
 * `runtime.<threadId>.<variableName>`. Using `.` as the field separator
 * (not `_`) keeps the id unambiguously parseable even when the variable
 * name contains `_` (POSIX env vars often do — DATABASE_URL, JWT_SECRET).
 * Vault sanitization allows `.` in filenames, so no rewrite happens at
 * the storage layer.
 */
export const RUNTIME_CREDENTIAL_ID_PREFIX = 'runtime.'

/** Separator between threadId and variableName inside a runtime id. */
export const RUNTIME_CREDENTIAL_ID_SEPARATOR = '.'

/**
 * Build the vault id for a runtime credential.
 *
 *   `runtime.<safeThreadId>.<variableName>`
 *
 * `variableName` is already validated upstream to match POSIX
 * `[A-Za-z_][A-Za-z0-9_]*` — no `.`, so the LAST `.` in the full id
 * is always the threadId/varName boundary. `threadId` is sanitized to
 * `[A-Za-z0-9_-]` — also no `.`, so the FIRST `.` after the prefix is
 * always the prefix/threadId boundary. Both boundaries are unambiguous.
 */
export function makeRuntimeCredentialId(
  threadId: string,
  variableName: string,
): string {
  const safeThread = threadId.replace(/[^A-Za-z0-9_-]/g, '_')
  return `${RUNTIME_CREDENTIAL_ID_PREFIX}${safeThread}${RUNTIME_CREDENTIAL_ID_SEPARATOR}${variableName}`
}

/**
 * Parse a runtime credential id back into its parts. Returns null when
 * the id isn't a runtime-format id or is malformed. The gateway listing
 * endpoint uses this to classify vault entries for the client's manager UI.
 */
export function parseRuntimeCredentialId(
  id: string,
): { readonly threadId: string; readonly variableName: string } | null {
  if (!id.startsWith(RUNTIME_CREDENTIAL_ID_PREFIX)) return null
  const rest = id.slice(RUNTIME_CREDENTIAL_ID_PREFIX.length)
  const lastSep = rest.lastIndexOf(RUNTIME_CREDENTIAL_ID_SEPARATOR)
  if (lastSep <= 0) return null
  const threadId = rest.slice(0, lastSep)
  const variableName = rest.slice(lastSep + 1)
  if (threadId.length === 0 || variableName.length === 0) return null
  return { threadId, variableName }
}

export interface DotenvImportResult {
  /** Credentials the import stored in the vault. */
  readonly imported: readonly CredentialHandle[]
  /** Plain-config values the session may inject into the system prompt. */
  readonly configVars: Readonly<Record<string, string>>
  /** Files actually read (absolute paths). Useful for UI + diagnostics. */
  readonly filesRead: readonly string[]
  /** Lines the parser could not interpret. Keyed by file. */
  readonly parseSkipped: Readonly<Record<string, readonly number[]>>
}

// ---------------------------------------------------------------------------
// ThreadCredentialRuntime
// ---------------------------------------------------------------------------

export class ThreadCredentialRuntime {
  private readonly handles: CredentialHandle[] = []
  private readonly valueCache = new Map<string, string>()

  constructor(
    private readonly threadId: string,
    private readonly vault: CredentialVault,
  ) {}

  /**
   * Import every .env file from the workspace. Sensitive-classified
   * vars land in the vault (returned as handles); safe-classified vars
   * are returned unencrypted for system-prompt injection. The agent
   * never touches this code path — it runs server-side at session
   * start.
   *
   * Precedence: later entries override earlier ones. `DOTENV_FILENAMES`
   * lists the filenames highest-priority-first, so we iterate in
   * reverse so later-overwrite wins naturally. A file that doesn't
   * exist is silently skipped (the overwhelmingly common case).
   */
  async importFromWorkspace(workspacePath: string): Promise<DotenvImportResult> {
    const imported: CredentialHandle[] = []
    const configVars: Record<string, string> = {}
    const filesRead: string[] = []
    const parseSkipped: Record<string, readonly number[]> = {}

    // Merge pass: walk lowest-priority file first, overwrite on the way up.
    const orderLowestFirst = [...DOTENV_FILENAMES].reverse()

    // First flatten all entries, then classify + store. Flattening first
    // lets us honour precedence without re-storing the same key twice.
    const merged: Map<string, { value: string; file: string; line: number }> = new Map()
    for (const name of orderLowestFirst) {
      const absolute = join(workspacePath, name)
      try {
        await access(absolute, fsConstants.R_OK)
      } catch {
        continue
      }
      let source: string
      try {
        source = await readFile(absolute, 'utf-8')
      } catch {
        // Unreadable (permission, disappeared mid-read) — skip.
        continue
      }
      const parsed = parseDotenv(source)
      filesRead.push(absolute)
      if (parsed.skippedLines.length > 0) {
        parseSkipped[absolute] = parsed.skippedLines
      }
      for (const entry of parsed.entries) {
        merged.set(entry.key, { value: entry.value, file: absolute, line: entry.line })
      }
    }

    // Classify + store.
    for (const [key, payload] of merged) {
      const classification = classifyImportedDotenvKey(key)
      if (classification === 'config') {
        configVars[key] = payload.value
        continue
      }
      const credentialId = makeRuntimeCredentialId(this.threadId, key)
      try {
        await this.vault.save(credentialId, { [key]: payload.value })
      } catch {
        // Vault write failure — skip this key rather than aborting the
        // whole import. The agent will see the credential is missing
        // and can fall through to request_credential.
        continue
      }
      const placement: CredentialPlacement = { type: 'env', variableName: key }
      const handle: CredentialHandle = {
        credentialId,
        label: `${key} (from .env)`,
        placement,
        storedAt: Date.now(),
      }
      this.addHandle(handle)
      // Pre-populate the cache so the first shell_execute after session
      // start does not pay a vault-read latency spike.
      this.valueCache.set(credentialId, payload.value)
      imported.push(handle)
    }

    return { imported, configVars, filesRead, parseSkipped }
  }

  /**
   * Register a handle that was produced outside the .env import path
   * (e.g. by the credential-HITL flow after the user entered a value).
   *
   * The vault write is the caller's responsibility — this method only
   * tracks the handle in this runtime's list so `listEnvCredentials`
   * and the shell redactor see it immediately on the next spawn.
   */
  addHandle(handle: CredentialHandle): void {
    // Dedupe by credentialId — a re-request of the same id replaces the
    // earlier entry. `storedAt` on the new handle implies the latest
    // value; we drop the cache so the next resolve re-reads from vault.
    const existing = this.handles.findIndex(h => h.credentialId === handle.credentialId)
    if (existing !== -1) {
      this.handles.splice(existing, 1)
      this.valueCache.delete(handle.credentialId)
    }
    this.handles.push(handle)
  }

  /**
   * Pull a value from the in-memory cache, falling back to a synchronous
   * nothing (null) when the cache hasn't been populated. The async
   * pre-load path is `primeValueCache` — called once at session start
   * after the HITL or import path has written values.
   *
   * Sync by design: `ToolContext.resolveCredential` is sync so the shell
   * tool can call it per-spawn without an extra tick. Cost of that: the
   * cache must be pre-populated before the tool calls resolve. Our
   * import path does it; the HITL path does it after `vault.save`.
   */
  resolveValue(credentialId: string): string | null {
    return this.valueCache.get(credentialId) ?? null
  }

  /**
   * Force-load every known handle's value from the vault into the
   * cache. Called once at session assembly after `importFromWorkspace`
   * already populated the cache eagerly — this path matters when a
   * checkpoint / resume re-attaches a runtime to a thread without
   * re-running the import (vault is persistent across restarts).
   */
  async primeValueCache(): Promise<void> {
    for (const handle of this.handles) {
      if (this.valueCache.has(handle.credentialId)) continue
      try {
        const bundle = await this.vault.load(handle.credentialId)
        if (!bundle) continue
        // Our vault keys store one variable per bundle (`{ [varName]: value }`).
        // Use the placement's variable name when it's the env-kind;
        // otherwise, the single value in the env map wins.
        const key =
          handle.placement.type === 'env' ? handle.placement.variableName : null
        const value = key !== null
          ? bundle.env[key]
          : Object.values(bundle.env)[0]
        if (typeof value === 'string') {
          this.valueCache.set(handle.credentialId, value)
        }
      } catch {
        // Read failure — leave the cache empty for this id. The shell
        // resolveCredential will return null and the child process
        // fails loudly with "variable not set" — agent recovers via
        // request_credential.
      }
    }
  }

  /** Every env-placed credential currently known to this runtime. */
  listEnvCredentials(): readonly EnvCredentialEntry[] {
    const out: EnvCredentialEntry[] = []
    for (const handle of this.handles) {
      if (handle.placement.type === 'env') {
        out.push({
          credentialId: handle.credentialId,
          variableName: handle.placement.variableName,
        })
      }
    }
    return out
  }

  /**
   * Every credential value plus label — for REDACTORS ONLY. A value
   * returned here has exactly one legal destination class: a redactor's
   * replacement map. Two such consumers exist today — the shell output
   * redactor and the profile-hook payload redactor (webhook / save_json
   * bodies are scrubbed before egress; see `profile/hooks.ts`). The
   * forbidden destination is anything model- or wire-visible (a
   * ToolResult, a prompt, a log line). Do not add consumers outside
   * that redactor class.
   */
  listAllCredentialValues(): readonly CredentialValue[] {
    const out: CredentialValue[] = []
    for (const handle of this.handles) {
      const value = this.valueCache.get(handle.credentialId)
      if (typeof value === 'string' && value.length > 0) {
        out.push({ credentialId: handle.credentialId, value, label: handle.label })
      }
    }
    return out
  }

  /** Read-only view of handles for the HITL + UI layer. */
  listHandles(): readonly CredentialHandle[] {
    return [...this.handles]
  }

  /**
   * Remove a single handle + its cached value. Called by the credential
   * manager DELETE endpoint when the user nukes a credential mid-session.
   *
   * Does NOT touch the vault — the caller is responsible for the vault
   * delete (to keep this module vault-agnostic). Returns true when a
   * handle was found and removed; false when the id wasn't tracked.
   */
  deleteHandle(credentialId: string): boolean {
    const idx = this.handles.findIndex(h => h.credentialId === credentialId)
    this.valueCache.delete(credentialId)
    if (idx === -1) return false
    this.handles.splice(idx, 1)
    return true
  }

  /**
   * Delete every runtime-scoped credential from the vault AND clear the
   * in-memory state. Called from the gateway's `deleteThread` /
   * session-cleanup path. MCP credentials (which use non-runtime ids)
   * are unaffected.
   *
   * Best-effort: a vault delete that fails (permission, disk error) is
   * logged implicitly via the vault's own swallowing — we don't throw,
   * because a broken teardown must not leak into the next run.
   */
  async cleanup(): Promise<void> {
    const ids = this.handles.map(h => h.credentialId)
    this.handles.length = 0
    this.valueCache.clear()
    for (const id of ids) {
      if (!id.startsWith(RUNTIME_CREDENTIAL_ID_PREFIX)) continue
      try {
        await this.vault.delete(id)
      } catch {
        // Vault delete already no-ops on missing files; swallow other
        // I/O errors deliberately — cleanup is one-shot, best-effort.
      }
    }
  }
}
