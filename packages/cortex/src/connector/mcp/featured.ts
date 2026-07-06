/**
 * MCP Featured Servers — Curated Tier 1 (Production Catalog)
 *
 * This file is the source of truth for what surfaces in `/tools` as a
 * featured connector card to a non-tech user. Every entry here MUST:
 *
 *   - Be a real, user-facing application (no developer primitives).
 *   - Use an OFFICIAL MCP server: vendor-shipped (e.g.
 *     `@notionhq/notion-mcp-server`) or Anthropic-shipped
 *     (`@modelcontextprotocol/server-*`). No community-maintained MCPs.
 *   - Have a published, working install path on npm or pypi.
 *   - Be reachable via OAuth where the provider supports it (Phase 4
 *     will wire real PKCE flows and remove the legacy paste-token env
 *     vars currently in `requiredEnv`).
 *
 * Curation: 2026-05-06 — culled from 45 entries to 12 Tier 1 apps.
 *
 * ── Tier 1 still to add (build first-party MCP shims, one phase at a
 *    time, do NOT add placeholder entries until the shim ships) ─────
 *
 *   Productivity:   Asana, Trello, Todoist
 *   Communication:  Discord
 *   Dev tools:      Vercel, Cloudflare (re-add as http_remote
 *                   `https://mcp.cloudflare.com`)
 *   Storage:        Dropbox
 *   Design:         Canva
 *   CRM:            Intercom
 *
 * ── Power users / developer primitives ─────────────────────────────
 *
 * Filesystem, Shell, Time, Memory, Sequential Thinking, Postgres,
 * MongoDB, Supabase, Sentry, Datadog, AWS, Docker, Brave/Tavily/Exa
 * search, Puppeteer, Fetch, Twitter/X, LinkedIn, Reddit, niche
 * trading/finance — all relegated to the Advanced → "Add custom MCP"
 * surface. Power users who want them can paste the install command;
 * non-tech users never see them.
 */

import type { MCPEnvVar } from '../types.js'

// ---------------------------------------------------------------------------
// Transport — discriminated union (the unified spawn/connect contract)
// ---------------------------------------------------------------------------

/**
 * How Cortex connects to this MCP server.
 *
 * - `stdio`       — Cortex spawns a local process (npx/uvx) speaking MCP
 *                   over stdio. Vast majority of curated servers.
 * - `http_remote` — Cortex talks to a remote MCP server over HTTP/SSE
 *                   (e.g. `mcp.notion.com`). No process spawned.
 * - `http_bridge` — A local app (Paper, Pencil, Figma desktop) hosts an
 *                   MCP server on 127.0.0.1 and announces itself via a
 *                   bridge JSON file under `~/.ownware/bridges/`.
 */
export type FeaturedTransport =
  | {
      readonly kind: 'stdio'
      readonly runtime: 'npx' | 'uvx'
      readonly package: string
      readonly args?: readonly string[]
    }
  | {
      readonly kind: 'http_remote'
      readonly url: string
    }
  | {
      readonly kind: 'http_bridge'
      /** Bridge identifier — basename of `~/.ownware/bridges/<id>.json`. */
      readonly bridgeId: string
    }

// ---------------------------------------------------------------------------
// Featured entry type
// ---------------------------------------------------------------------------

