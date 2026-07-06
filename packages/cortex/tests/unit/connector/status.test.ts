/**
 * Unit tests — `computeConnectorStatus` pure function.
 *
 * Covers every transport × authType combination, plus the bridge-presence
 * overlay. Pure inputs in, pure outputs out — no I/O.
 */

import { describe, it, expect } from 'vitest'

import { computeConnectorStatus } from '../../../src/connector/status.js'
import type { AuthMode } from '../../../src/connector/schema.js'
import type { FeaturedTransport } from '../../../src/connector/mcp/featured.js'

const STDIO: FeaturedTransport = { kind: 'stdio', runtime: 'npx', package: '@x/y' }
const HTTP_REMOTE: FeaturedTransport = { kind: 'http_remote', url: 'https://mcp.example.com/mcp' }
const BRIDGE: FeaturedTransport = { kind: 'http_bridge', bridgeId: 'paper' }

const NONE_AUTH: AuthMode = { mode: 'none' }
const API_KEY_AUTH: AuthMode = {
  mode: 'api_key',
  envVars: [{ name: 'API_KEY', description: '', isRequired: true, isSecret: true }],
}
const OAUTH_AUTH: AuthMode = { mode: 'oauth', provider: 'GitHub', hasPreset: true }
const RUNTIME_SETUP_AUTH: AuthMode = {
  mode: 'runtime_setup',
  hint: 'Sign in once.',
  command: ['uvx', 'thing', '--login'],
}

describe('computeConnectorStatus — none', () => {
  it('always ready regardless of env state', () => {
    expect(
      computeConnectorStatus({
        auth: NONE_AUTH,
        transport: STDIO,
        envCheck: {},
        requiredVars: [],
        oauthBundlePresent: false,
        runtimeSetupComplete: false,
      }),
    ).toBe('ready')
  })
})

describe('computeConnectorStatus — api_key', () => {
  it('needs_setup when required var missing', () => {
    expect(
      computeConnectorStatus({
        auth: API_KEY_AUTH,
        transport: STDIO,
        envCheck: { API_KEY: false },
        requiredVars: [{ name: 'API_KEY', isRequired: true }],
        oauthBundlePresent: false,
        runtimeSetupComplete: false,
      }),
    ).toBe('needs_setup')
  })

  it('ready when every required var is set', () => {
    expect(
      computeConnectorStatus({
        auth: API_KEY_AUTH,
        transport: STDIO,
        envCheck: { API_KEY: true },
        requiredVars: [{ name: 'API_KEY', isRequired: true }],
        oauthBundlePresent: false,
        runtimeSetupComplete: false,
      }),
    ).toBe('ready')
  })

  it('ignores optional vars (isRequired=false)', () => {
    expect(
      computeConnectorStatus({
        auth: API_KEY_AUTH,
        transport: STDIO,
        envCheck: { API_KEY: true, EXTRA: false },
        requiredVars: [
          { name: 'API_KEY', isRequired: true },
          { name: 'EXTRA', isRequired: false },
        ],
        oauthBundlePresent: false,
        runtimeSetupComplete: false,
      }),
    ).toBe('ready')
  })
})

describe('computeConnectorStatus — oauth', () => {
  it('ready when OAuth bundle present (even with empty requiredVars)', () => {
    expect(
      computeConnectorStatus({
        auth: OAUTH_AUTH,
        transport: STDIO,
        envCheck: {},
        requiredVars: [],
        oauthBundlePresent: true,
        runtimeSetupComplete: false,
      }),
    ).toBe('ready')
  })

  it('needs_setup with empty requiredVars and no bundle (lying-badge fix)', () => {
    expect(
      computeConnectorStatus({
        auth: OAUTH_AUTH,
        transport: STDIO,
        envCheck: {},
        requiredVars: [],
        oauthBundlePresent: false,
        runtimeSetupComplete: false,
      }),
    ).toBe('needs_setup')
  })

  it('ready via api-key fallback when env var manually exported', () => {
    expect(
      computeConnectorStatus({
        auth: OAUTH_AUTH,
        transport: STDIO,
        envCheck: { GITHUB_TOKEN: true },
        requiredVars: [{ name: 'GITHUB_TOKEN', isRequired: true }],
        oauthBundlePresent: false,
        runtimeSetupComplete: false,
      }),
    ).toBe('ready')
  })

  it('needs_setup when fallback env var declared but unset', () => {
    expect(
      computeConnectorStatus({
        auth: OAUTH_AUTH,
        transport: STDIO,
        envCheck: { GITHUB_TOKEN: false },
        requiredVars: [{ name: 'GITHUB_TOKEN', isRequired: true }],
        oauthBundlePresent: false,
        runtimeSetupComplete: false,
      }),
    ).toBe('needs_setup')
  })
})

describe('computeConnectorStatus — runtime_setup', () => {
  it('needs_setup when marker absent', () => {
    expect(
      computeConnectorStatus({
        auth: RUNTIME_SETUP_AUTH,
        transport: STDIO,
        envCheck: {},
        requiredVars: [],
        oauthBundlePresent: false,
        runtimeSetupComplete: false,
      }),
    ).toBe('needs_setup')
  })

  it('ready when marker present', () => {
    expect(
      computeConnectorStatus({
        auth: RUNTIME_SETUP_AUTH,
        transport: STDIO,
        envCheck: {},
        requiredVars: [],
        oauthBundlePresent: false,
        runtimeSetupComplete: true,
      }),
    ).toBe('ready')
  })
})

describe('computeConnectorStatus — http_remote transport', () => {
  it('treats http_remote like stdio for status (auth-driven only)', () => {
    expect(
      computeConnectorStatus({
        auth: OAUTH_AUTH,
        transport: HTTP_REMOTE,
        envCheck: {},
        requiredVars: [],
        oauthBundlePresent: true,
        runtimeSetupComplete: false,
      }),
    ).toBe('ready')
  })
})

describe('computeConnectorStatus — http_bridge overlay', () => {
  it('downgrades to needs_setup when bridge unreachable, even with valid creds', () => {
    expect(
      computeConnectorStatus({
        auth: NONE_AUTH,
        transport: BRIDGE,
        envCheck: {},
        requiredVars: [],
        oauthBundlePresent: false,
        runtimeSetupComplete: false,
        bridgeReachable: false,
      }),
    ).toBe('needs_setup')
  })

  it('ready when bridge reachable and auth is none', () => {
    expect(
      computeConnectorStatus({
        auth: NONE_AUTH,
        transport: BRIDGE,
        envCheck: {},
        requiredVars: [],
        oauthBundlePresent: false,
        runtimeSetupComplete: false,
        bridgeReachable: true,
      }),
    ).toBe('ready')
  })

  it('treats undefined bridgeReachable as no overlay (auth-driven only)', () => {
    expect(
      computeConnectorStatus({
        auth: NONE_AUTH,
        transport: BRIDGE,
        envCheck: {},
        requiredVars: [],
        oauthBundlePresent: false,
        runtimeSetupComplete: false,
      }),
    ).toBe('ready')
  })
})
