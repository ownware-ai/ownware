/**
 * Credential descriptors (board: credentials-unification — C02).
 *
 * A `CredentialDescriptor` is the static declaration a tool, MCP server,
 * or connector ships saying "I need this credential to operate". The
 * gateway's resolver walks descriptors at use time:
 *
 *   - Found?  → resolve and inject at the OS boundary.
 *   - Missing? → emit `credential.missing` SSE → renderer mounts
 *                `<CredentialCard>` → user fills → run resumes.
 *
 * The descriptor never carries a value. It carries the metadata the
 * card UI needs to ask the user for one (label, where to obtain, auth
 * shape) and the metadata the resolver needs to find / create the right
 * credential record (`name`, `category`, `forConnector`).
 *
 * ### Why this lives next to `schema.ts`
 *
 * Descriptors and credentials share the same enumerations
 * (`CredentialCategory`, `CredentialAuthType`). Co-locating them keeps
 * the import graph one-deep and prevents the inevitable drift that
 * happens when a new authType is added in one place but not the other.
 *
 * ### Connector parity
 *
 * `connector/schema.ts` already declares MCP-server credential needs as
 * `auth.envVars[]` with shape `{ name, description, isRequired, isSecret }`.
 * We deliberately DO NOT redefine that shape here. Instead, the
 * `descriptorFromConnectorEnvVar` helper bridges one envVar entry into
 * one descriptor, dropping `isSecret: false` entries (those are config,
 * not credentials). Tests pin this parity so a connector field rename
 * fails loudly.
 */

import { z } from 'zod'
import {
  CredentialAuthTypeSchema,
  CredentialCategorySchema,
  type CredentialAuthType,
} from './schema.js'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Static declaration of one credential a tool / MCP / connector needs.
 *
 * Field semantics:
 *
 *   - `name` is the canonical lookup key. It MUST equal the credential's
 *     `variableName` (when authType is api-key / bearer-token) so the
 *     gateway can find an existing credential by name without a separate
 *     join. Validated with the same POSIX env-var shape as `schema.ts`.
 *
 *   - `description` is shown verbatim to the user inside the card. Keep
 *     it short and concrete — "Vercel deploy token (read+write)" beats
 *     "API key for the Vercel platform".
 *
 *   - `getKeyUrl` deep-links to the provider's token-creation page when
 *     known. Renders as the "Get one ↗" affordance on the card.
 *
 *   - `authType` drives BOTH the form (api-key vs OAuth button) and the
 *     injector (env var vs Authorization header).
 *
 *   - `isRequired` — when false, the run continues with a sentinel and
 *     the tool's handler decides how to fall back. Default: true.
 *
 *   - `category` / `forConnector` are populated when the card-driven
 *     `POST /credentials` creates a fresh row, so the new credential
 *     lands tagged with its origin without a follow-up PATCH.
 */
export const CredentialDescriptorSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
        message: 'name must match /^[A-Za-z_][A-Za-z0-9_]*$/ (POSIX env-var shape)',
      }),
    description: z.string().min(1).max(512),
    getKeyUrl: z.string().url().optional(),
    authType: CredentialAuthTypeSchema,
    isRequired: z.boolean().default(true),
    category: CredentialCategorySchema.optional(),
    forConnector: z.string().min(1).max(256).optional(),
    /** Optional placeholder for the input field on the card. */
    placeholder: z.string().max(128).optional(),
  })
  .strict()

export type CredentialDescriptor = z.infer<typeof CredentialDescriptorSchema>

/** Array form — matches the `requires: CredentialDescriptor[]` field on tool definitions. */
export const CredentialDescriptorListSchema = z
  .array(CredentialDescriptorSchema)
  .max(32)
  .superRefine((list, ctx) => {
    // Names within one tool's requires[] must be unique — duplicates
    // would mean two cards asking for the same env var, which is a
    // tool-author bug, not a runtime condition.
    const seen = new Set<string>()
    for (const [idx, descriptor] of list.entries()) {
      if (seen.has(descriptor.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [idx, 'name'],
          message: `duplicate descriptor name "${descriptor.name}"`,
        })
      }
      seen.add(descriptor.name)
    }
  })

// ---------------------------------------------------------------------------
// Connector → descriptor bridge
// ---------------------------------------------------------------------------

/**
 * Subset of one entry from `connector/schema.ts`'s `auth.envVars[]`.
 * Declared inline (not imported) so this module keeps a one-direction
 * dependency on `schema.ts` only — descriptors must be importable from
 * loom without dragging in the connector graph.
 */
export interface ConnectorEnvVarLike {
  readonly name: string
  readonly description: string
  readonly isRequired: boolean
  readonly isSecret: boolean
}

/**
 * Convert one connector env-var declaration to a credential descriptor.
 * Returns `null` for non-secret entries — those are plain config and
 * belong in the system-prompt context, not the credential vault.
 *
 * The descriptor's `forConnector` is set to the connector's id so the
 * unified Credentials page can render this credential under its
 * connector group, and so a future cleanup can scope by connector.
 *
 * `authType` defaults to `'api-key'`; OAuth-based connectors use a
 * different code path (`/connectors/:id/connect` returns the OAuth URL
 * directly) and never reach this helper.
 */
export function descriptorFromConnectorEnvVar(
  connectorId: string,
  envVar: ConnectorEnvVarLike,
  authType: CredentialAuthType = 'api-key',
): CredentialDescriptor | null {
  if (!envVar.isSecret) return null
  return {
    name: envVar.name,
    description: envVar.description,
    authType,
    isRequired: envVar.isRequired,
    forConnector: connectorId,
    category: 'mcp-server',
  }
}

/**
 * Convert every secret env-var on a connector to a descriptor list,
 * preserving order. Non-secret entries are dropped (see
 * `descriptorFromConnectorEnvVar`). De-dupes by `name` — defensive
 * against a connector definition that lists the same var twice.
 */
export function descriptorsFromConnectorEnvVars(
  connectorId: string,
  envVars: readonly ConnectorEnvVarLike[],
  authType: CredentialAuthType = 'api-key',
): readonly CredentialDescriptor[] {
  const out: CredentialDescriptor[] = []
  const seen = new Set<string>()
  for (const ev of envVars) {
    const descriptor = descriptorFromConnectorEnvVar(connectorId, ev, authType)
    if (descriptor === null) continue
    if (seen.has(descriptor.name)) continue
    seen.add(descriptor.name)
    out.push(descriptor)
  }
  return out
}
