/**
 * Unit Tests — MCP Transports
 *
 * Tests the transport abstraction layer — factory function
 * and transport interface compliance.
 */

import { describe, it, expect, vi } from 'vitest'
import { createTransport, StdioTransport, SSETransport, HTTPTransport, WebSocketTransport, _buildStdioEnv } from '../../../mcp/transports.js'
import { MCPError } from '../../../mcp/types.js'
import type {
  MCPStdioServerConfig,
  MCPSSEServerConfig,
  MCPHTTPServerConfig,
  MCPWebSocketServerConfig,
} from '../../../mcp/types.js'

// ---------------------------------------------------------------------------
// Factory tests
// ---------------------------------------------------------------------------

describe('createTransport()', () => {
  it('creates StdioTransport for stdio config', () => {
    const config: MCPStdioServerConfig = {
      name: 'test',
      transport: 'stdio',
      command: 'echo',
      args: ['hello'],
    }
    const transport = createTransport(config)
    expect(transport).toBeInstanceOf(StdioTransport)
  })

  it('creates SSETransport for sse config', () => {
    const config: MCPSSEServerConfig = {
      name: 'test',
      transport: 'sse',
      url: 'http://localhost:8080/sse',
    }
    const transport = createTransport(config)
    expect(transport).toBeInstanceOf(SSETransport)
  })

  it('creates HTTPTransport for http config', () => {
    const config: MCPHTTPServerConfig = {
      name: 'test',
      transport: 'http',
      url: 'http://localhost:8080/mcp',
    }
    const transport = createTransport(config)
    expect(transport).toBeInstanceOf(HTTPTransport)
  })

  it('creates WebSocketTransport for websocket config', () => {
    const config: MCPWebSocketServerConfig = {
      name: 'test',
      transport: 'websocket',
      url: 'ws://localhost:8080/mcp',
    }
    const transport = createTransport(config)
    expect(transport).toBeInstanceOf(WebSocketTransport)
  })

  it('throws MCPError for unsupported transport', () => {
    const config = { name: 'test', transport: 'carrier_pigeon' } as unknown
    expect(() => createTransport(config as any)).toThrow(MCPError)
  })
})

// ---------------------------------------------------------------------------
// StdioTransport
// ---------------------------------------------------------------------------

describe('StdioTransport', () => {
  it('starts as not open', () => {
    const config: MCPStdioServerConfig = {
      name: 'test',
      transport: 'stdio',
      command: 'echo',
      args: ['hello'],
    }
    const transport = new StdioTransport(config)
    expect(transport.isOpen).toBe(false)
  })

  it('registers handlers via onMessage/onError/onClose', () => {
    const config: MCPStdioServerConfig = {
      name: 'test',
      transport: 'stdio',
      command: 'echo',
    }
    const transport = new StdioTransport(config)
    // Should not throw
    transport.onMessage(() => {})
    transport.onError(() => {})
    transport.onClose(() => {})
  })

  it('spawns process and becomes open on start()', async () => {
    const config: MCPStdioServerConfig = {
      name: 'cat-server',
      transport: 'stdio',
      command: 'cat',
    }
    const transport = new StdioTransport(config)
    await transport.start()
    expect(transport.isOpen).toBe(true)
    await transport.close()
  })

  it('sends and receives messages via stdin/stdout', async () => {
    const config: MCPStdioServerConfig = {
      name: 'echo-server',
      transport: 'stdio',
      command: 'cat',
    }
    const transport = new StdioTransport(config)

    const received: string[] = []
    transport.onMessage((msg) => received.push(msg))

    await transport.start()
    transport.send('{"jsonrpc":"2.0","id":1,"method":"test"}')

    // Wait for cat to echo back
    await new Promise(r => setTimeout(r, 100))

    expect(received.length).toBeGreaterThanOrEqual(1)
    expect(received[0]).toContain('"jsonrpc"')

    await transport.close()
    expect(transport.isOpen).toBe(false)
  })

  it('throws when sending on a non-started transport', () => {
    const config: MCPStdioServerConfig = {
      name: 'test',
      transport: 'stdio',
      command: 'cat',
    }
    const transport = new StdioTransport(config)
    expect(() => transport.send('hello')).toThrow(MCPError)
  })
})

