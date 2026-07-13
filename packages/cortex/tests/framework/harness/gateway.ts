/**
 * Test Gateway Harness
 *
 * Creates an isolated OwnwareGateway with a temporary directory and database
 * for testing. Auto-cleanup on close. Pre-seeds profiles for use in tests.
 *
 * Usage:
 *   const gw = await createTestGateway()
 *   // ... run tests ...
 *   await gw.stop()
 */

import { OwnwareGateway } from '../../../src/gateway/server.js'
import { GatewayState } from '../../../src/gateway/state.js'
import type { SessionRunner } from '../../../src/gateway/session-runner.js'
import { join } from 'node:path'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { ApiClient } from './api-client.js'
import { FixtureRecorder } from './fixture-recorder.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProfileDefinition {
  /** Profile name (used as directory name) */
  readonly name: string
  /** Profile kind (agent | helper | both). Matches ProfileSchema.kind. */
  readonly kind?: 'agent' | 'helper' | 'both'
  /**
   * Product binding (`ProfileSchema.productId`). Defaults to `'ownware'`
   * when omitted. Seed a closed-product slug (e.g. `'ownware-design'`) to
   * exercise product-policy enforcement.
   */
  readonly productId?: string
  /** Description shown in UI */
  readonly description?: string
  /** Model string, e.g., 'anthropic:claude-sonnet-4-20250514' */
  readonly model?: string
  /** SOUL.md content (system prompt) */
  readonly soulMd?: string
  /** AGENTS.md content (memory) */
  readonly agentsMd?: string
  /**
   * Tool config. `custom` paths are relative to the profile directory;
   * write them via `customTools` below.
   */
  readonly tools?: {
    preset?: string
    allow?: string[]
    deny?: string[]
    custom?: Array<{ path: string; functions?: string[] }>
    /**
     * MCP server declarations. Mirrors the `tools.mcp` shape on the
     * real profile schema — a map of server id → server config.
     * Shapeless here because the real schema's MCPServerSchema is a
     * discriminated union the harness doesn't need to reproduce.
     */
    mcp?: Record<string, Record<string, unknown>>
    /**
     * Composio toolkit declarations. Mirrors
     * `tools.composio.toolkits` from ComposioToolsConfigSchema so
     * integration tests can seed a profile with declared slugs
     * without a second write pass through the attach endpoint.
     */
    composio?: { toolkits?: string[] }
  }
  /**
   * Raw `subagents` array, written verbatim into agent.json under the
   * lowercase `subagents` key (matches ProfileSchema). Each entry must
   * conform to SubagentSpecSchema (name, description, and any optional
   * profile/tools/grant/systemPrompt/model fields).
   *
   * NOTE: earlier versions of this harness emitted a camelCase
   * `subAgents` map which the schema silently ignored. That shape is
   * gone — pass the lowercase array form below.
   */
  readonly subagents?: ReadonlyArray<Record<string, unknown>>
  /**
   * Custom tool TS/JS files. Map of path-relative-to-profile-dir →
   * file contents. Use together with `tools.custom` to expose them.
   */
  readonly customTools?: Record<string, string>
  /** Skills (skill name → markdown content with frontmatter) */
  readonly skills?: Record<string, string>
}

export interface TestGatewayOptions {
  /** Profiles to seed before starting */
  readonly profiles?: ProfileDefinition[]
  /**
   * Use bundled profiles from packages/cortex/profiles/ (coder, researcher,
   * etc.) instead of (or in addition to) writing test profiles. Useful for
   * testing real production profiles without redefining them.
   */
  readonly useBundledProfiles?: boolean
  /** Direct DB seeding (called after start, before tests run) */
  readonly seed?: (state: GatewayState) => void | Promise<void>
  /** Enable fixture recording (default: process.env.RECORD_FIXTURES === '1') */
  readonly recordFixtures?: boolean
  /**
   * Override the SQLite database path. When set, the gateway uses this DB
   * instead of a temp file — enabling fixture threads to persist across runs
   * so a client can read them. The caller is responsible for ensuring the path
   * exists and migrations have run.
   */
  readonly dbPath?: string
  /** Explicit Gateway auth posture. Use false for principal/token contracts. */
  readonly disableAuth?: boolean
  /** Keep durable source jobs idle for direct state-machine tests. */
  readonly disableSourceWorker?: boolean
}

export interface TestGateway {
  /** OS-assigned port */
  readonly port: number
  /** Auth token for API calls */
  readonly token: string
  /** Direct GatewayState access (for setup/verification) */
  readonly state: GatewayState
  /** Background run manager — check isRunning(), listActive(), etc. */
  readonly runner: SessionRunner
  /** http://127.0.0.1:PORT */
  readonly baseUrl: string
  /** Pre-configured HTTP client */
  readonly client: ApiClient
  /** Temp directory (for creating workspace paths, etc.) */
  readonly tmpDir: string
  /** Fixture recorder (writes to fixtures/) */
  readonly recorder: FixtureRecorder
  /**
   * Live gateway instance — exposes internals tests need to inspect
   * (pendingReconciles, connectorStatusBus, registry). Use sparingly:
   * prefer exercising behaviour via `client` + `state`. Attached
   * escape hatch for integration tests that need to drive the status
   * bus or assert mark state.
   */
  readonly gateway: OwnwareGateway
  /** Stop the gateway and clean up */
  stop(options?: { readonly cleanup?: boolean }): Promise<void>
}

// ---------------------------------------------------------------------------
// Default Profiles
// ---------------------------------------------------------------------------

