/**
 * Unit tests — CredentialDescriptor schema + connector parity.
 *
 * Three things this file pins down:
 *
 *   1. The descriptor Zod refinements (required fields, name shape,
 *      duplicate-name rejection) match what the resolver expects.
 *   2. The descriptor↔connector envVar bridge drops non-secret entries
 *      and round-trips secret entries with full fidelity.
 *   3. The connector envVar shape we depend on hasn't drifted — if
 *      `connector/schema.ts` renames a field, the parity test fails
 *      loudly, before the runtime drops a credential into the wrong
 *      slot.
 */

import { describe, it, expect } from 'vitest'
import {
  CredentialDescriptorSchema,
  CredentialDescriptorListSchema,
  descriptorFromConnectorEnvVar,
  descriptorsFromConnectorEnvVars,
  type CredentialDescriptor,
  type ConnectorEnvVarLike,
} from '../../../src/credential/descriptors.js'
import { AuthModeApiKeySchema } from '../../../src/connector/schema.js'

function makeDescriptor(overrides: Partial<CredentialDescriptor> = {}): CredentialDescriptor {
  return {
    name: 'VERCEL_TOKEN',
    description: 'Vercel deploy token (read+write)',
    authType: 'api-key',
    isRequired: true,
    ...overrides,
  }
}

describe('CredentialDescriptorSchema — happy paths', () => {
  it('accepts a minimal descriptor', () => {
    const parsed = CredentialDescriptorSchema.safeParse({
      name: 'VERCEL_TOKEN',
      description: 'Vercel deploy token',
      authType: 'api-key',
    })
    expect(parsed.success).toBe(true)
  })

  it('defaults isRequired to true', () => {
    const parsed = CredentialDescriptorSchema.parse({
      name: 'X', // single-letter env var is legal under POSIX
      description: 'X',
      authType: 'api-key',
    })
    expect(parsed.isRequired).toBe(true)
  })

  it('accepts a full descriptor with optional fields', () => {
    const parsed = CredentialDescriptorSchema.safeParse({
      name: 'VERCEL_TOKEN',
      description: 'Vercel deploy token',
      authType: 'api-key',
      isRequired: false,
      getKeyUrl: 'https://vercel.com/account/tokens',
      category: 'tool',
      forConnector: 'mcp:vercel',
      placeholder: 'vc_...',
    })
    expect(parsed.success).toBe(true)
  })
})

describe('CredentialDescriptorSchema — name', () => {
  it('rejects names starting with a digit', () => {
    const parsed = CredentialDescriptorSchema.safeParse(makeDescriptor({ name: '1FOO' }))
    expect(parsed.success).toBe(false)
  })

  it('rejects names with hyphens', () => {
    const parsed = CredentialDescriptorSchema.safeParse(makeDescriptor({ name: 'API-KEY' }))
    expect(parsed.success).toBe(false)
  })

  it('rejects empty names', () => {
    const parsed = CredentialDescriptorSchema.safeParse(makeDescriptor({ name: '' }))
    expect(parsed.success).toBe(false)
  })

  it('rejects names over 128 chars', () => {
    const parsed = CredentialDescriptorSchema.safeParse(
      makeDescriptor({ name: 'A'.repeat(129) }),
    )
    expect(parsed.success).toBe(false)
  })
})

describe('CredentialDescriptorSchema — description', () => {
  it('rejects empty description', () => {
    const parsed = CredentialDescriptorSchema.safeParse(makeDescriptor({ description: '' }))
    expect(parsed.success).toBe(false)
  })

  it('rejects description over 512 chars', () => {
    const parsed = CredentialDescriptorSchema.safeParse(
      makeDescriptor({ description: 'x'.repeat(513) }),
    )
    expect(parsed.success).toBe(false)
  })
})

describe('CredentialDescriptorSchema — getKeyUrl', () => {
  it('rejects a non-URL', () => {
    const parsed = CredentialDescriptorSchema.safeParse(
      makeDescriptor({ getKeyUrl: 'not-a-url' }),
    )
    expect(parsed.success).toBe(false)
  })
})

describe('CredentialDescriptorSchema — authType', () => {
  it('accepts every supported authType', () => {
    for (const authType of ['api-key', 'oauth2', 'bearer-token', 'basic'] as const) {
      const parsed = CredentialDescriptorSchema.safeParse(makeDescriptor({ authType }))
      expect(parsed.success).toBe(true)
    }
  })

  it('rejects unknown authType', () => {
    const parsed = CredentialDescriptorSchema.safeParse(
      makeDescriptor({ authType: 'magic-link' as 'api-key' }),
    )
    expect(parsed.success).toBe(false)
  })
})

describe('CredentialDescriptorSchema — strict mode', () => {
  it('rejects unknown fields', () => {
    const parsed = CredentialDescriptorSchema.safeParse({
      ...makeDescriptor(),
      value: 'leaked',
    })
    expect(parsed.success).toBe(false)
  })
})

