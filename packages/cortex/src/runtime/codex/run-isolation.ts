import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import {
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'

const HOME_MARKER = '.ownware-managed'
const HOME_MARKER_CONTENT = 'ownware-codex-home-v1\n'
const MCP_SERVER_NAME = 'ownware_run'
const MCP_BEARER_ENV = 'OWNWARE_CODEX_MCP_TOKEN'
const MAX_PAGES = 100

export type CodexRunIsolationErrorCode =
  | 'invalid_home'
  | 'home_not_owned'
  | 'invalid_mcp_endpoint'
  | 'configuration_write_failed'
  | 'skill_scan_failed'
  | 'skill_disable_failed'
  | 'ambient_skill_enabled'
  | 'app_scan_failed'
  | 'ambient_app_enabled'
  | 'plugin_scan_failed'
  | 'ambient_plugin_enabled'
  | 'mcp_status_invalid'
  | 'unexpected_mcp_server'
  | 'unexpected_mcp_tools'
  | 'pagination_invalid'
  | 'invalid_workspace'
  | 'root_not_approved'
  | 'unsupported_sandbox'
  | 'stale_decision'
  | 'invalid_decision'

export class CodexRunIsolationError extends Error {
  public override readonly name = 'CodexRunIsolationError'

  constructor(readonly code: CodexRunIsolationErrorCode) {
    super(`Codex run isolation failed (${code}).`)
  }
}

export interface MaterializeCodexRunHomeInput {
  readonly codexHome: string
  readonly mcpEndpoint: string
}

export interface MaterializedCodexRunHome {
  readonly codexHome: string
  readonly bearerTokenEnvVar: typeof MCP_BEARER_ENV
  readonly mcpServerName: typeof MCP_SERVER_NAME
}

export interface CodexRequestClient {
  request(method: string, params?: unknown): Promise<unknown>
}

export interface CodexRuntimeIsolationInput {
  readonly workspacePath: string
  readonly expectedToolNames: readonly string[]
}

export interface CodexRuntimeIsolationProof {
  readonly mcpServerName: typeof MCP_SERVER_NAME
  readonly toolNames: readonly string[]
  readonly disabledAmbientSkills: number
  readonly callableAmbientApps: 0
  readonly enabledAmbientPlugins: 0
}

export type CodexSandboxMode = 'read_only' | 'workspace_write'

export interface CodexSandboxInput {
  readonly workspacePath: string
  readonly approvedRoots: readonly string[]
  readonly writableRoots: readonly string[]
  /**
   * Open at the boundary so a newer persisted value fails with a typed error
   * instead of entering a permissive default branch.
   */
  readonly mode: CodexSandboxMode | string
}

export interface CodexSandboxLimitation {
  readonly id: 'host_read_scope'
  readonly severity: 'requires_acceptance'
  readonly description: string
  readonly authority: string
}

export interface CodexSandboxReport {
  readonly id: string
  readonly state: 'requires_acceptance'
  readonly observedAt: string
  readonly validUntil: null
  readonly authority: 'codex-app-server/0.145.0-generated-schema'
  readonly limitations: readonly CodexSandboxLimitation[]
}

export interface CodexSandboxDecision {
  readonly reportId: string
  readonly acceptedLimitations: readonly string[]
}

export interface CodexSandboxPlan {
  readonly threadStart: {
    readonly sandbox: 'read-only' | 'workspace-write'
    readonly approvalPolicy: {
      readonly granular: {
        readonly mcp_elicitations: false
        readonly request_permissions: false
        readonly rules: false
        readonly sandbox_approval: true
        readonly skill_approval: false
      }
    }
  }
  readonly turnStart: {
    readonly sandboxPolicy:
      | {
          readonly type: 'readOnly'
          readonly networkAccess: false
        }
      | {
          readonly type: 'workspaceWrite'
          readonly writableRoots: readonly string[]
          readonly networkAccess: false
          readonly excludeSlashTmp: true
          readonly excludeTmpdirEnvVar: true
        }
  }
  /**
   * The pinned built-in sandbox constrains writes/network, not host reads.
   * This value exists so no caller can mistake workspace-write for a read
   * jail.
   */
  readonly readScope: 'host_readable'
  readonly networkScope: 'denied'
}

export interface CodexPreparedSandboxPlan {
  readonly report: CodexSandboxReport
  readonly plan: CodexSandboxPlan | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (!isRecord(value)) return value
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) output[key] = stable(value[key])
  return output
}

