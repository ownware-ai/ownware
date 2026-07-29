import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CodexRunIsolationError,
  enforceCodexRuntimeIsolation,
  materializeCodexRunHome,
  prepareCodexSandboxPlan,
  type CodexSandboxDecision,
  type CodexSandboxReport,
} from '../../../../src/runtime/codex/run-isolation.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ))
})

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `ownware-codex-${label}-`))
  roots.push(root)
  return realpath(root)
}

function accept(report: CodexSandboxReport): CodexSandboxDecision {
  return {
    reportId: report.id,
    acceptedLimitations: ['host_read_scope'],
  }
}

describe('materializeCodexRunHome', () => {
  it('creates an owned home with exactly one loopback MCP configuration', async () => {
    const root = await tempRoot('owned-home')
    const home = join(root, 'codex-home')

    const result = await materializeCodexRunHome({
      codexHome: home,
      mcpEndpoint: 'http://127.0.0.1:43127/mcp',
    })

    expect(result.codexHome).toBe(await realpath(home))
    const config = await readFile(join(home, 'config.toml'), 'utf8')
    expect(config).toBe([
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
      '[mcp_servers.ownware_run]',
      'url = "http://127.0.0.1:43127/mcp"',
      'bearer_token_env_var = "OWNWARE_CODEX_MCP_TOKEN"',
      '',
    ].join('\n'))
    expect(await readFile(join(home, '.ownware-managed'), 'utf8')).toBe(
      'ownware-codex-home-v1\n',
    )
  })

  it('replaces only its own config and preserves Codex-owned authentication', async () => {
    const root = await tempRoot('preserve-auth')
    const home = join(root, 'codex-home')
    await materializeCodexRunHome({
      codexHome: home,
      mcpEndpoint: 'http://127.0.0.1:43127/mcp',
    })
    await writeFile(join(home, 'auth.json'), 'opaque-codex-owned-bytes', {
      mode: 0o600,
    })
    await writeFile(
      join(home, 'config.toml'),
      '[mcp_servers.unrelated]\nurl = "http://127.0.0.1:9/mcp"\n',
      { mode: 0o600 },
    )

    await materializeCodexRunHome({
      codexHome: home,
      mcpEndpoint: 'http://127.0.0.1:44000/mcp',
    })

    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(
      'opaque-codex-owned-bytes',
    )
    const config = await readFile(join(home, 'config.toml'), 'utf8')
    expect(config).toContain('127.0.0.1:44000')
    expect(config).not.toContain('unrelated')
  })

  it('will not overwrite an unmarked directory or accept a non-loopback endpoint', async () => {
    const root = await tempRoot('ownership')
    const occupied = join(root, 'occupied')
    await mkdir(occupied)
    await writeFile(join(occupied, 'config.toml'), 'customer-owned')

    await expect(materializeCodexRunHome({
      codexHome: occupied,
      mcpEndpoint: 'http://127.0.0.1:43127/mcp',
    })).rejects.toMatchObject({ code: 'home_not_owned' })
    await expect(materializeCodexRunHome({
      codexHome: join(root, 'remote'),
      mcpEndpoint: 'https://example.com/mcp',
    })).rejects.toMatchObject({ code: 'invalid_mcp_endpoint' })
  })
})