describe('CredentialDescriptorListSchema', () => {
  it('accepts an empty list', () => {
    expect(CredentialDescriptorListSchema.safeParse([]).success).toBe(true)
  })

  it('rejects more than 32 entries', () => {
    const list = Array.from({ length: 33 }, (_, i) => makeDescriptor({ name: `VAR_${i}` }))
    const parsed = CredentialDescriptorListSchema.safeParse(list)
    expect(parsed.success).toBe(false)
  })

  it('rejects duplicate names', () => {
    const parsed = CredentialDescriptorListSchema.safeParse([
      makeDescriptor({ name: 'TOKEN' }),
      makeDescriptor({ name: 'TOKEN' }),
    ])
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      const issue = parsed.error.issues.find(i => i.message.includes('duplicate'))
      expect(issue).toBeDefined()
    }
  })

  it('accepts distinct names', () => {
    const parsed = CredentialDescriptorListSchema.safeParse([
      makeDescriptor({ name: 'TOKEN_A' }),
      makeDescriptor({ name: 'TOKEN_B' }),
    ])
    expect(parsed.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Connector parity
// ---------------------------------------------------------------------------

describe('descriptorFromConnectorEnvVar', () => {
  it('round-trips a secret env var', () => {
    const descriptor = descriptorFromConnectorEnvVar('mcp:github', {
      name: 'GITHUB_TOKEN',
      description: 'GitHub PAT for the github MCP server',
      isRequired: true,
      isSecret: true,
    })
    expect(descriptor).toEqual({
      name: 'GITHUB_TOKEN',
      description: 'GitHub PAT for the github MCP server',
      authType: 'api-key',
      isRequired: true,
      forConnector: 'mcp:github',
      category: 'mcp-server',
    })
  })

  it('returns null for non-secret env vars', () => {
    const descriptor = descriptorFromConnectorEnvVar('mcp:foo', {
      name: 'AWS_REGION',
      description: 'AWS region',
      isRequired: true,
      isSecret: false,
    })
    expect(descriptor).toBeNull()
  })

  it('preserves isRequired = false', () => {
    const descriptor = descriptorFromConnectorEnvVar('mcp:foo', {
      name: 'OPTIONAL_TOKEN',
      description: 'Optional token',
      isRequired: false,
      isSecret: true,
    })
    expect(descriptor?.isRequired).toBe(false)
  })

  it('emits a descriptor that the schema accepts', () => {
    const descriptor = descriptorFromConnectorEnvVar('mcp:github', {
      name: 'GITHUB_TOKEN',
      description: 'GitHub PAT',
      isRequired: true,
      isSecret: true,
    })
    expect(descriptor).not.toBeNull()
    const parsed = CredentialDescriptorSchema.safeParse(descriptor!)
    expect(parsed.success).toBe(true)
  })

  it('honours an explicit authType override', () => {
    const descriptor = descriptorFromConnectorEnvVar(
      'mcp:foo',
      { name: 'TOKEN', description: 'd', isRequired: true, isSecret: true },
      'bearer-token',
    )
    expect(descriptor?.authType).toBe('bearer-token')
  })
})

describe('descriptorsFromConnectorEnvVars', () => {
  it('drops non-secret entries and de-dupes', () => {
    const list = descriptorsFromConnectorEnvVars('mcp:foo', [
      { name: 'TOKEN', description: 'd', isRequired: true, isSecret: true },
      { name: 'AWS_REGION', description: 'd', isRequired: true, isSecret: false },
      { name: 'TOKEN', description: 'd', isRequired: true, isSecret: true }, // dupe
      { name: 'ANOTHER', description: 'd', isRequired: false, isSecret: true },
    ])
    expect(list.map(d => d.name)).toEqual(['TOKEN', 'ANOTHER'])
  })

  it('preserves order of secret entries', () => {
    const list = descriptorsFromConnectorEnvVars('mcp:foo', [
      { name: 'A', description: 'd', isRequired: true, isSecret: true },
      { name: 'B', description: 'd', isRequired: true, isSecret: true },
      { name: 'C', description: 'd', isRequired: true, isSecret: true },
    ])
    expect(list.map(d => d.name)).toEqual(['A', 'B', 'C'])
  })

  it('returns an empty list when nothing is secret', () => {
    const list = descriptorsFromConnectorEnvVars('mcp:foo', [
      { name: 'AWS_REGION', description: 'd', isRequired: true, isSecret: false },
    ])
    expect(list).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Drift guard — the connector envVar shape must stay compatible.
// ---------------------------------------------------------------------------

describe('parity with connector/schema.ts auth.envVars', () => {
  it("ConnectorEnvVarLike is a strict subset of the connector's AuthModeApiKey envVars entry", () => {
    // Build an envVars entry shape that AuthModeApiKeySchema accepts...
    const envVar = {
      name: 'GITHUB_TOKEN',
      description: 'GitHub PAT',
      isRequired: true,
      isSecret: true,
    }
    const apiKeyAuth = AuthModeApiKeySchema.safeParse({
      mode: 'api_key',
      envVars: [envVar],
    })
    expect(apiKeyAuth.success).toBe(true)

    // ...and confirm our bridge accepts the SAME object without coercion.
    const bridged: ConnectorEnvVarLike = envVar
    const descriptor = descriptorFromConnectorEnvVar('mcp:github', bridged)
    expect(descriptor).not.toBeNull()
    expect(descriptor?.name).toBe('GITHUB_TOKEN')
  })
})
