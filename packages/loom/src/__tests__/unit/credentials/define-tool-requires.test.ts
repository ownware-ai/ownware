/**
 * Unit tests — `defineTool({ requires })` (board: credentials-
 * unification — C37).
 *
 * Pinned:
 *   - defineTool accepts a `requires` array.
 *   - Tools without `requires` work unchanged (legacy default).
 *   - The descriptor shape carries forward into `Tool.requires`
 *     verbatim — no defaulting / normalisation that would surprise
 *     the future dispatcher.
 */

import { describe, it, expect } from 'vitest'
import { defineTool } from '../../../tools/types.js'
import type {
  CredentialDescriptor,
  CredentialDescriptorAuthType,
} from '../../../credentials/descriptor.js'

describe('defineTool — requires field', () => {
  it('accepts a Tool with no requires (legacy default)', () => {
    const tool = defineTool({
      name: 'noop',
      description: 'no creds',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => ({ content: 'ok', isError: false }),
    })
    expect(tool.requires).toBeUndefined()
  })

  it('accepts a Tool with a single descriptor', () => {
    const requires: CredentialDescriptor[] = [
      {
        name: 'VERCEL_TOKEN',
        description: 'Vercel deploy token',
        authType: 'api-key',
      },
    ]
    const tool = defineTool({
      name: 'deploy_to_vercel',
      description: 'Ship a Vercel deploy',
      inputSchema: { type: 'object', properties: {} },
      requires,
      execute: async () => ({ content: 'deployed', isError: false }),
    })
    expect(tool.requires).toEqual(requires)
  })

  it('accepts every authType variant in a descriptor', () => {
    const types: CredentialDescriptorAuthType[] = [
      'api-key',
      'oauth2',
      'bearer-token',
      'basic',
    ]
    for (const authType of types) {
      const tool = defineTool({
        name: `t-${authType}`,
        description: 'test',
        inputSchema: { type: 'object', properties: {} },
        requires: [
          { name: 'X', description: 'x', authType },
        ],
        execute: async () => ({ content: 'x', isError: false }),
      })
      expect(tool.requires?.[0]!.authType).toBe(authType)
    }
  })

  it('preserves optional descriptor fields verbatim', () => {
    const tool = defineTool({
      name: 'gh',
      description: 'github',
      inputSchema: { type: 'object', properties: {} },
      requires: [{
        name: 'GITHUB_TOKEN',
        description: 'GitHub PAT',
        authType: 'api-key',
        getKeyUrl: 'https://github.com/settings/tokens',
        category: 'mcp-server',
        forConnector: 'mcp:github',
        placeholder: 'ghp_…',
        isRequired: false,
      }],
      execute: async () => ({ content: 'ok', isError: false }),
    })
    const descriptor = tool.requires?.[0]!
    expect(descriptor.getKeyUrl).toBe('https://github.com/settings/tokens')
    expect(descriptor.category).toBe('mcp-server')
    expect(descriptor.forConnector).toBe('mcp:github')
    expect(descriptor.placeholder).toBe('ghp_…')
    expect(descriptor.isRequired).toBe(false)
  })
})
