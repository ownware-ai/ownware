/**
 * CredentialDescriptor — loom-side TS interface (board:
 * credentials-unification — C37).
 *
 * The static declaration a tool ships saying "I need this credential
 * to operate". Loom owns the type because it lives on the `Tool`
 * interface (`requires: CredentialDescriptor[]`). The gateway side
 * adds runtime Zod validation on top of the same shape — see
 * `packages/cortex/src/credential/descriptors.ts`.
 *
 * The two MUST stay in lock-step. If a future field is added in
 * loom, the gateway's Zod schema needs the same field; if a field
 * is added on the gateway with stricter rules, loom's interface
 * widens to match. The cortex tests pin the parity.
 *
 * ### Field semantics (mirrors the gateway docs)
 *
 *   - `name` — canonical lookup key. MUST equal the credential's
 *     `variableName` (when authType is api-key / bearer-token) so
 *     the gateway can find an existing credential by name without
 *     a separate join. POSIX env-var shape (`/^[A-Za-z_][A-Za-z0-9_]*$/`).
 *
 *   - `description` — shown verbatim to the user inside the
 *     missing-credential card. Keep it short and concrete.
 *
 *   - `getKeyUrl` — deep-link to the provider's token-creation
 *     page. Renders as the "Get one ↗" affordance on the card.
 *
 *   - `authType` — drives the form (api-key vs OAuth button)
 *     AND the injector (env var vs Authorization header).
 *
 *   - `isRequired` — when false, the run continues with a sentinel
 *     and the tool's handler decides how to fall back. Default
 *     true.
 *
 *   - `category` / `forConnector` — populated when the card-driven
 *     `POST /credentials` creates a fresh row, so the new
 *     credential lands tagged with its origin.
 */

export type CredentialDescriptorAuthType =
  | 'api-key'
  | 'oauth2'
  | 'bearer-token'
  | 'basic'

export type CredentialDescriptorCategory =
  | 'llm'
  | 'tool'
  | 'oauth'
  | 'mcp-server'

export interface CredentialDescriptor {
  readonly name: string
  readonly description: string
  readonly getKeyUrl?: string
  readonly authType: CredentialDescriptorAuthType
  readonly isRequired?: boolean
  readonly category?: CredentialDescriptorCategory
  readonly forConnector?: string
  readonly placeholder?: string
}