export interface FeaturedMCPServer {
  /** Unique ID (matches registry name where possible) */
  readonly id: string
  /** Display name */
  readonly title: string
  /** Short description */
  readonly description: string
  /** Category for grouping */
  readonly category: FeaturedCategory
  /** Transport contract — the unified spawn/connect shape. */
  readonly transport: FeaturedTransport
  /** Required environment variables */
  readonly requiredEnv: readonly MCPEnvVar[]
  /** GitHub repo URL (for avatar + docs link) */
  readonly repository: string
  /** Icon URL (direct or GitHub avatar) */
  readonly icon: string
  /**
   * Authentication / setup type:
   * - `none`          — works immediately, no setup ever
   * - `api-key`       — paste credentials in a form
   * - `oauth2`        — browser-based vendor consent (Phase 4 wires
   *                     real PKCE; today a few entries marked oauth2
   *                     still require a paste-token in `requiredEnv`
   *                     until the OAuth flow lands).
   * - `runtime-setup` — one-time non-credential setup at Connect time
   *                     (e.g. browser login, plugin install, file edit).
   *                     `setupHint` is REQUIRED. `setupCommand` is the
   *                     thing Cortex spawns (or `null` for manual setup).
   */
  readonly authType: 'none' | 'api-key' | 'oauth2' | 'runtime-setup'
  /**
   * One-line hint shown to the user when authType is `runtime-setup`.
   * Required at runtime when authType is `runtime-setup` (validated in
   * registry). Ignored for other authTypes.
   */
  readonly setupHint?: string
  /**
   * Command Cortex spawns at Connect time when authType is
   * `runtime-setup`. `null` = no command, user does setup manually.
   * Ignored for other authTypes.
   */
  readonly setupCommand?: readonly string[] | null
  /**
   * Two short, non-tech, action-oriented prompts surfaced on the
   * unified ConnectDialog's success card after this connector is
   * connected (e.g. "summarize my unread emails this week"). Curated
   * per Tier 1 entry; absent on dynamic bridges and uncurated
   * entries.
   *
   * Added 2026-05-06 (Phase 4-revised-A, Chunk 3.a). Surfaces through
   * `Connector.suggestedPrompts` via the registry serializer.
   */
  readonly suggestedPrompts?: readonly string[]
  /**
   * When `true`, this entry is omitted from the catalog returned by
   * `getFeaturedServers()` and `getFeaturedServer(id)`. The raw
   * `FEATURED_SERVERS` export still contains it so validators
   * (`known-apps.ts`) can resolve the id, and the entry can be
   * un-hidden in one line when its blocking work ships.
   *
   * Use for entries whose only working path is OAuth (vendor-hosted
   * `http_remote` MCPs) until the PKCE redirect lands — surfacing
   * them today would only produce a connect-and-fail experience.
   */
  readonly hidden?: boolean
}

export type FeaturedCategory =
  | 'dev-tools'
  | 'data'
  | 'communication'
  | 'browser'
  | 'productivity'
  | 'ai'
  | 'finance'
  | 'research'
  | 'social'
  | 'design'
  | 'media'
  | 'security'

// ---------------------------------------------------------------------------
// The curated list — 14 Tier 1 entries
// ---------------------------------------------------------------------------