describe('enforceCodexRuntimeIsolation', () => {
  it('disables every ambient skill then proves one exact MCP tool set', async () => {
    let skillsRead = 0
    const request = vi.fn(async (method: string, params: any) => {
      if (method === 'skills/list') {
        skillsRead += 1
        return {
          data: [{
            cwd: '/tmp/workspace',
            errors: [],
            skills: skillsRead === 1
              ? [
                  {
                    name: 'ambient-one',
                    path: '/outside/ambient-one/SKILL.md',
                    scope: 'user',
                    enabled: true,
                    description: 'not retained',
                  },
                  {
                    name: 'ambient-two',
                    path: '/outside/ambient-two/SKILL.md',
                    scope: 'system',
                    enabled: true,
                    description: 'not retained',
                  },
                ]
              : [
                  {
                    name: 'ambient-one',
                    path: '/outside/ambient-one/SKILL.md',
                    scope: 'user',
                    enabled: false,
                    description: 'not retained',
                  },
                  {
                    name: 'ambient-two',
                    path: '/outside/ambient-two/SKILL.md',
                    scope: 'system',
                    enabled: false,
                    description: 'not retained',
                  },
                ],
          }],
        }
      }
      if (method === 'skills/config/write') {
        expect(params).toMatchObject({ enabled: false })
        return {}
      }
      if (method === 'app/installed') {
        return { apps: [] }
      }
      if (method === 'plugin/installed') {
        return { marketplaces: [], marketplaceLoadErrors: [] }
      }
      if (method === 'mcpServerStatus/list') {
        return {
          data: [{
            name: 'ownware_run',
            authStatus: 'bearerToken',
            tools: {
              approved_read: {
                name: 'approved_read',
                description: 'Approved read',
                inputSchema: { type: 'object', properties: {} },
              },
            },
            resources: [],
            resourceTemplates: [],
          }],
          nextCursor: null,
        }
      }
      throw new Error(`unexpected method ${method}`)
    })

    const result = await enforceCodexRuntimeIsolation(
      { request },
      {
        workspacePath: '/tmp/workspace',
        expectedToolNames: ['approved_read'],
      },
    )

    expect(result).toEqual({
      mcpServerName: 'ownware_run',
      toolNames: ['approved_read'],
      disabledAmbientSkills: 2,
      callableAmbientApps: 0,
      enabledAmbientPlugins: 0,
    })
    expect(request).toHaveBeenCalledWith('skills/config/write', {
      path: '/outside/ambient-one/SKILL.md',
      enabled: false,
    })
    expect(request).toHaveBeenCalledWith('skills/config/write', {
      path: '/outside/ambient-two/SKILL.md',
      enabled: false,
    })
  })

  it('fails when an unrelated server/tool is visible or an ambient skill remains enabled', async () => {
    for (const failure of ['server', 'tool', 'skill'] as const) {
      let skillsRead = 0
      const request = vi.fn(async (method: string) => {
        if (method === 'skills/list') {
          skillsRead += 1
          return {
            data: [{
              cwd: '/tmp/workspace',
              errors: [],
              skills: failure === 'skill'
                ? [{
                    name: 'ambient',
                    path: '/outside/ambient/SKILL.md',
                    scope: 'user',
                    enabled: true,
                    description: 'private',
                  }]
                : [],
            }],
          }
        }
        if (method === 'skills/config/write') return {}
        if (method === 'app/installed') return { apps: [] }
        if (method === 'plugin/installed') {
          return { marketplaces: [], marketplaceLoadErrors: [] }
        }
        if (method === 'mcpServerStatus/list') {
          return {
            data: [
              {
                name: 'ownware_run',
                authStatus: 'bearerToken',
                tools: failure === 'tool'
                  ? { unexpected: { name: 'unexpected' } }
                  : { approved_read: { name: 'approved_read' } },
                resources: [],
                resourceTemplates: [],
              },
              ...(failure === 'server'
                ? [{
                    name: 'global_canary',
                    authStatus: 'unsupported',
                    tools: {},
                    resources: [],
                    resourceTemplates: [],
                  }]
                : []),
            ],
            nextCursor: null,
          }
        }
        throw new Error('unexpected')
      })

      await expect(enforceCodexRuntimeIsolation(
        { request },
        {
          workspacePath: '/tmp/workspace',
          expectedToolNames: ['approved_read'],
        },
      )).rejects.toBeInstanceOf(CodexRunIsolationError)
      expect(skillsRead).toBeGreaterThan(0)
    }
  })

  it('fails when an ambient app is callable or an installed plugin is enabled', async () => {
    for (const failure of ['app', 'plugin'] as const) {
      const request = vi.fn(async (method: string) => {
        if (method === 'skills/list') {
          return { data: [{ cwd: '/tmp/workspace', errors: [], skills: [] }] }
        }
        if (method === 'app/installed') {
          return {
            apps: failure === 'app'
              ? [{ id: 'ambient', enabled: true, callable: true }]
              : [],
          }
        }
        if (method === 'plugin/installed') {
          return {
            marketplaces: failure === 'plugin'
              ? [{
                  plugins: [{
                    enabled: true,
                    installed: true,
                  }],
                }]
              : [],
            marketplaceLoadErrors: [],
          }
        }
        if (method === 'mcpServerStatus/list') {
          return {
            data: [{
              name: 'ownware_run',
              tools: {},
              resources: [],
              resourceTemplates: [],
            }],
            nextCursor: null,
          }
        }
        throw new Error('unexpected method')
      })

      await expect(enforceCodexRuntimeIsolation(
        { request },
        {
          workspacePath: '/tmp/workspace',
          expectedToolNames: [],
        },
      )).rejects.toMatchObject({
        code: failure === 'app'
          ? 'ambient_app_enabled'
          : 'ambient_plugin_enabled',
      })
    }
  })

  it('rejects malformed pagination and skill errors without exposing path or description', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'skills/list') {
        return {
          data: [{
            cwd: '/private/workspace',
            errors: [{ path: '/private/secret', message: 'private detail' }],
            skills: [],
          }],
        }
      }
      throw new Error('unexpected')
    })
    let error: unknown
    try {
      await enforceCodexRuntimeIsolation(
        { request },
        { workspacePath: '/private/workspace', expectedToolNames: [] },
      )
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(CodexRunIsolationError)
    expect(String(error)).not.toContain('/private')
    expect(String(error)).not.toContain('secret')
    expect(String(error)).not.toContain('detail')
  })

  it('fails closed on malformed app state or plugin discovery errors', async () => {
    for (const failure of ['app', 'plugin'] as const) {
      const request = vi.fn(async (method: string) => {
        if (method === 'skills/list') {
          return { data: [{ cwd: '/tmp/workspace', errors: [], skills: [] }] }
        }
        if (method === 'app/installed') {
          return failure === 'app'
            ? { apps: [{ id: 'private-app', enabled: false }] }
            : { apps: [] }
        }
        if (method === 'plugin/installed') {
          return {
            marketplaces: [],
            marketplaceLoadErrors: failure === 'plugin'
              ? [{ message: 'private plugin failure' }]
              : [],
          }
        }
        throw new Error('unexpected method')
      })
      let error: unknown
      try {
        await enforceCodexRuntimeIsolation(
          { request },
          { workspacePath: '/tmp/workspace', expectedToolNames: [] },
        )
      } catch (caught) {
        error = caught
      }
      expect(error).toMatchObject({
        code: failure === 'app' ? 'app_scan_failed' : 'plugin_scan_failed',
      })
      expect(String(error)).not.toContain('private')
    }
  })
})

