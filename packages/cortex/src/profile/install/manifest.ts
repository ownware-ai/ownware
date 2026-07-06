/**
 * Marketplace manifest — `cortex.profile.json` at repo root.
 *
 * Distinct from the per-profile `agent.json`. The manifest describes the
 * REPO as a unit:
 *   - which top-level profiles ship in this repo
 *   - human-readable summary / category for the marketplace card
 *   - which connectors and capabilities the user is about to grant
 *
 * Why a separate file from agent.json:
 *   - One repo can ship N top-level profiles (each with its own agent.json);
 *     the manifest is the single index for the install pipeline.
 *   - The preflight endpoint fetches ONLY this file (one HTTP GET) and
 *     never sees the per-profile agent.json. That keeps preview cheap and
 *     prevents a 30-field agent.json from blocking the preview UX.
 *   - The marketplace contract can evolve independently of the runtime
 *     profile schema.
 *
 * Helpers (folder convention `<profile>/helpers/`) are NOT listed in this
 * manifest. Their existence is folder-derived; surfacing them as manifest
 * entries would just duplicate filesystem state.
 */

import { z } from 'zod'
import { InstallError } from './errors.js'

/**
 * Capability tag — plain-English description of what the profile can DO.
 * The preflight card shows these instead of a list of tool names. The
 * mapping from `tools.preset` + zone config to capability tags lives in
 * the manifest (author-declared); we never infer it.
 */
export const CapabilityTagSchema = z.enum([
  'filesystem-read',
  'filesystem-rw',
  'shell',
  'web',
  'browser',
  'subagents',
  'network',
])
export type CapabilityTag = z.infer<typeof CapabilityTagSchema>

/**
 * Auth shape for a connector. The preflight card uses this to label the
 * data source ("no setup", "free API key", "paid", "OAuth login").
 */
export const ConnectorAuthSchema = z.enum([
  'none',
  'free-key',
  'paid-key',
  'oauth',
])
export type ConnectorAuth = z.infer<typeof ConnectorAuthSchema>

/**
 * One declared connector — what the profile will reach for and how the
 * user authenticates to it. Required defaults to `true`; profiles set it
 * `false` for optional integrations (e.g. FactSet — works without it).
 */
export const ConnectorDeclSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  auth: ConnectorAuthSchema,
  required: z.boolean().default(true),
  hint: z.string().max(280).optional(),
})
export type ConnectorDecl = z.infer<typeof ConnectorDeclSchema>

/**
 * One top-level profile shipped by the repo. `path` is relative to the
 * repo root and points at the directory containing the profile's
 * `agent.json`. `name` is the profile's display name.
 *
 * `path` MUST be relative, MUST NOT contain `..`, MUST NOT be absolute.
 * The installer enforces this at parse time.
 */
export const ProfileEntrySchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, {
    message: 'profile name must match ^[a-zA-Z0-9_-]+$',
  }),
  path: z.string().min(1).max(256).refine(
    (p) => !p.startsWith('/') && !p.includes('..') && !/^[A-Za-z]:/.test(p),
    { message: 'path must be a relative subpath (no leading /, no .., no drive letter)' },
  ),
})
export type ProfileEntry = z.infer<typeof ProfileEntrySchema>

/**
 * Full marketplace manifest. Strict — extra fields at the top level fail
 * validation so a typo doesn't get silently dropped.
 */
export const MarketplaceManifestSchema = z.object({
  schema: z.literal(1),
  id: z.string().min(1).max(128).regex(
    /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/,
    { message: 'id must be in the form "<owner>/<repo>"' },
  ),
  summary: z.string().min(1).max(280),
  category: z.string().min(1).max(64).default('General'),
  models: z.array(z.string().min(1).max(128)).max(8).default([]),
  connectors: z.array(ConnectorDeclSchema).max(32).default([]),
  capabilities: z.array(CapabilityTagSchema).max(16).default([]),
  profiles: z.array(ProfileEntrySchema).min(1).max(32),
}).strict()

export type MarketplaceManifest = z.infer<typeof MarketplaceManifestSchema>

/** Hard limits the parser enforces irrespective of Zod schema. */
export const MANIFEST_MAX_BYTES = 64 * 1024 // 64 KB

/**
 * Parse + validate a `cortex.profile.json` payload. Throws
 * `InstallError('invalid_manifest', { issues })` with every Zod issue on
 * failure — caller gets all problems in one shot.
 *
 * Input is the raw string contents of the file. We do byte-length and
 * JSON-parse checks here so the rest of the install pipeline gets a
 * fully-typed manifest or a clean error.
 */
export function parseManifest(raw: string): MarketplaceManifest {
  const byteLen = Buffer.byteLength(raw, 'utf-8')
  if (byteLen > MANIFEST_MAX_BYTES) {
    throw new InstallError('invalid_manifest', {
      issues: [`manifest exceeds ${MANIFEST_MAX_BYTES} bytes (got ${byteLen})`],
    })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new InstallError('invalid_manifest', {
      issues: [`JSON parse error: ${err instanceof Error ? err.message : String(err)}`],
    })
  }

  const result = MarketplaceManifestSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((i) => {
      const path = i.path.length > 0 ? i.path.join('.') : 'root'
      return `${path}: ${i.message}`
    })
    throw new InstallError('invalid_manifest', { issues })
  }

  // Cross-field validation that Zod can't express ergonomically:
  //   - profile names must be unique
  //   - profile paths must be unique
  const seenNames = new Set<string>()
  const seenPaths = new Set<string>()
  const dupIssues: string[] = []
  for (const p of result.data.profiles) {
    if (seenNames.has(p.name)) dupIssues.push(`duplicate profile name '${p.name}'`)
    if (seenPaths.has(p.path)) dupIssues.push(`duplicate profile path '${p.path}'`)
    seenNames.add(p.name)
    seenPaths.add(p.path)
  }
  if (dupIssues.length > 0) {
    throw new InstallError('invalid_manifest', { issues: dupIssues })
  }

  return result.data
}
