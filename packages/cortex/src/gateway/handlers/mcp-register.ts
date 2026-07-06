/**
 * Handlers for `POST /api/v1/mcp/register` + `DELETE /api/v1/mcp/register/:id`
 * (T04).
 *
 * User-supplied custom MCP servers. The register handler accepts a
 * transport-specific shape (stdio with command/args/env, http/sse with
 * url/headers), persists it to the existing `mcp_servers` table with
 * the sentinel `registry_id = 'custom'`, and returns the derived id so
 * the client can follow up with `POST /profiles/:id/mcp` to attach it.
 *
 * The delete handler removes the row and purges any credential-vault
 * entries under that id — custom servers are typically api_key or env-
 * driven, so leaving their credentials around after the server is
 * gone would be a dangling secret.
 *
 * ### Security invariants (rule 14)
 *
 *   - NO command spawn at register time. The `command` string is
 *     persisted verbatim; execution happens only when a profile
 *     references the server id and the assembler builds a Session
 *     (same code path as featured servers).
 *   - NO PATH resolution. Caller provides an absolute or relative path
 *     and it's stored literally.
 *   - `env` / `headers` are NAME LISTS. Values go through the vault
 *     via `/mcp/credentials/:id`.
 *   - Zod validates EVERY body; malformed requests 400 before any
 *     disk/db write.
 *
 * ### Id derivation
 *
 *   `kebabCase(name) + '-' + random(8 chars base32)`. Kebab for
 *   human-readability; 8-char base32 suffix for collision resistance
 *   (2^40 possibilities — plenty for a local install). The server id
 *   is what users see in the catalog and reference when attaching to
 *   profiles, so we don't want it to be an opaque uuid.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readJSON, sendError, sendJSON } from '../router.js'
import type { GatewayState } from '../state.js'
import type { CredentialVault } from '../../connector/credentials/vault.js'
import {
  RegisterMCPServerBodySchema,
  CUSTOM_MCP_REGISTRY_MARKER,
  DETECTED_REGISTRY_MARKER,
  type RegisterMCPServerBody,
} from '../../connector/schema.js'
import { deriveLogicalKey } from '../../connector/logical-key.js'

export interface MCPRegisterHandlersDeps {
  readonly state: GatewayState
  readonly vault: CredentialVault
}

/**
 * Turn a human name into a kebab-case id fragment. Collapses
 * whitespace + disallowed chars to single dashes, lowercases, trims
 * leading/trailing dashes. Empty strings become `'mcp'` as a
 * last-resort fallback — the suffix still disambiguates.
 */
function kebabize(name: string): string {
  const kebab = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return kebab.length > 0 ? kebab : 'mcp'
}

/**
 * 8-char base32 suffix (40 bits of entropy). `randomBytes` is
 * CSPRNG; we strip padding and map to `[a-z2-7]` for URL-safe ids.
 */
function randomSuffix(): string {
  const bytes = randomBytes(5) // 40 bits → 8 base32 chars
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let out = ''
  // Pack 5 bytes into 8 5-bit groups.
  const bits =
    (BigInt(bytes[0]!) << 32n) |
    (BigInt(bytes[1]!) << 24n) |
    (BigInt(bytes[2]!) << 16n) |
    (BigInt(bytes[3]!) << 8n) |
    BigInt(bytes[4]!)
  for (let i = 7; i >= 0; i--) {
    const idx = Number((bits >> BigInt(i * 5)) & 31n)
    out += alphabet[idx]
  }
  return out
}

