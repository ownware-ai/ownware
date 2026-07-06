/**
 * OAuth Presets — Per-provider reference data for the BYO OAuth flow
 *
 * Pivoted 2026-05-06: this file used to be intended as a registry
 * of company-managed centralized OAuth client IDs. It is NOT that
 * anymore. Under the BYO model, Ownware
 * ships zero centralized OAuth apps.
 *
 * What this file IS now:
 *   - Reference data the BYO Mode A wizard uses to tell each user
 *     where to register THEIR OWN OAuth app and what scopes/URLs
 *     to enter.
 *   - Vendor-stable info: authorization_url, token_url, default
 *     scopes, env var the MCP server reads, optional token
 *     transform.
 *
 * What `clientId` MEANS in this file:
 *   - ALWAYS empty string ('') in the binary.
 *   - The actual per-user clientId is supplied at OAuth start time
 *     via the request body of `POST /api/v1/mcp/oauth/start/:id`,
 *     and is persisted to the user's local CredentialVault keyed
 *     as `<serverId>__oauth_client`.
 *   - The gateway resolves: per-request body > user's stored value
 *     > preset's empty string (fail loudly with "no clientId
 *     configured — please set up OAuth in Settings").
 *
 * If a future product decision ever reverts to centralized,
 * filling in `clientId` here is the single-line mechanism — but
 * that decision is OFF the table per the BYO architecture.
 */

