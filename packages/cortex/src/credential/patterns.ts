/**
 * Credential classification patterns (Cortex entry point).
 *
 * The canonical lists live in `@ownware/loom` (the shell output
 * redactor uses them; we reuse the same definitions so .env import and
 * shell redaction agree on what counts as a secret). This module is the
 * Cortex-side import site plus a couple of conveniences keyed to how
 * Cortex consumes the classifier — chief among them:
 *
 *   `classifyImportedDotenvKey` — the rule used by the .env auto-import
 *   path. Treats UNKNOWN keys as sensitive (secure-default). That policy
 *   lives here (not in Loom) because it's a consumer choice: the shell
 *   redactor has its own fallback posture, which is "redact when a KEY
 *   is obviously sensitive, pass through otherwise". A .env auto-import
 *   must err the other direction — do not leak a user's FOO_BAR_BAZ into
 *   the system prompt unless we can prove it isn't secret.
 */

export {
  SENSITIVE_KEY_PATTERNS,
  SAFE_KEY_PATTERNS,
  classifyEnvKey,
  isSensitiveEnvKey,
  BLOCKED_FILE_PATTERNS,
  BLOCKED_FILE_GLOBS,
  isBlockedFilePath,
  filterBlockedPaths,
  BLOCKED_FILE_ERROR_MESSAGE,
} from '@ownware/loom'

import { classifyEnvKey, type EnvKeyClassification } from '@ownware/loom'
export type { EnvKeyClassification } from '@ownware/loom'

/**
 * Classification used specifically by .env auto-import. Collapses the
 * three-way `classifyEnvKey` into a boolean "should the value be stored
 * in the vault?" under the secure-default rule.
 *
 * Rationale: the system-prompt injector sees every non-sensitive key as
 * plaintext config. Leaking an unknown-but-actually-secret key there
 * would bypass the whole isolation story. When in doubt, vault it.
 */
export function classifyImportedDotenvKey(
  key: string,
): 'sensitive' | 'config' {
  const verdict: EnvKeyClassification = classifyEnvKey(key)
  return verdict === 'safe' ? 'config' : 'sensitive'
}
