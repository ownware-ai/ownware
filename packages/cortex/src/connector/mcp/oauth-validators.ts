/**
 * OAuth Client ID Validators
 *
 * Pre-flight validation for OAuth client_ids. Rejects obvious garbage
 * and common user mistakes (pasting tokens instead of client_ids)
 * before we bother starting the full OAuth flow.
 *
 * This is defense-in-depth — the OAuth provider is the final source
 * of truth, but catching mistakes here gives users a clearer error
 * message and avoids "opened browser, provider rejected, flow stuck"
 * cycles.
 */

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export interface ValidationResult {
  readonly valid: boolean
  readonly code?: ValidationErrorCode
  readonly message?: string
}

export type ValidationErrorCode =
  | 'empty'
  | 'token_prefix_rejected'
  | 'format_mismatch'
  | 'unknown_server'

// ---------------------------------------------------------------------------
// Token prefixes — reject these across all services
// ---------------------------------------------------------------------------

/**
 * Users commonly paste access tokens where a client_id is expected.
 * These prefixes are distinctive enough that we can safely reject them
 * with a helpful error message.
 */
const TOKEN_PREFIXES: Record<string, string> = {
  // GitHub access tokens (personal access token, OAuth access, app, etc.)
  'ghp_': 'GitHub personal access token',
  'gho_': 'GitHub OAuth access token',
  'ghs_': 'GitHub server-to-server token',
  'ghu_': 'GitHub user-to-server token',
  'github_pat_': 'GitHub fine-grained personal access token',

  // Notion
  'secret_': 'Notion internal integration secret',
  'ntn_': 'Notion token',

  // Slack
  'xoxb-': 'Slack bot token',
  'xoxp-': 'Slack user token',
  'xoxa-': 'Slack legacy token',
  'xoxr-': 'Slack refresh token',

  // GitLab
  'glpat-': 'GitLab personal access token',
  'glptt-': 'GitLab pipeline trigger token',

  // Stripe
  'sk_test_': 'Stripe test secret key',
  'sk_live_': 'Stripe live secret key',
  'rk_test_': 'Stripe test restricted key',
  'rk_live_': 'Stripe live restricted key',

  // OpenAI (sometimes pasted by mistake)
  'sk-': 'API secret key',
}

// ---------------------------------------------------------------------------
// Per-service format validators
// ---------------------------------------------------------------------------

/**
 * Positive format checks. Returns true if the string looks like a
 * valid client_id for the given service. We err on the loose side —
 * the provider is the final authority.
 */
const FORMAT_VALIDATORS: Record<string, (clientId: string) => boolean> = {
  github: (id) => {
    // GitHub OAuth App client IDs:
    //   Modern: "Ov23li" + 14 alphanumeric chars
    //   Legacy: 20 lowercase hex chars
    //   GitHub App client IDs: "Iv1." + 16 chars
    return /^Ov23li[a-zA-Z0-9]{14}$/.test(id)
      || /^[a-f0-9]{20}$/.test(id)
      || /^Iv1\.[a-zA-Z0-9]{16}$/.test(id)
  },

  gitlab: (id) => {
    // GitLab Application ID: 64 lowercase hex chars
    return /^[a-f0-9]{64}$/.test(id)
  },

  slack: (id) => {
    // Slack App Client ID: "NNNNNNNNNNNN.NNNNNNNNNNNN" (numeric with dot)
    return /^\d+\.\d+$/.test(id)
  },

  notion: (id) => {
    // Notion OAuth Client ID: UUID v4
    return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
  },

  figma: (id) => {
    // Figma Client ID: 32 alphanumeric chars
    return /^[a-zA-Z0-9]{32}$/.test(id)
  },

  linear: (id) => {
    // Linear Client ID: UUID-like
    return /^[a-f0-9]{8}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{12}$/i.test(id)
  },
}

// ---------------------------------------------------------------------------
// Main validator
// ---------------------------------------------------------------------------

/**
 * Validate a client_id before starting an OAuth flow.
 *
 * Checks (in order):
 *   1. Non-empty
 *   2. Not a known token prefix (user pasted the wrong thing)
 *   3. Matches the service-specific format
 *
 * If the service has no format validator registered, we only run
 * checks 1 and 2 — unknown services still benefit from token-prefix
 * rejection.
 */
export function validateClientId(serverId: string, clientId: string): ValidationResult {
  // Check 1: non-empty
  const trimmed = clientId.trim()
  if (trimmed.length === 0) {
    return {
      valid: false,
      code: 'empty',
      message: 'Client ID is empty.',
    }
  }

  // Check 2: known token prefix (helpful error)
  for (const [prefix, tokenType] of Object.entries(TOKEN_PREFIXES)) {
    if (trimmed.startsWith(prefix)) {
      return {
        valid: false,
        code: 'token_prefix_rejected',
        message: `That looks like a ${tokenType}, not an OAuth Client ID. ` +
          `You need to create an OAuth App (or equivalent) and use the Client ID from there. ` +
          `Tokens and Client IDs are different things.`,
      }
    }
  }

  // Check 3: service-specific format
  const validator = FORMAT_VALIDATORS[serverId]
  if (validator) {
    if (!validator(trimmed)) {
      return {
        valid: false,
        code: 'format_mismatch',
        message: `Client ID does not match the expected format for ${serverId}. ` +
          formatHint(serverId),
      }
    }
  }

  return { valid: true }
}

// ---------------------------------------------------------------------------
// Format hints (shown to users on format mismatch)
// ---------------------------------------------------------------------------

function formatHint(serverId: string): string {
  switch (serverId) {
    case 'github':
      return 'GitHub OAuth Client IDs look like "Ov23li…" (20 chars) or a 20-character hex string.'
    case 'gitlab':
      return 'GitLab Application IDs are 64 hex characters.'
    case 'slack':
      return 'Slack App Client IDs look like "1234567890.1234567890".'
    case 'notion':
      return 'Notion OAuth Client IDs are UUIDs (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx). ' +
        'Note: Internal integrations give you a SECRET, not a Client ID — ' +
        'you need a PUBLIC integration for OAuth.'
    case 'figma':
      return 'Figma Client IDs are 32 alphanumeric characters.'
    default:
      return 'Check the service\'s developer documentation for the expected format.'
  }
}