describe('prepareCodexSandboxPlan', () => {
  it('requires exact disclosure acceptance and emits the pinned restrictive shapes', async () => {
    const root = await tempRoot('sandbox')
    const workspace = join(root, 'workspace')
    const extra = join(root, 'extra')
    await mkdir(workspace)
    await mkdir(extra)

    const first = await prepareCodexSandboxPlan({
      workspacePath: workspace,
      approvedRoots: [workspace, extra],
      writableRoots: [extra],
      mode: 'workspace_write',
    })
    expect(first.report.state).toBe('requires_acceptance')
    expect(first.plan).toBeNull()

    const accepted = await prepareCodexSandboxPlan({
      workspacePath: workspace,
      approvedRoots: [workspace, extra],
      writableRoots: [extra],
      mode: 'workspace_write',
    }, accept(first.report))

    expect(accepted.plan).toEqual({
      threadStart: {
        sandbox: 'workspace-write',
        approvalPolicy: {
          granular: {
            mcp_elicitations: false,
            request_permissions: false,
            rules: false,
            sandbox_approval: true,
            skill_approval: false,
          },
        },
      },
      turnStart: {
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [await realpath(extra)],
          networkAccess: false,
          excludeSlashTmp: true,
          excludeTmpdirEnvVar: true,
        },
      },
      readScope: 'host_readable',
      networkScope: 'denied',
    })
  })

  it('rejects stale decisions, unknown modes, and writable roots outside approval', async () => {
    const root = await tempRoot('sandbox-reject')
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    await mkdir(workspace)
    await mkdir(outside)

    const first = await prepareCodexSandboxPlan({
      workspacePath: workspace,
      approvedRoots: [workspace],
      writableRoots: [],
      mode: 'read_only',
    })
    await expect(prepareCodexSandboxPlan({
      workspacePath: workspace,
      approvedRoots: [workspace],
      writableRoots: [outside],
      mode: 'workspace_write',
    }, accept(first.report))).rejects.toMatchObject({ code: 'root_not_approved' })

    await expect(prepareCodexSandboxPlan({
      workspacePath: workspace,
      approvedRoots: [workspace],
      writableRoots: [],
      mode: 'future_mode' as any,
    })).rejects.toMatchObject({ code: 'unsupported_sandbox' })

    const changed = await prepareCodexSandboxPlan({
      workspacePath: workspace,
      approvedRoots: [workspace],
      writableRoots: [],
      mode: 'workspace_write',
    })
    await expect(prepareCodexSandboxPlan({
      workspacePath: workspace,
      approvedRoots: [workspace],
      writableRoots: [],
      mode: 'read_only',
    }, accept(changed.report))).rejects.toMatchObject({ code: 'stale_decision' })
  })

  it('rejects a symlink as an approved or writable-root identity', async () => {
    const root = await tempRoot('sandbox-symlink')
    const workspace = join(root, 'workspace')
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    await mkdir(workspace)
    await mkdir(target)
    await symlink(target, alias)

    await expect(prepareCodexSandboxPlan({
      workspacePath: workspace,
      approvedRoots: [workspace, alias],
      writableRoots: [alias],
      mode: 'workspace_write',
    })).rejects.toMatchObject({ code: 'invalid_workspace' })
  })
})