function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex')
}

function validateMcpEndpoint(value: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new CodexRunIsolationError('invalid_mcp_endpoint')
  }
  if (
    parsed.protocol !== 'http:'
    || parsed.hostname !== '127.0.0.1'
    || parsed.port.length === 0
    || parsed.pathname !== '/mcp'
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new CodexRunIsolationError('invalid_mcp_endpoint')
  }
  return parsed
}

/**
 * Replace the configuration inside an explicitly Ownware-managed Codex home.
 * Codex-owned auth/session files are untouched; Ownware never reads auth.json.
 */
export async function materializeCodexRunHome(
  input: MaterializeCodexRunHomeInput,
): Promise<MaterializedCodexRunHome> {
  if (!isAbsolute(input.codexHome)) {
    throw new CodexRunIsolationError('invalid_home')
  }
  const endpoint = validateMcpEndpoint(input.mcpEndpoint)
  const requestedHome = resolve(input.codexHome)
  await mkdir(requestedHome, { recursive: true, mode: 0o700 })
  const codexHome = await realpath(requestedHome)
  const markerPath = join(codexHome, HOME_MARKER)

  let marker: string | null = null
  try {
    marker = await readFile(markerPath, 'utf8')
  } catch {
    // The ownership decision below uses directory contents, not the error
    // string or a guessed errno.
  }

  if (marker == null) {
    const entries = await readdir(codexHome)
    if (entries.length > 0) {
      throw new CodexRunIsolationError('home_not_owned')
    }
    try {
      await writeFile(markerPath, HOME_MARKER_CONTENT, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      })
    } catch {
      throw new CodexRunIsolationError('configuration_write_failed')
    }
  } else if (marker !== HOME_MARKER_CONTENT) {
    throw new CodexRunIsolationError('home_not_owned')
  }

  const config = [
    'web_search = "disabled"',
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[features]',
    'apps = false',
    'browser_use = false',
    'browser_use_external = false',
    'browser_use_full_cdp_access = false',
    'computer_use = false',
    'goals = false',
    'hooks = false',
    'image_generation = false',
    'in_app_browser = false',
    'memories = false',
    'multi_agent = false',
    'multi_agent_v2 = false',
    'plugins = false',
    'skill_search = false',
    '',
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `url = "${endpoint.toString()}"`,
    `bearer_token_env_var = "${MCP_BEARER_ENV}"`,
    '',
  ].join('\n')
  const destination = join(codexHome, 'config.toml')
  const temporary = join(codexHome, `.config.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, config, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    await rename(temporary, destination)
  } catch {
    throw new CodexRunIsolationError('configuration_write_failed')
  }

  return {
    codexHome,
    bearerTokenEnvVar: MCP_BEARER_ENV,
    mcpServerName: MCP_SERVER_NAME,
  }
}

interface SkillRecord {
  readonly path: string
  readonly enabled: boolean
}

function parseSkills(value: unknown): SkillRecord[] {
  if (!isRecord(value) || !Array.isArray(value['data'])) {
    throw new CodexRunIsolationError('skill_scan_failed')
  }
  const skills: SkillRecord[] = []
  for (const entry of value['data']) {
    if (
      !isRecord(entry)
      || !Array.isArray(entry['errors'])
      || entry['errors'].length > 0
      || !Array.isArray(entry['skills'])
    ) {
      throw new CodexRunIsolationError('skill_scan_failed')
    }
    for (const skill of entry['skills']) {
      if (
        !isRecord(skill)
        || typeof skill['path'] !== 'string'
        || !isAbsolute(skill['path'])
        || typeof skill['enabled'] !== 'boolean'
      ) {
        throw new CodexRunIsolationError('skill_scan_failed')
      }
      skills.push({
        path: skill['path'],
        enabled: skill['enabled'],
      })
    }
  }
  return skills
}

async function listAllMcpServers(client: CodexRequestClient): Promise<unknown[]> {
  const servers: unknown[] = []
  const cursors = new Set<string>()
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await client.request('mcpServerStatus/list', {
      limit: 100,
      ...(cursor != null ? { cursor } : {}),
    })
    if (
      !isRecord(response)
      || !Array.isArray(response['data'])
      || !(
        response['nextCursor'] === null
        || response['nextCursor'] === undefined
        || typeof response['nextCursor'] === 'string'
      )
    ) {
      throw new CodexRunIsolationError('mcp_status_invalid')
    }
    servers.push(...response['data'])
    const next = response['nextCursor']
    if (next == null) return servers
    if (next.length === 0 || cursors.has(next)) {
      throw new CodexRunIsolationError('pagination_invalid')
    }
    cursors.add(next)
    cursor = next
  }
  throw new CodexRunIsolationError('pagination_invalid')
}

function assertNoCallableApps(value: unknown): void {
  if (!isRecord(value) || !Array.isArray(value['apps'])) {
    throw new CodexRunIsolationError('app_scan_failed')
  }
  for (const app of value['apps']) {
    if (
      !isRecord(app)
      || typeof app['id'] !== 'string'
      || typeof app['enabled'] !== 'boolean'
      || typeof app['callable'] !== 'boolean'
    ) {
      throw new CodexRunIsolationError('app_scan_failed')
    }
    if (app['enabled'] || app['callable']) {
      throw new CodexRunIsolationError('ambient_app_enabled')
    }
  }
}

function assertNoEnabledPlugins(value: unknown): void {
  if (
    !isRecord(value)
    || !Array.isArray(value['marketplaces'])
    || (
      value['marketplaceLoadErrors'] !== undefined
      && !Array.isArray(value['marketplaceLoadErrors'])
    )
    || (
      Array.isArray(value['marketplaceLoadErrors'])
      && value['marketplaceLoadErrors'].length > 0
    )
  ) {
    throw new CodexRunIsolationError('plugin_scan_failed')
  }
  for (const marketplace of value['marketplaces']) {
    if (!isRecord(marketplace) || !Array.isArray(marketplace['plugins'])) {
      throw new CodexRunIsolationError('plugin_scan_failed')
    }
    for (const plugin of marketplace['plugins']) {
      if (
        !isRecord(plugin)
        || typeof plugin['enabled'] !== 'boolean'
        || typeof plugin['installed'] !== 'boolean'
      ) {
        throw new CodexRunIsolationError('plugin_scan_failed')
      }
      if (plugin['enabled'] && plugin['installed']) {
        throw new CodexRunIsolationError('ambient_plugin_enabled')
      }
    }
  }
}

/**
 * Disable every ambient discovered skill and then inspect the provider's
 * actual MCP view. Configuration prose alone is not accepted as isolation.
 */
export async function enforceCodexRuntimeIsolation(
  client: CodexRequestClient,
  input: CodexRuntimeIsolationInput,
): Promise<CodexRuntimeIsolationProof> {
  if (!isAbsolute(input.workspacePath)) {
    throw new CodexRunIsolationError('invalid_workspace')
  }
  const initial = parseSkills(await client.request('skills/list', {
    cwds: [input.workspacePath],
    forceReload: true,
  }))
  const enabled = initial.filter((skill) => skill.enabled)
  for (const skill of enabled) {
    try {
      await client.request('skills/config/write', {
        path: skill.path,
        enabled: false,
      })
    } catch {
      throw new CodexRunIsolationError('skill_disable_failed')
    }
  }

  const verified = parseSkills(await client.request('skills/list', {
    cwds: [input.workspacePath],
    forceReload: true,
  }))
  if (verified.some((skill) => skill.enabled)) {
    throw new CodexRunIsolationError('ambient_skill_enabled')
  }

  assertNoCallableApps(await client.request('app/installed', {
    forceRefresh: false,
  }))
  assertNoEnabledPlugins(await client.request('plugin/installed', {
    cwds: [input.workspacePath],
    installSuggestionPluginNames: [],
  }))

  const servers = await listAllMcpServers(client)
  if (servers.length !== 1) {
    throw new CodexRunIsolationError('unexpected_mcp_server')
  }
  const server = servers[0]
  if (
    !isRecord(server)
    || server['name'] !== MCP_SERVER_NAME
    || !isRecord(server['tools'])
    || !Array.isArray(server['resources'])
    || !Array.isArray(server['resourceTemplates'])
  ) {
    throw new CodexRunIsolationError('mcp_status_invalid')
  }
  const observedTools = Object.keys(server['tools']).sort()
  const expectedTools = [...new Set(input.expectedToolNames)].sort()
  if (
    expectedTools.length !== input.expectedToolNames.length
    || observedTools.length !== expectedTools.length
    || observedTools.some((name, index) => name !== expectedTools[index])
  ) {
    throw new CodexRunIsolationError('unexpected_mcp_tools')
  }

  return {
    mcpServerName: MCP_SERVER_NAME,
    toolNames: observedTools,
    disabledAmbientSkills: enabled.length,
    callableAmbientApps: 0,
    enabledAmbientPlugins: 0,
  }
}

async function canonicalDirectory(value: string): Promise<string> {
  if (!isAbsolute(value)) {
    throw new CodexRunIsolationError('invalid_workspace')
  }
  let canonical: string
  try {
    canonical = await realpath(resolve(value))
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error('not-directory')
    }
    // Reject a final symlink alias as an approval identity. The canonical
    // target may be approved explicitly instead.
    if ((await lstat(value)).isSymbolicLink()) {
      throw new Error('symlink-root')
    }
  } catch {
    throw new CodexRunIsolationError('invalid_workspace')
  }
  return canonical
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export async function prepareCodexSandboxPlan(
  input: CodexSandboxInput,
  decision?: CodexSandboxDecision,
): Promise<CodexPreparedSandboxPlan> {
  if (input.mode !== 'read_only' && input.mode !== 'workspace_write') {
    throw new CodexRunIsolationError('unsupported_sandbox')
  }
  const workspacePath = await canonicalDirectory(input.workspacePath)
  const approvedRoots: string[] = []
  for (const root of input.approvedRoots) {
    approvedRoots.push(await canonicalDirectory(root))
  }
  if (!approvedRoots.some((root) => isWithin(root, workspacePath))) {
    throw new CodexRunIsolationError('root_not_approved')
  }

  const writableRoots: string[] = []
  for (const root of input.writableRoots) {
    const canonical = await canonicalDirectory(root)
    if (!approvedRoots.some((approved) => isWithin(approved, canonical))) {
      throw new CodexRunIsolationError('root_not_approved')
    }
    if (!writableRoots.includes(canonical)) writableRoots.push(canonical)
  }
  if (input.mode === 'read_only' && writableRoots.length > 0) {
    throw new CodexRunIsolationError('unsupported_sandbox')
  }

  const reportId = fingerprint({
    mode: input.mode,
    workspacePath,
    approvedRoots,
    writableRoots,
    readScope: 'host_readable',
    networkScope: 'denied',
  })
  const report: CodexSandboxReport = {
    id: reportId,
    state: 'requires_acceptance',
    observedAt: new Date().toISOString(),
    validUntil: null,
    authority: 'codex-app-server/0.145.0-generated-schema',
    limitations: [{
      id: 'host_read_scope',
      severity: 'requires_acceptance',
      description:
        'The built-in Codex sandbox constrains writes and network, but does not confine reads to the workspace.',
      authority: 'turn/start.sandboxPolicy',
    }],
  }

  if (decision == null) return { report, plan: null }
  if (decision.reportId !== reportId) {
    throw new CodexRunIsolationError('stale_decision')
  }
  if (
    decision.acceptedLimitations.length !== 1
    || decision.acceptedLimitations[0] !== 'host_read_scope'
  ) {
    throw new CodexRunIsolationError('invalid_decision')
  }

  const approvalPolicy = {
    granular: {
      mcp_elicitations: false as const,
      request_permissions: false as const,
      rules: false as const,
      sandbox_approval: true as const,
      skill_approval: false as const,
    },
  }
  const plan: CodexSandboxPlan = input.mode === 'read_only'
    ? {
        threadStart: {
          sandbox: 'read-only',
          approvalPolicy,
        },
        turnStart: {
          sandboxPolicy: {
            type: 'readOnly',
            networkAccess: false,
          },
        },
        readScope: 'host_readable',
        networkScope: 'denied',
      }
    : {
        threadStart: {
          sandbox: 'workspace-write',
          approvalPolicy,
        },
        turnStart: {
          sandboxPolicy: {
            type: 'workspaceWrite',
            writableRoots,
            networkAccess: false,
            excludeSlashTmp: true,
            excludeTmpdirEnvVar: true,
          },
        },
        readScope: 'host_readable',
        networkScope: 'denied',
      }
  return { report, plan }
}