export function createMCPRegisterHandlers(deps: MCPRegisterHandlersDeps) {
  /**
   * POST /api/v1/mcp/register
   */
  async function registerServer(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const raw = await readJSON(req).catch(() => null)
    const parsed = RegisterMCPServerBodySchema.safeParse(raw ?? {})
    if (!parsed.success) {
      sendError(res, 400, `Invalid body: ${parsed.error.message}`)
      return
    }
    const body: RegisterMCPServerBody = parsed.data

    // Deduplicate — TWO independent passes:
    //
    // 1. **Endpoint dedup:** same transport + URL/command means literally
    //    the same server. Return the existing row idempotently.
    // 2. **Logical-key dedup:** different endpoint, same logical app
    //    (e.g. user typed "Figma" and we already have an auto-detected
    //    Figma row, or a different Figma transport already registered).
    //    Same logical app should not produce a second row — return the
    //    existing one. This is what kills the "3 Figma cards" production
    //    bug at the source.
    //
    // Both auto-detected (`registry_id = 'detected'`) and user-registered
    // (`registry_id = 'custom'`) rows participate in dedup. Featured-only
    // entries are skipped — they have no row yet (the MCP source provider
    // surfaces them from the curated catalog).
    const existing = deps.state.listMCPServers({ limit: 200 })
    const endpointKey = body.transport === 'stdio'
      ? `stdio:${body.command ?? ''}:${(body.args ?? []).join(',')}`
      : `${body.transport}:${body.url ?? ''}`
    // The new row's logicalKey is derived from its (yet-to-be-generated)
    // id. Since the id will be `kebabize(name)-<8 base32>` and our
    // `deriveLogicalKey('custom_mcp', id)` strips the random suffix, the
    // logicalKey IS `kebabize(body.name)`.
    const newLogicalKey = kebabize(body.name)

    for (const row of existing.items) {
      if (
        row.registryId !== CUSTOM_MCP_REGISTRY_MARKER &&
        row.registryId !== DETECTED_REGISTRY_MARKER
      ) continue

      // 1. Endpoint dedup
      const rowKey = row.transport === 'stdio'
        ? `stdio:${row.command ?? ''}:${(row.args ?? []).join(',')}`
        : `${row.transport}:${row.url ?? ''}`
      if (rowKey === endpointKey) {
        sendJSON(res, 200, {
          id: row.id,
          source: 'mcp',
          status: 'needs_setup',
          name: row.name,
          transport: row.transport,
          dedupedBy: 'endpoint',
        })
        return
      }

      // 2. Logical-key dedup — same app (Figma, Notion, etc.) regardless
      // of transport. Phase 16 (2026-05-01): both detected and user-
      // registered rows now live under the unified `'mcp'` source label.
      // `deriveLogicalKey('mcp', id)` strips the auto-id suffix when
      // present (e.g. `figma-c4vrjq3w` → `figma`) and passes through
      // stable slugs (`figma`) untouched.
      const rowLogicalKey = deriveLogicalKey('mcp', row.id)
      if (rowLogicalKey === newLogicalKey) {
        sendJSON(res, 200, {
          id: row.id,
          source: 'mcp',
          status: 'needs_setup',
          name: row.name,
          transport: row.transport,
          dedupedBy: 'logicalKey',
        })
        return
      }
    }

    // Derive id. Retry up to 3 times if the suffix collides — should
    // never happen in practice (2^40 space) but the loop guards against
    // the vanishingly-small case rather than silently overwriting a
    // prior row.
    let id = ''
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = `${kebabize(body.name)}-${randomSuffix()}`
      if (!deps.state.getMCPServer(candidate)) {
        id = candidate
        break
      }
    }
    if (id.length === 0) {
      sendError(
        res,
        500,
        'Failed to derive a unique id for the custom MCP server (3 collisions in a row — try again).',
      )
      return
    }

    try {
      // Build the mcp_servers row. Transport-specific fields are
      // already shape-validated by the Zod refinement above, so we
      // know the right set is present.
      deps.state.createMCPServer({
        id,
        name: body.name,
        // Database `transport` is a free-form string; map `http` → `http`,
        // `sse` → `sse`, `stdio` → `stdio`. No remapping.
        transport: body.transport,
        url: body.transport === 'stdio' ? undefined : body.url,
        command: body.transport === 'stdio' ? body.command : undefined,
        args: body.transport === 'stdio' ? body.args : undefined,
        // Env (stdio) and headers (http/sse): we persist NAMES only —
        // values live in the credential vault and arrive at session-
        // spawn time. For stdio, the value is the `${NAME}` reference
        // syntax that `resolveEnvVarsWithFallback` (assembler.ts) looks
        // up against the loaded credential bundle — the same convention
        // featured stdio servers use. For http/sse headers we stash
        // empty placeholders; header substitution doesn't run through
        // the env resolver today (a pre-existing gap, not in this
        // chunk's scope — tracked in BUGS.md).
        env:
          body.transport === 'stdio' && body.env
            ? Object.fromEntries(body.env.map((e) => [e, `\${${e}}`]))
            : undefined,
        headers:
          body.transport !== 'stdio' && body.headers
            ? Object.fromEntries(body.headers.map((h) => [h, '']))
            : undefined,
        // Sentinel marker: distinguishes API-registered customs from
        // featured or public-registry entries.
        registryId: CUSTOM_MCP_REGISTRY_MARKER,
      })

      // Response: the id is the primary piece the client needs. Echo
      // back a few identifying fields so the UI can render without a
      // follow-up read. Phase 16: source is now `'mcp'` (was `'custom_mcp'`).
      sendJSON(res, 201, {
        id,
        source: 'mcp',
        status: 'needs_setup',
        name: body.name,
        transport: body.transport,
      })
    } catch (err) {
      sendError(
        res,
        500,
        `Failed to persist custom MCP server: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * DELETE /api/v1/mcp/register/:id
   */
  async function unregisterServer(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const id = params['id']
    if (!id || id.length === 0) {
      sendError(res, 400, 'Server id is required.')
      return
    }
    const existing = deps.state.getMCPServer(id)
    if (!existing) {
      sendError(res, 404, `Custom MCP server "${id}" not found.`)
      return
    }
    // Defensive: don't let this endpoint delete non-custom rows.
    // Featured servers or registry-attached servers share the same
    // table; refusing to delete them here keeps responsibilities
    // clean. A featured server must be unattached via
    // `/profiles/:id/mcp` DELETE (which has its own flow).
    if (existing.registryId !== CUSTOM_MCP_REGISTRY_MARKER) {
      sendError(
        res,
        400,
        `Server "${id}" is not an API-registered custom server and cannot be deleted via /mcp/register. Use /profiles/:id/mcp/:id instead.`,
      )
      return
    }

    try {
      deps.state.deleteMCPServer(id)
      // Purge any vault entries under this id. Custom servers are
      // typically api_key/env-driven; leaving their credentials
      // orphaned would be a dangling secret.
      await deps.vault.delete(id)
    } catch (err) {
      sendError(
        res,
        500,
        `Failed to delete custom MCP server: ${err instanceof Error ? err.message : String(err)}`,
      )
      return
    }

    res.writeHead(204)
    res.end()
  }

  return {
    /** POST /api/v1/mcp/register */
    registerServer,
    /** DELETE /api/v1/mcp/register/:id */
    unregisterServer,
  }
}