/** Always-present minimal profile for tests that just need any profile. */
const DEFAULT_MINI_PROFILE: ProfileDefinition = {
  name: 'mini',
  description: 'Minimal test agent — no tools, no helpers',
  model: 'anthropic:claude-sonnet-4-20250514',
  tools: { preset: 'none' },
}

// ---------------------------------------------------------------------------
// createTestGateway
// ---------------------------------------------------------------------------

export async function createTestGateway(opts: TestGatewayOptions = {}): Promise<TestGateway> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'cortex-fw-'))
  const profilesDir = join(tmpDir, 'profiles')
  const dbPath = opts.dbPath ?? join(tmpDir, 'test.db')

  // Seed profiles
  const allProfiles = [DEFAULT_MINI_PROFILE, ...(opts.profiles ?? [])]
  for (const profile of allProfiles) {
    await writeProfileToDisk(profilesDir, profile)
  }

  // Optionally include real bundled profiles (coder, researcher, etc.)
  const additionalProfileDirs: string[] = []
  if (opts.useBundledProfiles) {
    const bundledDir = join(CORTEX_PACKAGE_ROOT, 'profiles')
    additionalProfileDirs.push(bundledDir)
  }

  // Start gateway. `dataDir = tmpDir/data` (distinct from
  // `profilesDir = tmpDir/profiles`) keeps every write path inside
  // the test's sandbox. The two MUST differ — the gateway registers
  // `profilesDir` as the BUILTIN source, and the user fork target is
  // `join(dataDir, 'profiles')`. If we pointed `dataDir` at `tmpDir`
  // directly, both resolve to the same path and `forkBuiltin` would
  // try to `cp(builtinPath, userPath)` with `builtinPath === userPath`
  // — a recursive copy onto itself that wipes the seed.
  const dataDir = join(tmpDir, 'data')
  const gw = new OwnwareGateway({
    port: 0,
    profilesDir,
    dataDir,
    dbPath,
    additionalProfileDirs,
    // Plain HTTP/1.1 in tests: no browser → no 6-conn stall to reproduce,
    // and it keeps every test's `http://…:${port}` URL working without a
    // per-boot cert. The HTTP/2-over-TLS path (desktop default) is verified
    // separately (gateway-perf-2026-06-13 probes + the Electron run).
    tls: false,
    ...(opts.disableAuth !== undefined ? { disableAuth: opts.disableAuth } : {}),
    ...(opts.disableSourceWorker !== undefined
      ? { disableSourceWorker: opts.disableSourceWorker } : {}),
  })
  await gw.start()

  // Optional pre-seed
  if (opts.seed) {
    await opts.seed(gw.state)
  }

  const port = gw.port
  const baseUrl = `http://127.0.0.1:${port}`
  const client = new ApiClient(baseUrl, gw.token)
  const recorder = new FixtureRecorder({
    enabled: opts.recordFixtures ?? process.env['RECORD_FIXTURES'] === '1',
    dir: join(CORTEX_PACKAGE_ROOT, 'tests', 'framework', 'fixtures'),
  })

  return {
    port,
    token: gw.token,
    state: gw.state,
    runner: gw.runner,
    baseUrl,
    client,
    tmpDir,
    recorder,
    gateway: gw,
    async stop(options = {}) {
      await recorder.flush()
      await gw.stop()
      if (options.cleanup !== false) await rm(tmpDir, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// Profile writer
// ---------------------------------------------------------------------------

async function writeProfileToDisk(profilesDir: string, profile: ProfileDefinition): Promise<void> {
  const dir = join(profilesDir, profile.name)
  await mkdir(dir, { recursive: true })

  const config: Record<string, unknown> = {
    name: profile.name,
    description: profile.description ?? `Test profile: ${profile.name}`,
    model: profile.model ?? 'anthropic:claude-sonnet-4-20250514',
    tools: profile.tools ?? { preset: 'none' },
    context: { cwd: false, datetime: false },
  }

  if (profile.kind) {
    config['kind'] = profile.kind
  }
  if (profile.productId) {
    config['productId'] = profile.productId
  }
  if (profile.subagents && profile.subagents.length > 0) {
    config['subagents'] = profile.subagents
  }

  await writeFile(join(dir, 'agent.json'), JSON.stringify(config, null, 2))

  if (profile.customTools && Object.keys(profile.customTools).length > 0) {
    for (const [relPath, content] of Object.entries(profile.customTools)) {
      const fullPath = join(dir, relPath)
      const parent = fullPath.substring(0, fullPath.lastIndexOf('/'))
      await mkdir(parent, { recursive: true })
      await writeFile(fullPath, content, 'utf-8')
    }
  }

  if (profile.soulMd) {
    await writeFile(join(dir, 'SOUL.md'), profile.soulMd)
  }
  if (profile.agentsMd) {
    await writeFile(join(dir, 'AGENTS.md'), profile.agentsMd)
  }

  if (profile.skills && Object.keys(profile.skills).length > 0) {
    const skillsDir = join(dir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    for (const [skillName, content] of Object.entries(profile.skills)) {
      await writeFile(join(skillsDir, `${skillName}.md`), content)
    }
  }
}

// ---------------------------------------------------------------------------
// ESM path resolution — resolve relative to package root, not file position
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

/**
 * Package root for @ownware/cortex.
 *
 * Resolved from import.meta.url → this file's directory → up to package root.
 * This is more robust than counting '../' — if the harness file moves within
 * the package, only HARNESS_DIR_DEPTH needs updating (or switch to a
 * findUp('package.json') approach).
 */
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const CORTEX_PACKAGE_ROOT = join(__dirname, '..', '..', '..')
