/**
 * Credential Isolation Types
 *
 * Shared type vocabulary for the credential-isolation primitives. Lives in
 * its own module because it is referenced from BOTH `tools/types.ts` (the
 * `ToolContext` callbacks a tool uses to request/resolve credentials) and
 * `core/events.ts` (the wire events the loop yields around a HITL credential
 * request). Keeping them here avoids a `tools ↔ events` import cycle.
 *
 * The whole point of this system is that the LLM never sees raw secret
 * values. Every type here is deliberately shaped so a value string cannot
 * flow into an event, a ToolResult, or a message. The ONE type that does
 * carry a value (`CredentialValue`) is consumed only by the shell output
 * redactor and is explicitly documented as never leaving tool internals.
 */

// ---------------------------------------------------------------------------
// Placement — how a credential will be injected when used
// ---------------------------------------------------------------------------

/**
 * Describes WHERE a credential will be injected at use time.
 *
 * Today the runtime actively honours only `env` (shell subprocess env
 * auto-injection). The other variants are declared so tools/UIs can
 * record intent — e.g. a future web_fetch tool can ask for a bearer
 * token and the UI can label the request correctly. They must not be
 * removed when only `env` is wired; silently dropping them would
 * ratchet the public API.
 */
export type CredentialPlacement =
  | { readonly type: 'env'; readonly variableName: string }
  | { readonly type: 'bearer' }
  | { readonly type: 'header'; readonly name: string }
  | { readonly type: 'cookie'; readonly name: string }
  | { readonly type: 'body'; readonly fieldPath: string }
  | { readonly type: 'query'; readonly paramName: string }
  | { readonly type: 'basic'; readonly usernameCredentialId?: string }

// ---------------------------------------------------------------------------
// Request / handle — what flows between tool and HITL
// ---------------------------------------------------------------------------

/**
 * Metadata a tool supplies when it needs the user to provide a secret.
 *
 * Critically, this object carries NO value — only the labels, hint, and
 * placement the UI needs to ask the user. The value is entered by the
 * user out-of-band (the gateway endpoint) and is stored in the vault by
 * the HITL implementation. The tool receives back only a `CredentialHandle`.
 */
export interface CredentialRequest {
  /** Short name the user sees (e.g. "Admin JWT", "Database URL"). */
  readonly label: string
  /** Where the user can find this value (e.g. "DevTools > localStorage > token"). */
  readonly hint: string
  /** What the agent will use it for (e.g. "Auth the /api/admin requests"). */
  readonly usage: string
  /** How the credential will be surfaced at use time. */
  readonly placement: CredentialPlacement
  /** True when the tool cannot proceed without the value. */
  readonly isRequired: boolean
}

/**
 * What the tool receives after a successful credential request. The
 * `credentialId` is the only thing a tool needs to later call
 * `ToolContext.resolveCredential` — which returns the actual secret
 * string, but only inside executor code.
 */
export interface CredentialHandle {
  readonly credentialId: string
  readonly label: string
  readonly placement: CredentialPlacement
  /** Epoch ms — useful for expiry/staleness heuristics if any. */
  readonly storedAt: number
}

// ---------------------------------------------------------------------------
// Injection + redaction manifests — what the loop gives to tools
// ---------------------------------------------------------------------------

/**
 * An env-placed credential the shell should inject into every subprocess.
 * Only the id + var name — never the value. Call `resolveCredential(id)`
 * to retrieve the value at spawn time.
 */
export interface EnvCredentialEntry {
  readonly credentialId: string
  readonly variableName: string
}

/**
 * Raw credential material — used ONLY by the shell output redactor to
 * replace secret values in captured stdout/stderr before the output
 * reaches the LLM. Implementations MUST NOT return this shape to the
 * model, place it in a ToolResult, or emit it in any event.
 */
export interface CredentialValue {
  readonly credentialId: string
  readonly value: string
  readonly label: string
}
