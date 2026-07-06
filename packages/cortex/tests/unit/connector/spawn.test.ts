/**
 * Unit tests — `buildMCPClientConfig` pure function.
 */

import { describe, it, expect } from 'vitest'
import { buildMCPClientConfig } from '../../../src/connector/spawn.js'

describe('buildMCPClientConfig — stdio', () => {
  it('npx runtime prepends -y and the package', () => {
    const cfg = buildMCPClientConfig({
      name: 'github',
      transport: { kind: 'stdio', runtime: 'npx', package: '@modelcontextprotocol/server-github' },
      env: { GITHUB_TOKEN: 'abc' },
    })
    expect(cfg).toEqual({
      name: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'abc' },
    })
  })

  it('uvx runtime omits -y prefix', () => {
    const cfg = buildMCPClientConfig({
      name: 'git',
      transport: { kind: 'stdio', runtime: 'uvx', package: 'mcp-server-git' },
      env: {},
    })
    expect(cfg).toEqual({
      name: 'git',
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-git'],
      env: {},
    })
  })

  it('appends transport.args after the package', () => {
    const cfg = buildMCPClientConfig({
      name: 'filesystem',
      transport: {
        kind: 'stdio',
        runtime: 'npx',
        package: '@modelcontextprotocol/server-filesystem',
        args: ['/tmp'],
      },
      env: {},
    })
    expect(cfg.transport).toBe('stdio')
    expect(cfg.transport === 'stdio' && cfg.args).toEqual([
      '-y',
      '@modelcontextprotocol/server-filesystem',
      '/tmp',
    ])
  })

  it('applies transformArg to every argv entry', () => {
    const cfg = buildMCPClientConfig({
      name: 'stripe',
      transport: {
        kind: 'stdio',
        runtime: 'npx',
        package: '@stripe/mcp',
        args: ['--api-key=${STRIPE_SECRET_KEY}'],
      },
      env: { STRIPE_SECRET_KEY: 'sk_live_123' },
      transformArg: (a) => a.replace('${STRIPE_SECRET_KEY}', 'sk_live_123'),
    })
    expect(cfg.transport === 'stdio' && cfg.args).toEqual([
      '-y',
      '@stripe/mcp',
      '--api-key=sk_live_123',
    ])
  })
})

describe('buildMCPClientConfig — http_remote', () => {
  it('returns http transport with the remote URL', () => {
    const cfg = buildMCPClientConfig({
      name: 'notion-remote',
      transport: { kind: 'http_remote', url: 'https://mcp.notion.com/mcp' },
      env: {},
    })
    expect(cfg).toEqual({
      name: 'notion-remote',
      transport: 'http',
      url: 'https://mcp.notion.com/mcp',
    })
  })
})

describe('buildMCPClientConfig — http_bridge', () => {
  it('throws — bridge must be resolved by the catalog reader first', () => {
    expect(() =>
      buildMCPClientConfig({
        name: 'paper',
        transport: { kind: 'http_bridge', bridgeId: 'paper' },
        env: {},
      }),
    ).toThrow(/bridge transport.*must be resolved/)
  })
})