export const FEATURED_SERVERS: readonly FeaturedMCPServer[] = [

  // ── Productivity ─────────────────────────────────────────────────────

  {
    id: 'notion',
    title: 'Notion',
    description: 'Pages, databases, search, content management',
    category: 'communication',
    transport: {
      kind: 'stdio',
      runtime: 'npx',
      package: '@notionhq/notion-mcp-server',
    },
    // Phase 4: replace OPENAPI_MCP_HEADERS paste-token with real PKCE
    // OAuth via Notion's developer integration.
    // Until then, user pastes an integration token.
    requiredEnv: [
      {
        name: 'OPENAPI_MCP_HEADERS',
        description:
          'Notion → click your integration → Configuration tab → "Installation access token" (starts with `secret_` or `ntn_`).',
        isRequired: true,
        isSecret: true,
        transform: 'notion-headers',
        helpUrl: 'https://www.notion.so/my-integrations',
      },
    ],
    repository: 'https://github.com/makenotion/notion-mcp-server',
    icon: 'https://avatars.githubusercontent.com/makenotion',
    authType: 'oauth2',
    suggestedPrompts: [
      'Summarize my recent meeting notes',
      'Find pages tagged 2026 launch',
    ],
  },
  {
    id: 'linear',
    title: 'Linear',
    description: 'Issues, projects, cycles, teams — full read/write access',
    category: 'productivity',
    transport: {
      kind: 'stdio',
      runtime: 'npx',
      package: 'linear-mcp-server',
    },
    // Linear has no personal-account OAuth — `api-key` (Personal API
    // key) is the correct path, NOT a Phase 4 OAuth conversion.
    requiredEnv: [
      { name: 'LINEAR_API_KEY', description: 'Linear personal API key (Settings → API → Personal API keys)', isRequired: true, isSecret: true, helpUrl: 'https://linear.app/settings/api' },
    ],
    repository: 'https://github.com/jerhadf/linear-mcp-server',
    icon: 'https://github.com/linear.png',
    authType: 'api-key',
    suggestedPrompts: [
      'What issues are blocking me this week?',
      'Create a ticket for the API timeout bug',
    ],
  },
  {
    id: 'hubspot',
    title: 'HubSpot',
    description: 'Contacts, companies, deals, tickets, marketing — full CRM read/write',
    category: 'productivity',
    transport: {
      kind: 'stdio',
      runtime: 'npx',
      package: '@hubspot/mcp-server',
    },
    // HubSpot's recommended path for first-party integrations is a
    // Private App access token. NOT a Phase 4 OAuth conversion.
    requiredEnv: [
      { name: 'PRIVATE_APP_ACCESS_TOKEN', description: 'HubSpot Private App access token (Settings → Integrations → Private Apps → Create)', isRequired: true, isSecret: true, helpUrl: 'https://developers.hubspot.com/docs/api/private-apps' },
    ],
    repository: 'https://github.com/HubSpot/mcp-server',
    icon: 'https://github.com/HubSpot.png',
    authType: 'api-key',
    suggestedPrompts: [
      'Show me deals closing this month',
      'Find contacts at Acme Corp',
    ],
  },
  {
    id: 'jira',
    title: 'Jira',
    description: 'Issues, projects, sprints — read/write across Jira + Confluence + Compass',
    category: 'productivity',
    // Atlassian ships an OFFICIAL hosted MCP server (GA Feb 2026). No
    // local process — we call mcp.atlassian.com directly. OAuth is
    // built into the remote endpoint; same PKCE pattern as Figma.
    // One token covers Jira + Confluence + Compass.
    transport: {
      kind: 'http_remote',
      url: 'https://mcp.atlassian.com/v1/mcp',
    },
    requiredEnv: [],
    repository: 'https://github.com/atlassian/atlassian-mcp-server',
    icon: 'https://github.com/atlassian.png',
    authType: 'oauth2',
    suggestedPrompts: [
      'Show me my open Jira tickets',
      'Create a bug ticket in PROJECT-X for the login crash',
    ],
    // Hidden until Phase 4 PKCE OAuth lands — mcp.atlassian.com is
    // OAuth-only, no paste-token fallback.
    hidden: true,
  },

  // ── Communication ────────────────────────────────────────────────────

  {
    id: 'slack',
    title: 'Slack',
    description: 'Channels, messages, users, search across workspace',
    category: 'communication',
    transport: {
      kind: 'stdio',
      runtime: 'npx',
      package: '@modelcontextprotocol/server-slack',
    },
    // Phase 4: replace SLACK_BOT_TOKEN paste with real OAuth via the
    // tiny Cloudflare Worker (Slack requires a client secret).
    requiredEnv: [
      { name: 'SLACK_BOT_TOKEN', description: 'Slack Bot User OAuth Token (xoxb-...)', isRequired: true, isSecret: true, helpUrl: 'https://api.slack.com/apps' },
      { name: 'SLACK_TEAM_ID', description: 'Slack workspace/team ID', isRequired: true, isSecret: false, helpUrl: 'https://api.slack.com/apps' },
    ],
    repository: 'https://github.com/modelcontextprotocol/servers',
    icon: 'https://avatars.githubusercontent.com/slackapi',
    authType: 'oauth2',
    suggestedPrompts: [
      'Summarize today\'s #general channel',
      'Find messages mentioning the launch this week',
    ],
  },
  {
    id: 'gmail',
    title: 'Gmail',
    description: 'Read your inbox, draft replies, send outreach, organize labels and threads',
    category: 'productivity',
    transport: {
      kind: 'stdio',
      runtime: 'npx',
      package: 'gmail-mcp',
    },
    // Phase 4: replace GOOGLE_ACCESS_TOKEN paste with real OAuth via
    // the Cloudflare Worker (Google requires a client secret). One
    // Google OAuth flow can supply tokens for Gmail + Drive + Sheets +
    // Calendar — Phase 4 should consolidate the four into one
    // "Connect Google" UX with scope picking.
    requiredEnv: [
      { name: 'GOOGLE_ACCESS_TOKEN', description: 'Google OAuth access token with Gmail scopes', isRequired: true, isSecret: true, helpUrl: 'https://developers.google.com/oauthplayground/' },
    ],
    repository: 'https://github.com/domdomegg/gmail-mcp',
    icon: 'https://avatars.githubusercontent.com/googleworkspace',
    authType: 'oauth2',
    suggestedPrompts: [
      'Summarize my unread emails this week',
      'Draft a reply to the latest thread from Sarah',
    ],
  },
  {
    id: 'google-calendar',
    title: 'Google Calendar',
    description: 'List events, create meetings, check availability, manage invites',
    category: 'productivity',
    transport: {
      kind: 'stdio',
      runtime: 'npx',
      package: '@cocal/google-calendar-mcp',
    },
    // Phase 4: same Google OAuth consolidation as Gmail above.
    requiredEnv: [
      { name: 'GOOGLE_ACCESS_TOKEN', description: 'Google OAuth access token with Calendar scopes', isRequired: true, isSecret: true, helpUrl: 'https://developers.google.com/oauthplayground/' },
    ],
    repository: 'https://github.com/cocal/google-calendar-mcp',
    icon: 'https://github.com/googleworkspace.png',
    authType: 'oauth2',
    suggestedPrompts: [
      'What\'s on my calendar tomorrow?',
      'Find a 30-minute slot with Alex this week',
    ],
  },
  {
    id: 'microsoft-365',
    title: 'Microsoft 365',
    description: 'Outlook mail + calendar, OneDrive, Teams, SharePoint — one token, all services',
    category: 'productivity',
    transport: {
      kind: 'stdio',
      runtime: 'npx',
      package: '@softeria/ms-365-mcp-server',
    },
    // Phase 4: replace MS365_ACCESS_TOKEN paste with real OAuth via
    // the Cloudflare Worker (Microsoft requires a client secret for
    // confidential apps). Covers Outlook + Teams + OneDrive + Sharepoint
    // under a single Connect flow.
    requiredEnv: [
      { name: 'MS365_ACCESS_TOKEN', description: 'Microsoft Graph OAuth access token. Generate via the Graph Explorer (Sign in → copy token from the Access token tab) or your own Entra ID app.', isRequired: true, isSecret: true, helpUrl: 'https://developer.microsoft.com/en-us/graph/graph-explorer' },
    ],
    repository: 'https://github.com/softeria/ms-365-mcp-server',
    icon: 'https://github.com/microsoft.png',
    authType: 'oauth2',
    suggestedPrompts: [
      'Summarize my Outlook inbox',
      'Show me my Teams mentions today',
    ],
  },

  // ── Dev Tools ─────────────────────────────────────────────────────────

  {
    id: 'github',
    title: 'GitHub',
    description: 'Repos, issues, PRs, code search, file contents',
    category: 'dev-tools',
    transport: {
      kind: 'stdio',
      runtime: 'npx',
      package: '@modelcontextprotocol/server-github',
    },
    // Phase 4: replace GITHUB_PERSONAL_ACCESS_TOKEN paste with real
    // PKCE OAuth — GitHub supports PKCE, no Worker needed.
    requiredEnv: [
      { name: 'GITHUB_PERSONAL_ACCESS_TOKEN', description: 'GitHub personal access token (classic or fine-grained)', isRequired: true, isSecret: true, helpUrl: 'https://github.com/settings/tokens' },
    ],
    repository: 'https://github.com/modelcontextprotocol/servers',
    icon: 'https://avatars.githubusercontent.com/github',
    authType: 'oauth2',
    suggestedPrompts: [
      'Show open PRs across my repos',
      'Find issues tagged help wanted',
    ],
  },
  {
    id: 'gitlab',
    title: 'GitLab',
    description: 'Projects, issues, merge requests, pipelines',
    category: 'dev-tools',
    transport: {
      kind: 'stdio',
      runtime: 'npx',
      package: '@modelcontextprotocol/server-gitlab',
    },
    // Phase 4: replace GITLAB_PERSONAL_ACCESS_TOKEN paste with real
    // PKCE OAuth — GitLab supports PKCE.
    requiredEnv: [
      { name: 'GITLAB_PERSONAL_ACCESS_TOKEN', description: 'GitLab personal access token', isRequired: true, isSecret: true, helpUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens' },
      { name: 'GITLAB_API_URL', description: 'GitLab API URL (default: https://gitlab.com/api/v4)', isRequired: false, isSecret: false },
    ],
    repository: 'https://github.com/modelcontextprotocol/servers',
    // GitHub org is `gitlab-org` (the real GitLab GitHub org).
    // `gitlab-com` returned 404 and rendered the letter-tile fallback.
    icon: 'https://github.com/gitlab-org.png',
    authType: 'oauth2',
    suggestedPrompts: [
      'List merge requests waiting for me',
      'Show CI status on the main branch',
    ],
  },
  {
    id: 'stripe',
    title: 'Stripe',
    description: 'Payments, customers, invoices, subscriptions',
    category: 'finance',
    transport: {
      kind: 'stdio',
      runtime: 'npx',
      package: '@stripe/mcp',
      args: ['--api-key=${STRIPE_SECRET_KEY}'],
    },
    // Stripe Restricted API Keys are the official path for first-party
    // integrations. NOT a Phase 4 OAuth conversion. The `--api-key=`
    // CLI flag is a stdio→hosted-HTTP proxy auth — see @stripe/mcp.
    requiredEnv: [
      { name: 'STRIPE_SECRET_KEY', description: 'Stripe API key — prefer a Restricted API key (rk_...)', isRequired: true, isSecret: true, helpUrl: 'https://dashboard.stripe.com/apikeys' },
    ],
    repository: 'https://github.com/stripe/agent-toolkit',
    icon: 'https://github.com/stripe.png',
    authType: 'api-key',
    suggestedPrompts: [
      'Show payments from the last 7 days',
      'Find customers with failed subscriptions',
    ],
  },

  // ── Analytics ────────────────────────────────────────────────────────

  {
    id: 'mixpanel',
    title: 'Mixpanel',
    description: 'Query events, funnels, retention, and session replays in plain English',
    // Closest existing FeaturedCategory bucket — analytics is not in the
    // enum yet. Revisit if Datadog / Sentry / Amplitude get added; at that
    // point promote to a dedicated 'analytics' or 'observability' category.
    category: 'data',
    // Mixpanel ships an OFFICIAL hosted MCP server. Default to US;
    // EU/IN regional variants exist (mcp-eu.mixpanel.com, mcp-in.).
    // Org admin must enable MCP server-side in Settings → Org →
    // Overview before users can connect. OAuth 2.0 + PKCE; rate limit
    // 600 requests/hour/user.
    transport: {
      kind: 'http_remote',
      url: 'https://mcp.mixpanel.com/mcp',
    },
    requiredEnv: [],
    repository: 'https://docs.mixpanel.com/docs/mcp',
    icon: 'https://github.com/mixpanel.png',
    authType: 'oauth2',
    suggestedPrompts: [
      'Show daily active users for the last 7 days',
      'Run a funnel from signup to first purchase',
    ],
    // Hidden until Phase 4 PKCE OAuth lands — mcp.mixpanel.com is
    // OAuth-only, no paste-token fallback.
    hidden: true,
  },

  // ── Design ───────────────────────────────────────────────────────────

  {
    id: 'figma',
    title: 'Figma',
    description: 'Files, frames, components, comments — read your designs and export assets',
    category: 'design',
    // Figma ships an OFFICIAL hosted MCP server. No local process — we
    // call mcp.figma.com directly. OAuth handshake is built into the
    // remote endpoint; Phase 4 wires the PKCE redirect via the
    // existing oauth-loopback capability.
    transport: {
      kind: 'http_remote',
      url: 'https://mcp.figma.com/mcp',
    },
    requiredEnv: [],
    repository: 'https://www.figma.com/developers/mcp',
    icon: 'https://github.com/figma.png',
    authType: 'oauth2',
    suggestedPrompts: [
      'List components in my design system file',
      'Find frames I edited this week',
    ],
    // Hidden until Phase 4 PKCE OAuth lands — mcp.figma.com is
    // OAuth-only, no paste-token fallback.
    hidden: true,
  },

  // ── Storage (under productivity category for filtering — UI groups by display) ──

  {
    id: 'google-drive',
    title: 'Google Drive',
    description: 'Read files, upload PDFs, save reports and exports to your Drive',
    category: 'productivity',
    transport: {
      kind: 'stdio',
      runtime: 'npx',
      package: 'google-drive-mcp',
    },
    // Phase 4: same Google OAuth consolidation as Gmail/Calendar above.
    requiredEnv: [
      { name: 'GOOGLE_ACCESS_TOKEN', description: 'Google OAuth access token with Drive scopes', isRequired: true, isSecret: true, helpUrl: 'https://developers.google.com/oauthplayground/' },
    ],
    repository: 'https://github.com/domdomegg/google-drive-mcp',
    icon: 'https://avatars.githubusercontent.com/googleworkspace',
    authType: 'oauth2',
    suggestedPrompts: [
      'Find documents I edited this month',
      'Share the Q3 plan with Sam',
    ],
  },
  {
    id: 'google-sheets',
    title: 'Google Sheets',
    description: 'Read and write spreadsheets — lead lists, content trackers, post performance',
    category: 'productivity',
    transport: {
      kind: 'stdio',
      runtime: 'npx',
      package: 'google-sheets-mcp',
    },
    // Phase 4: same Google OAuth consolidation. Promoted to Tier 1 on
    // 2026-05-06 — high-utility for marketing/ops users; uses the same
    // Google OAuth flow as Gmail/Calendar/Drive (zero extra cost).
    requiredEnv: [
      { name: 'GOOGLE_ACCESS_TOKEN', description: 'Google OAuth access token with Sheets scopes', isRequired: true, isSecret: true, helpUrl: 'https://developers.google.com/oauthplayground/' },
    ],
    repository: 'https://github.com/domdomegg/google-sheets-mcp',
    icon: 'https://avatars.githubusercontent.com/googleworkspace',
    authType: 'oauth2',
    suggestedPrompts: [
      'Summarize the content tracker sheet',
      'Find rows where status is overdue',
    ],
  },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * In-memory cache of dynamic bridge entries (populated by the bridge
 * catalog reader). Empty until the gateway calls `setBridgeCache(entries)`
 * — typically at boot, then on every `~/.ownware/bridges/` filesystem
 * event. Tests don't need to populate this; static entries surface the
 * same way they always have.
 */
let _bridgeCache: readonly FeaturedMCPServer[] = []

/**
 * Replace the cached bridge entries. The gateway invokes this from the
 * bridge-catalog reader; nothing else should call it directly.
 */
export function setBridgeCache(entries: readonly FeaturedMCPServer[]): void {
  _bridgeCache = entries
}

/**
 * Read-only view of the current bridge cache. Mostly useful for tests.
 */
export function getBridgeCache(): readonly FeaturedMCPServer[] {
  return _bridgeCache
}

function allEntries(): readonly FeaturedMCPServer[] {
  // Hidden entries are excluded from the public catalog but stay in
  // `FEATURED_SERVERS` for validator lookups (see `hidden` doc).
  const visible = FEATURED_SERVERS.filter(s => !s.hidden)
  if (_bridgeCache.length === 0) return visible
  // Static wins on id collision — a static featured entry should never
  // be shadowed by a dynamic bridge with the same id.
  const staticIds = new Set(FEATURED_SERVERS.map(s => s.id))
  const merged: FeaturedMCPServer[] = [...visible]
  for (const b of _bridgeCache) {
    if (!staticIds.has(b.id)) merged.push(b)
  }
  return merged
}

/**
 * Get featured servers, optionally filtered by category. Includes any
 * dynamic bridge entries currently in the in-memory cache.
 */
export function getFeaturedServers(category?: FeaturedCategory): readonly FeaturedMCPServer[] {
  const all = allEntries()
  if (!category) return all
  return all.filter(s => s.category === category)
}

/**
 * Get a single featured server by ID. Includes dynamic bridge entries.
 */
export function getFeaturedServer(id: string): FeaturedMCPServer | undefined {
  return allEntries().find(s => s.id === id)
}

/**
 * Get all featured categories with counts. Includes dynamic bridge entries.
 */
export function getFeaturedCategories(): Array<{ category: FeaturedCategory; count: number }> {
  const counts = new Map<FeaturedCategory, number>()
  for (const s of allEntries()) {
    counts.set(s.category, (counts.get(s.category) ?? 0) + 1)
  }
  return [...counts.entries()].map(([category, count]) => ({ category, count }))
}
