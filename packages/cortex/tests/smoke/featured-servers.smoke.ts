/**
 * Smoke test: spawn each no-auth featured MCP server, initialize the
 * protocol, and list its tools. Not part of the normal suite — run manually:
 *
 *   bunx tsx tests/smoke/featured-servers.smoke.ts
 *
 * This is the "all 30 should be working" check from the user: we prove the
 * packages named in `featured.ts` actually exist on npm AND speak MCP AND
 * return a non-empty tool list. Api-key-only servers (brave, tavily, exa,
 * firecrawl, newsapi, linear, stripe, etc.) are skipped because they need
 * real credentials.
 */
import { MCPClient } from '@ownware/loom'
import type { MCPServerConfig } from '@ownware/loom'
import { FEATURED_SERVERS } from '../../src/connector/mcp/featured.js'
import { resolveEnvStringWithFallback } from '../../src/profile/env.js'
import { buildMCPClientConfig } from '../../src/connector/spawn.js'

interface Result {
  readonly id: string
  readonly ok: boolean
  readonly tools: number
  readonly message: string
  readonly skipped: boolean
}

/**
 * Servers that cannot be validated with dummy credentials. These speak MCP
 * but require a real setup to get past `initialize`. They're listed here
 * so the smoke test reports them honestly (SKIP) instead of counting them
 * as regressions.
 *
 * - `stripe`: @stripe/mcp is a stdio-to-hosted-HTTP proxy that forwards to
 *   mcp.stripe.com; a bogus api-key returns 401 from the upstream.
 * - `obsidian`: obsidian-mcp connects to a running Obsidian app via the
 *   Local REST API plugin; no app means no server.
 * - `interactive-brokers`: connects to a local TWS / IB Gateway session
 *   over the official IB API; no gateway means no handshake.
 */
const REQUIRES_REAL_SETUP = new Set<string>(['stripe', 'obsidian', 'interactive-brokers'])

async function runOne(
  id: string,
  config: MCPServerConfig,
  timeoutMs: number,
): Promise<Result> {
  const client = new MCPClient(config)
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs),
  )

  try {
    await Promise.race([client.connect(), deadline])
    const tools = await Promise.race([client.listTools(), deadline])
    const toolCount = Array.isArray(tools) ? tools.length : 0
    return { id, ok: toolCount > 0, tools: toolCount, message: 'ok', skipped: false }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    const msg = raw.length > 140 ? `${raw.slice(0, 140)}…` : raw
    return { id, ok: false, tools: 0, message: msg, skipped: false }
  } finally {
    await client.disconnect().catch(() => { /* best-effort */ })
  }
}

function buildConfig(
  server: (typeof FEATURED_SERVERS)[number],
  env: Record<string, string>,
): MCPServerConfig {
  const t = server.transport
  if (t.kind === 'http_bridge') {
    throw new Error(`Featured server "${server.id}" uses bridge transport — not testable via smoke`)
  }
  // Mirror the gateway handler: substitute ${VAR} templates in args
  // against the env bag. Required for postgres (positional arg) and
  // stripe (--api-key= flag).
  return buildMCPClientConfig({
    name: server.id,
    transport: t,
    env,
    transformArg: (a, i) => resolveEnvStringWithFallback(a, env, `${server.id}.args[${i}]`),
  })
}

async function main(): Promise<void> {
  // No-auth servers are tested real. Api-key / oauth2 servers are tested
  // with dummy credentials — we can't exercise the real APIs, but most
  // servers accept a bogus key at startup and only reject it when the
  // first tool is actually called. That still proves the package spawns
  // and speaks MCP, which is the "is it visible and installable" gate we
  // care about for the marketplace.
  const DUMMY_ENV: Record<string, string> = {
    BRAVE_API_KEY: 'dummy',
    TAVILY_API_KEY: 'dummy',
    EXA_API_KEY: 'dummy',
    FIRECRAWL_API_KEY: 'dummy',
    NEWSAPI_KEY: 'dummy',
    LINEAR_API_KEY: 'dummy',
    GITHUB_PERSONAL_ACCESS_TOKEN: 'dummy',
    GITLAB_PERSONAL_ACCESS_TOKEN: 'dummy',
    SLACK_BOT_TOKEN: 'xoxb-dummy',
    SLACK_TEAM_ID: 'T00000000',
    STRIPE_SECRET_KEY: 'sk_test_dummy',
    CLOUDFLARE_API_TOKEN: 'dummy',
    GOOGLE_MAPS_API_KEY: 'dummy',
    POSTGRES_CONNECTION_STRING: 'postgresql://dummy:dummy@localhost/dummy',
    MDB_MCP_CONNECTION_STRING: 'mongodb://dummy:27017/dummy',
    SUPABASE_ACCESS_TOKEN: 'dummy',
    NEON_API_KEY: 'dummy',
    OPENAPI_MCP_HEADERS: '{"Authorization":"Bearer dummy","Notion-Version":"2022-06-28"}',
    // Social-category dummies (board: growth-connectors-100pct).
    YOUTUBE_API_KEY: 'dummy',
    API_KEY: 'dummy',
    API_SECRET_KEY: 'dummy',
    ACCESS_TOKEN: 'dummy',
    ACCESS_TOKEN_SECRET: 'dummy',
    GOOGLE_ACCESS_TOKEN: 'dummy',
    // Finance-category dummies (board: trading-coach-2026-04-30).
    ALPACA_API_KEY: 'PKDUMMYKEYDUMMYKEYDUMM',
    ALPACA_SECRET_KEY: 'dummysecretdummysecretdummysecretdummysec',
    ALPACA_PAPER: 'true',
    BINANCE_API_KEY: 'dummy',
    BINANCE_API_SECRET: 'dummy',
    TUSHARE_TOKEN: 'dummy',
    SEC_EDGAR_USER_AGENT: 'Cortex Smoke Test (smoke@example.com)',
  }

  console.log(`Smoke-testing ${FEATURED_SERVERS.length} featured servers.\n`)

  const results: Result[] = []
  for (const server of FEATURED_SERVERS) {
    process.stdout.write(`  ${server.authType.padStart(7)}  ${server.id.padEnd(22)} `)

    if (REQUIRES_REAL_SETUP.has(server.id)) {
      const line: Result = {
        id: server.id,
        ok: false,
        tools: 0,
        message: 'requires a real credential / local app to test',
        skipped: true,
      }
      results.push(line)
      console.log('\u2026 skipped (real setup required)')
      continue
    }

    const envBag = server.authType === 'none' ? {} : DUMMY_ENV
    const base = buildConfig(server, envBag)
    const config: MCPServerConfig = server.authType === 'none'
      ? base
      : ({ ...base, env: DUMMY_ENV } as MCPServerConfig)
    const res = await runOne(server.id, config, 60_000)
    results.push(res)
    const mark = res.ok ? '\u2713' : '\u2717'
    const suffix = res.ok ? `${res.tools} tools` : res.message
    console.log(`${mark} ${suffix}`)
  }

  const testable = results.filter((r) => !r.skipped)
  const passed = testable.filter((r) => r.ok).length
  const skipped = results.filter((r) => r.skipped).length
  console.log(
    `\n${passed}/${testable.length} testable servers speak MCP and return tools` +
    (skipped > 0 ? ` (${skipped} skipped: real setup required).` : '.'),
  )

  const hardFailures = testable.filter((r) => !r.ok)
  if (hardFailures.length > 0) {
    console.log('\nFailures:')
    for (const r of hardFailures) {
      console.log(`  ${r.id}: ${r.message}`)
    }
  }

  process.exit(hardFailures.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('runner crash:', err)
  process.exit(2)
})