// ---------------------------------------------------------------------------
// HTTPTransport
// ---------------------------------------------------------------------------

describe('HTTPTransport', () => {
  it('starts as closed and becomes open', async () => {
    const config: MCPHTTPServerConfig = {
      name: 'test',
      transport: 'http',
      url: 'http://localhost:9999/mcp',
    }
    const transport = new HTTPTransport(config)
    expect(transport.isOpen).toBe(false)
    await transport.start()
    expect(transport.isOpen).toBe(true)
    await transport.close()
    expect(transport.isOpen).toBe(false)
  })

  it('throws when sending while closed', async () => {
    const config: MCPHTTPServerConfig = {
      name: 'test',
      transport: 'http',
      url: 'http://localhost:9999/mcp',
    }
    const transport = new HTTPTransport(config)
    expect(() => transport.send('hello')).toThrow(MCPError)
  })
})

// ---------------------------------------------------------------------------
// SSETransport
// ---------------------------------------------------------------------------

describe('SSETransport', () => {
  it('starts as closed', () => {
    const config: MCPSSEServerConfig = {
      name: 'test',
      transport: 'sse',
      url: 'http://localhost:9999/sse',
    }
    const transport = new SSETransport(config)
    expect(transport.isOpen).toBe(false)
  })

  it('throws when sending before endpoint discovery', () => {
    const config: MCPSSEServerConfig = {
      name: 'test',
      transport: 'sse',
      url: 'http://localhost:9999/sse',
    }
    const transport = new SSETransport(config)
    expect(() => transport.send('hello')).toThrow(MCPError)
  })
})

// ---------------------------------------------------------------------------
// WebSocketTransport
// ---------------------------------------------------------------------------

