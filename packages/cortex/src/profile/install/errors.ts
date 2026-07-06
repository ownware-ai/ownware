/**
 * Profile Install Errors
 *
 * Discriminated union of every failure mode the install pipeline can hit.
 * Each error carries enough structured detail for the gateway to format a
 * user-facing message AND for tests to assert on the failure shape without
 * matching against a string.
 *
 * Throwing path: every install entry point throws an `InstallError` instance.
 * The gateway handler catches and renders. Internal helpers may either throw
 * or return a result type — both wrap the same union.
 */

export type InstallErrorCode =
  | 'invalid_url'
  | 'clone_failed'
  | 'oversized'
  | 'forbidden_custom_code'
  | 'path_escape'
  | 'invalid_manifest'
  | 'name_collision'
  | 'network'
  | 'auth_required'
  | 'unsupported_helper'
  | 'manifest_not_found'
  | 'profile_load_failed'

export interface InstallErrorDetail {
  readonly invalid_url: { readonly url: string }
  readonly clone_failed: { readonly reason: string }
  readonly oversized: { readonly limitBytes: number; readonly observedBytes: number }
  readonly forbidden_custom_code: { readonly files: readonly string[] }
  readonly path_escape: { readonly files: readonly string[] }
  readonly invalid_manifest: { readonly issues: readonly string[] }
  readonly name_collision: { readonly existing: string }
  readonly network: { readonly reason: string }
  readonly auth_required: { readonly hint: string }
  readonly unsupported_helper: { readonly helper: string; readonly reason: string }
  readonly manifest_not_found: { readonly path: string }
  readonly profile_load_failed: { readonly profile: string; readonly reason: string }
}

/**
 * Thrown from every install entry point.
 *
 * `code` discriminates the failure; `detail` carries structured fields the
 * gateway/UI consumes. `message` is a developer-facing summary — never use it
 * to drive UI logic.
 */
export class InstallError<C extends InstallErrorCode = InstallErrorCode> extends Error {
  readonly code: C
  readonly detail: InstallErrorDetail[C]

  constructor(code: C, detail: InstallErrorDetail[C], message?: string) {
    super(message ?? defaultMessage(code, detail))
    this.name = 'InstallError'
    this.code = code
    this.detail = detail
  }
}

function defaultMessage<C extends InstallErrorCode>(
  code: C,
  detail: InstallErrorDetail[C],
): string {
  switch (code) {
    case 'invalid_url':
      return `Invalid GitHub URL: ${(detail as InstallErrorDetail['invalid_url']).url}`
    case 'clone_failed':
      return `git clone failed: ${(detail as InstallErrorDetail['clone_failed']).reason}`
    case 'oversized': {
      const d = detail as InstallErrorDetail['oversized']
      return `Repository exceeds size limit (${d.observedBytes} > ${d.limitBytes} bytes)`
    }
    case 'forbidden_custom_code': {
      const d = detail as InstallErrorDetail['forbidden_custom_code']
      return `Profile contains executable code (not allowed for installed profiles): ${d.files.join(', ')}`
    }
    case 'path_escape': {
      const d = detail as InstallErrorDetail['path_escape']
      return `Profile references paths outside its directory: ${d.files.join(', ')}`
    }
    case 'invalid_manifest': {
      const d = detail as InstallErrorDetail['invalid_manifest']
      return `Manifest validation failed:\n${d.issues.map((i) => `  - ${i}`).join('\n')}`
    }
    case 'name_collision':
      return `A profile with this name is already installed: ${(detail as InstallErrorDetail['name_collision']).existing}`
    case 'network':
      return `Network error: ${(detail as InstallErrorDetail['network']).reason}`
    case 'auth_required':
      return `Authentication required: ${(detail as InstallErrorDetail['auth_required']).hint}`
    case 'unsupported_helper': {
      const d = detail as InstallErrorDetail['unsupported_helper']
      return `Helper '${d.helper}' is unsupported: ${d.reason}`
    }
    case 'manifest_not_found':
      return `Manifest file not found at ${(detail as InstallErrorDetail['manifest_not_found']).path}`
    case 'profile_load_failed': {
      const d = detail as InstallErrorDetail['profile_load_failed']
      return `Profile '${d.profile}' failed to load: ${d.reason}`
    }
    default: {
      const exhaustive: never = code
      return `Install error: ${String(exhaustive)}`
    }
  }
}

/** Type guard for catching InstallErrors specifically. */
export function isInstallError(err: unknown): err is InstallError {
  return err instanceof InstallError
}