import type { OAuthPreset } from '@ownware/loom'

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * Per-provider OAuth reference data — clientId is intentionally
 * empty. The BYO Mode A wizard reads `authorizationUrl`,
 * `tokenUrl`, `scopes` to tell each user what to register with
 * their own vendor account. The user's clientId comes in via the
 * Connect request body and is stored in their local vault.
 *
 * Loopback redirect URI to instruct users to register:
 *   http://127.0.0.1/callback
 * (Per RFC 8252, providers SHOULD accept any port on 127.0.0.1.
 * The few that don't — see per-entry comments.)
 */
export const OAUTH_PRESETS: Record<string, OAuthPreset> = {
  github: {
    serverId: 'github',
    name: 'GitHub',
    clientId: '', // BYO — user registers their own OAuth App; clientId
                  // arrives in the Connect request body. GitHub also
                  // supports a Personal Access Token via Mode B (paste
                  // a PAT directly) — Mode B is faster and is the
                  // default Connect path for GitHub.
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'read:org', 'read:user'],
    tokenToEnv: 'GITHUB_PERSONAL_ACCESS_TOKEN',
    registerUrl: 'https://github.com/settings/developers',
  },
  slack: {
    serverId: 'slack',
    name: 'Slack',
    clientId: '', // User must create Slack App
    authorizationUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    scopes: ['channels:read', 'channels:history', 'chat:write', 'users:read'],
    tokenToEnv: 'SLACK_BOT_TOKEN',
    // Slack's oauth.v2.access rejects PKCE-only token swaps: the
    // exchange requires `client_secret`. Under BYO each user supplies
    // BOTH clientId AND clientSecret from their own Slack App. The
    // wizard reads this flag to render a second input field. Slack
    // is the only Tier 1 entry that needs it today.
    requiresSecret: true,
    registerUrl: 'https://api.slack.com/apps',
  },
  notion: {
    serverId: 'notion',
    name: 'Notion',
    clientId: '', // User must create Notion integration
    authorizationUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    scopes: [],
    tokenToEnv: 'OPENAPI_MCP_HEADERS',
    registerUrl: 'https://www.notion.so/my-integrations',
    // 2026-04-11 audit Hazard 22 fix.
    //
    // The Notion MCP server (`@notionhq/notion-mcp-server`) does NOT
    // read a bare access token from OPENAPI_MCP_HEADERS. It reads a
    // JSON-encoded headers object and uses it for every API request.
    // Storing the raw token there leaves the server unable to parse
    // the env var on startup.
    //
    // Notion currently pins API consumers to Notion-Version: 2022-06-28
    // — that's the version every official Notion SDK ships with as of
    // April 2026. Update here if Notion bumps the required version.
    tokenTransform: (tokens) => ({
      OPENAPI_MCP_HEADERS: JSON.stringify({
        Authorization: `Bearer ${tokens.accessToken}`,
        'Notion-Version': '2022-06-28',
      }),
    }),
  },
  gitlab: {
    serverId: 'gitlab',
    name: 'GitLab',
    clientId: '',
    authorizationUrl: 'https://gitlab.com/oauth/authorize',
    tokenUrl: 'https://gitlab.com/oauth/token',
    scopes: ['read_api', 'read_user', 'read_repository'],
    tokenToEnv: 'GITLAB_PERSONAL_ACCESS_TOKEN',
    registerUrl: 'https://gitlab.com/-/user_settings/applications',
  },

  // ── Google Workspace ────────────────────────────────────────────────
  //
  // BYO Mode A reference data (added 2026-05-06, repurposed
  // 2026-05-06 from centralized to BYO). Each USER registers their
  // OWN Google OAuth client (type: "Desktop app" — accepts loopback
  // redirects on any port per RFC 8252) and pastes the clientId via
  // the Mode A wizard. ONE Google client they register covers all
  // four entries below — the wizard recognizes Google as a unified
  // provider and stores the same clientId under all four keys.
  //
  // Least privilege: each connector requests ONLY the scope its own
  // tools need (2026-06-21). Each connector triggers its own OAuth grant
  // (the vault is keyed per-serverId), so connecting Gmail no longer grants
  // Calendar/Drive/Sheets access and vice-versa — a user who only connects
  // Calendar never hands an agent their mailbox. This narrows what Google's
  // restricted-scope review must justify and matches the per-connector
  // connect flow the user already performs.
  //
  // Trade-off: a future "one grant populates all four" optimization would
  // need Google incremental authorization (re-consent for each added scope)
  // rather than a pre-unioned grant. That optimization is unbuilt today, so
  // there is no behavior regression.

  gmail: {
    serverId: 'gmail',
    name: 'Gmail',
    clientId: '', // User's own Google Desktop OAuth client
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/gmail.modify',
    ],
    tokenToEnv: 'GOOGLE_ACCESS_TOKEN',
    registerUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  'google-calendar': {
    serverId: 'google-calendar',
    name: 'Google Calendar',
    clientId: '', // User's own Google Desktop OAuth client
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/calendar',
    ],
    tokenToEnv: 'GOOGLE_ACCESS_TOKEN',
    registerUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  'google-drive': {
    serverId: 'google-drive',
    name: 'Google Drive',
    clientId: '', // User's own Google Desktop OAuth client
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/drive',
    ],
    tokenToEnv: 'GOOGLE_ACCESS_TOKEN',
    registerUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  'google-sheets': {
    serverId: 'google-sheets',
    name: 'Google Sheets',
    clientId: '', // User's own Google Desktop OAuth client
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
    ],
    tokenToEnv: 'GOOGLE_ACCESS_TOKEN',
    registerUrl: 'https://console.cloud.google.com/apis/credentials',
  },

  // ── Microsoft 365 (covers Outlook, Teams, OneDrive, SharePoint) ─────
  //
  // BYO Mode A reference data (added 2026-05-06, repurposed
  // 2026-05-06 from centralized to BYO). Each USER registers their
  // OWN Entra ID app (Public client type, supports PKCE) and
  // pastes the clientId via the Mode A wizard. The `common` tenant
  // in the URLs lets both work and personal Microsoft accounts
  // authenticate.
  //
  // The MCP package `@softeria/ms-365-mcp-server` reads
  // `MS365_ACCESS_TOKEN` (bare token, no transform needed).

  'microsoft-365': {
    serverId: 'microsoft-365',
    name: 'Microsoft 365',
    clientId: '',
    authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: [
      'Mail.ReadWrite',
      'Mail.Send',
      'Calendars.ReadWrite',
      'Files.ReadWrite.All',
      'Team.ReadBasic.All',
      'Channel.ReadBasic.All',
      'ChannelMessage.Read.All',
      'ChannelMessage.Send',
      'Sites.ReadWrite.All',
      'User.Read',
      'offline_access',
    ],
    tokenToEnv: 'MS365_ACCESS_TOKEN',
    registerUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
  },

  // ── Figma ───────────────────────────────────────────────────────────
  //
  // INTENTIONALLY NOT YET ADDED (2026-05-06). Figma is the only
  // Tier 1 entry with `transport.kind === 'http_remote'` — the OAuth
  // token has to be injected as `Authorization: Bearer <token>` on
  // every HTTP call to mcp.figma.com, NOT passed as an env var to
  // a spawned process. The current `tokenToEnv` mechanism doesn't
  // cover this case.
  //
  // Two options for a future phase:
  //   (a) Add an http_remote-aware token injector to the MCP client
  //       layer in loom that consults the credential vault per call.
  //   (b) Use the MCP 2025-03-26 dynamic OAuth discovery path (the
  //       existing `discoverOAuthEndpoints` in loom) — Figma's
  //       hosted MCP server probably advertises its OAuth endpoints
  //       per RFC 9728. If so, no preset needed at all; the
  //       discovery flow handles registration + PKCE end-to-end.
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get an OAuth preset by server ID.
 * Returns undefined if no preset exists for this server.
 */
export function getOAuthPreset(serverId: string): OAuthPreset | undefined {
  return OAUTH_PRESETS[serverId]
}

/**
 * Check if a preset has a valid client_id configured.
 * Empty string means the user hasn't registered their OAuth app yet.
 */
export function isPresetConfigured(preset: OAuthPreset): boolean {
  return preset.clientId.length > 0
}