describe('WebSocketTransport', () => {
  it('starts as closed', () => {
    const config: MCPWebSocketServerConfig = {
      name: 'test',
      transport: 'websocket',
      url: 'ws://localhost:9999/mcp',
    }
    const transport = new WebSocketTransport(config)
    expect(transport.isOpen).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Stdio environment allowlist (Hazard 2)
// ---------------------------------------------------------------------------
//
// Lock in the strict env allowlist so a future "I'll just pass
// process.env, what's the worst that could happen" change has to fight
// the test suite first.

describe('_buildStdioEnv (Hazard 2 — env leak prevention)', () => {
  it('drops provider API keys from process.env', () => {
    const parent = {
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      OPENAI_API_KEY: 'sk-openai-secret',
      GOOGLE_API_KEY: 'AIza-secret',
      PATH: '/usr/bin',
      HOME: '/home/test',
    }
    const env = _buildStdioEnv(parent, undefined)
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.GOOGLE_API_KEY).toBeUndefined()
    // Basics still flow through.
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/test')
  })

  it('drops AWS, Stripe, GitHub-style secrets', () => {
    const parent = {
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      AWS_ACCESS_KEY_ID: 'aws-id',
      STRIPE_SECRET_KEY: 'sk_live_x',
      GITHUB_TOKEN: 'ghp_x',
      GITLAB_TOKEN: 'glpat-x',
      PATH: '/usr/bin',
    }
    const env = _buildStdioEnv(parent, undefined)
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined()
    expect(env.STRIPE_SECRET_KEY).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.GITLAB_TOKEN).toBeUndefined()
  })

  it('drops random unknown env vars (default-deny)', () => {
    const parent = {
      MY_INTERNAL_THING: 'leak-me',
      SOME_RANDOM_VAR: 'should-not-pass',
      PATH: '/usr/bin',
    }
    const env = _buildStdioEnv(parent, undefined)
    expect(env.MY_INTERNAL_THING).toBeUndefined()
    expect(env.SOME_RANDOM_VAR).toBeUndefined()
  })

  it('passes through standard POSIX basics', () => {
    const parent = {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/me',
      USER: 'me',
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'UTF-8',
      TMPDIR: '/tmp',
      SHELL: '/bin/zsh',
    }
    const env = _buildStdioEnv(parent, undefined)
    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.HOME).toBe('/Users/me')
    expect(env.USER).toBe('me')
    expect(env.LANG).toBe('en_US.UTF-8')
    expect(env.LC_CTYPE).toBe('UTF-8')
    expect(env.TMPDIR).toBe('/tmp')
    expect(env.SHELL).toBe('/bin/zsh')
  })

  it('passes through npm/uv/bun config prefixes (npx + uvx need them)', () => {
    const parent = {
      npm_config_cache: '/tmp/npm-cache',
      npm_config_prefix: '/usr/local',
      UV_CACHE_DIR: '/tmp/uv',
      BUN_INSTALL: '/usr/local/bun',
      NVM_DIR: '/Users/me/.nvm',
      PATH: '/usr/bin',
    }
    const env = _buildStdioEnv(parent, undefined)
    expect(env.npm_config_cache).toBe('/tmp/npm-cache')
    expect(env.npm_config_prefix).toBe('/usr/local')
    expect(env.UV_CACHE_DIR).toBe('/tmp/uv')
    expect(env.BUN_INSTALL).toBe('/usr/local/bun')
    expect(env.NVM_DIR).toBe('/Users/me/.nvm')
  })

  it('drops npm_config_*authToken even though npm_config_ is allowlisted (defense in depth)', () => {
    const parent = {
      npm_config__authToken: 'npm-secret',
      'npm_config_//registry.npmjs.org/:_authToken': 'npm-secret',
      PATH: '/usr/bin',
    }
    const env = _buildStdioEnv(parent, undefined)
    expect(env.npm_config__authToken).toBeUndefined()
    expect(env['npm_config_//registry.npmjs.org/:_authToken']).toBeUndefined()
  })

  it('layers config.env on top — explicit user config wins', () => {
    const parent = { PATH: '/usr/bin', HOME: '/h' }
    const env = _buildStdioEnv(parent, {
      GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_user_provided',
      DATABASE_URL: 'postgres://localhost/test',
    })
    // Explicit config.env values are passed through regardless.
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('ghp_user_provided')
    expect(env.DATABASE_URL).toBe('postgres://localhost/test')
    // Allowlisted basics still flow.
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/h')
  })

  it('config.env can override an inherited allowlisted value', () => {
    const parent = { PATH: '/usr/bin', HOME: '/h' }
    const env = _buildStdioEnv(parent, { HOME: '/override/home' })
    expect(env.HOME).toBe('/override/home')
  })

  it('passes through Windows essentials when present', () => {
    const parent = {
      SYSTEMROOT: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      USERPROFILE: 'C:\\Users\\me',
      APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      PATH: 'C:\\Windows\\system32',
    }
    const env = _buildStdioEnv(parent, undefined)
    expect(env.SYSTEMROOT).toBe('C:\\Windows')
    expect(env.ComSpec).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(env.USERPROFILE).toBe('C:\\Users\\me')
    expect(env.PATHEXT).toBe('.COM;.EXE;.BAT;.CMD')
  })

  it('skips undefined values from process.env', () => {
    const parent: NodeJS.ProcessEnv = { PATH: '/usr/bin', NOT_SET: undefined }
    const env = _buildStdioEnv(parent, undefined)
    expect(env.NOT_SET).toBeUndefined()
    expect('NOT_SET' in env).toBe(false)
  })

  it('returns an empty object for an empty parent + no config', () => {
    const env = _buildStdioEnv({}, undefined)
    expect(env).toEqual({})
  })
})
