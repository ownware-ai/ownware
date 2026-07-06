/**
 * Unit tests — Credential Zod schema.
 *
 * Goal: every refinement in `schema.ts` has a passing case AND a
 * failing case, so a future change that loosens a rule trips a test
 * before it ships. The test names enumerate the rule under test.
 */

import { describe, it, expect } from 'vitest'
import {
  CREDENTIAL_ID_PREFIX,
  CredentialSchema,
  CredentialListSchema,
  SpendCapSchema,
  isCredentialId,
  makeCredentialId,
  maskCredentialValue,
  type Credential,
} from '../../../src/credential/schema.js'

const NOW = '2026-04-25T12:00:00.000Z'
const LATER = '2026-04-25T12:00:01.000Z'
const EARLIER = '2026-04-25T11:59:59.000Z'

function base(overrides: Partial<Credential> = {}): Credential {
  return {
    id: 'cred_abc123def456',
    name: 'Anthropic API Key',
    variableName: 'ANTHROPIC_API_KEY',
    category: 'llm',
    authType: 'api-key',
    hint: '...HM8A',
    trust: 'medium',
    source: 'manual',
    createdAt: NOW,
    updatedAt: NOW,
    status: 'ready',
    ...overrides,
  } as Credential
}

describe('makeCredentialId', () => {
  it('returns an id matching the schema regex', () => {
    const id = makeCredentialId()
    expect(id.startsWith(CREDENTIAL_ID_PREFIX)).toBe(true)
    expect(isCredentialId(id)).toBe(true)
    expect(id).toMatch(/^cred_[a-f0-9]{12}$/)
  })

  it('produces unique ids across many invocations', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 5000; i++) seen.add(makeCredentialId())
    expect(seen.size).toBe(5000)
  })
})

describe('isCredentialId', () => {
  it('accepts valid ids', () => {
    expect(isCredentialId('cred_abc123def456')).toBe(true)
  })
  it('rejects wrong prefix', () => {
    expect(isCredentialId('thread_abc123def456')).toBe(false)
  })
  it('rejects wrong length', () => {
    expect(isCredentialId('cred_abc')).toBe(false)
    expect(isCredentialId('cred_abc123def4567')).toBe(false)
  })
  it('rejects non-hex chars', () => {
    expect(isCredentialId('cred_ABC123DEF456')).toBe(false)
    expect(isCredentialId('cred_abc123-ef456')).toBe(false)
  })
})

describe('maskCredentialValue', () => {
  it('returns last 4 chars prefixed with ...', () => {
    expect(maskCredentialValue('sk-ant-api03-XXXX-HM8A')).toBe('...HM8A')
  })

  it('handles values shorter than 4 chars', () => {
    expect(maskCredentialValue('abc')).toBe('...abc')
    expect(maskCredentialValue('a')).toBe('...a')
  })

  it('produces a hint that the schema accepts', () => {
    const hint = maskCredentialValue('1234567890ABCDEFhm8a')
    const parsed = CredentialSchema.safeParse(base({ hint }))
    expect(parsed.success).toBe(true)
  })

  it('throws on empty input', () => {
    expect(() => maskCredentialValue('')).toThrow()
  })

  it('throws on non-string input', () => {
    expect(() => maskCredentialValue(undefined as unknown as string)).toThrow()
  })
})

describe('CredentialSchema — happy paths', () => {
  it('accepts a minimal valid LLM credential', () => {
    const parsed = CredentialSchema.safeParse(base())
    expect(parsed.success).toBe(true)
  })

  it('accepts an oauth2 credential without variableName', () => {
    const parsed = CredentialSchema.safeParse(
      base({
        name: 'GitHub OAuth',
        category: 'oauth',
        authType: 'oauth2',
        variableName: undefined,
        grantedScopes: ['read:user', 'repo'],
        forConnector: 'composio:github',
      }),
    )
    expect(parsed.success).toBe(true)
  })

  it('accepts a basic-auth credential without variableName', () => {
    const parsed = CredentialSchema.safeParse(
      base({ authType: 'basic', variableName: undefined, category: 'tool' }),
    )
    expect(parsed.success).toBe(true)
  })

  it('accepts spendCap on llm category', () => {
    const parsed = CredentialSchema.safeParse(
      base({ spendCap: { amountUsd: 5, period: 'day' } }),
    )
    expect(parsed.success).toBe(true)
  })

  it('accepts tags within length + character class', () => {
    const parsed = CredentialSchema.safeParse(
      base({ tags: ['work', 'prod', 'team-a', 'env.prod'] }),
    )
    expect(parsed.success).toBe(true)
  })

  it('list schema parses an empty array and a non-empty array', () => {
    expect(CredentialListSchema.safeParse([]).success).toBe(true)
    expect(CredentialListSchema.safeParse([base()]).success).toBe(true)
  })
})

describe('CredentialSchema — id', () => {
  it('rejects wrong-prefix id', () => {
    const parsed = CredentialSchema.safeParse(base({ id: 'thr_abc123def456' as Credential['id'] }))
    expect(parsed.success).toBe(false)
  })

  it('rejects too-short id', () => {
    const parsed = CredentialSchema.safeParse(base({ id: 'cred_abc' as Credential['id'] }))
    expect(parsed.success).toBe(false)
  })
})

describe('CredentialSchema — variableName', () => {
  it('rejects names starting with a digit', () => {
    const parsed = CredentialSchema.safeParse(base({ variableName: '1FOO' }))
    expect(parsed.success).toBe(false)
  })

  it('rejects names with hyphens', () => {
    const parsed = CredentialSchema.safeParse(base({ variableName: 'API-KEY' }))
    expect(parsed.success).toBe(false)
  })

  it('rejects empty names', () => {
    const parsed = CredentialSchema.safeParse(base({ variableName: '' }))
    expect(parsed.success).toBe(false)
  })

  it('requires variableName for api-key authType', () => {
    const parsed = CredentialSchema.safeParse(base({ variableName: undefined }))
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some(i => i.path.includes('variableName'))).toBe(true)
    }
  })

  it('requires variableName for bearer-token authType', () => {
    const parsed = CredentialSchema.safeParse(
      base({ authType: 'bearer-token', variableName: undefined, category: 'tool' }),
    )
    expect(parsed.success).toBe(false)
  })
})

describe('CredentialSchema — hint', () => {
  it('rejects hint without "..." prefix', () => {
    const parsed = CredentialSchema.safeParse(base({ hint: 'HM8A' }))
    expect(parsed.success).toBe(false)
  })

  it('rejects hint with too few tail chars', () => {
    const parsed = CredentialSchema.safeParse(base({ hint: '...' }))
    expect(parsed.success).toBe(false)
  })

  it('rejects hint with too many tail chars', () => {
    const parsed = CredentialSchema.safeParse(base({ hint: '...123456789' }))
    expect(parsed.success).toBe(false)
  })

  it('accepts base64url + padding chars', () => {
    expect(CredentialSchema.safeParse(base({ hint: '...HM8A=' })).success).toBe(true)
    expect(CredentialSchema.safeParse(base({ hint: '...A_B-C' })).success).toBe(true)
  })

  it('accepts dots in the value mask (URL/email-shaped credentials)', () => {
    // The fixture value to mask is whatever ends in `.com`, e.g.
    // `https://api.github.com` → mask = `....com`. The exact-3-dot
    // prefix plus a dotted tail is unambiguous.
    expect(CredentialSchema.safeParse(base({ hint: '....com' })).success).toBe(true)
    expect(CredentialSchema.safeParse(base({ hint: '...host' })).success).toBe(true)
  })

  it('rejects hint containing whitespace', () => {
    const parsed = CredentialSchema.safeParse(base({ hint: '... A1B' }))
    expect(parsed.success).toBe(false)
  })
})

describe('CredentialSchema — spendCap is LLM-only', () => {
  it('rejects spendCap on a tool credential', () => {
    const parsed = CredentialSchema.safeParse(
      base({
        category: 'tool',
        authType: 'api-key',
        spendCap: { amountUsd: 5, period: 'day' },
      }),
    )
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some(i => i.path.includes('spendCap'))).toBe(true)
    }
  })

  it('rejects spendCap on an oauth credential', () => {
    const parsed = CredentialSchema.safeParse(
      base({
        category: 'oauth',
        authType: 'oauth2',
        variableName: undefined,
        spendCap: { amountUsd: 5, period: 'month' },
      }),
    )
    expect(parsed.success).toBe(false)
  })
})

describe('CredentialSchema — timestamps', () => {
  it('rejects updatedAt earlier than createdAt', () => {
    const parsed = CredentialSchema.safeParse(
      base({ createdAt: NOW, updatedAt: EARLIER }),
    )
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some(i => i.path.includes('updatedAt'))).toBe(true)
    }
  })

  it('accepts updatedAt equal to createdAt', () => {
    expect(CredentialSchema.safeParse(base({ createdAt: NOW, updatedAt: NOW })).success).toBe(true)
  })

  it('accepts updatedAt later than createdAt', () => {
    expect(CredentialSchema.safeParse(base({ createdAt: NOW, updatedAt: LATER })).success).toBe(true)
  })

  it('rejects non-ISO timestamps', () => {
    const parsed = CredentialSchema.safeParse(base({ createdAt: '2026-04-25 12:00:00' as string }))
    expect(parsed.success).toBe(false)
  })
})

describe('CredentialSchema — status / statusReason', () => {
  it('requires statusReason when status is "expired"', () => {
    const parsed = CredentialSchema.safeParse(base({ status: 'expired' }))
    expect(parsed.success).toBe(false)
  })

  it('requires statusReason when status is "error"', () => {
    const parsed = CredentialSchema.safeParse(base({ status: 'error' }))
    expect(parsed.success).toBe(false)
  })

  it('requires statusReason when status is "revoked"', () => {
    const parsed = CredentialSchema.safeParse(base({ status: 'revoked' }))
    expect(parsed.success).toBe(false)
  })

  it('does NOT require statusReason when status is "ready"', () => {
    const parsed = CredentialSchema.safeParse(base({ status: 'ready' }))
    expect(parsed.success).toBe(true)
  })

  it('accepts statusReason alongside non-ready status', () => {
    const parsed = CredentialSchema.safeParse(
      base({ status: 'expired', statusReason: 'OAuth refresh failed' }),
    )
    expect(parsed.success).toBe(true)
  })
})

describe('CredentialSchema — strict mode', () => {
  it('rejects unknown fields (no value leak)', () => {
    const parsed = CredentialSchema.safeParse({
      ...base(),
      value: 'sk-ant-secret',
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects unknown nested fields', () => {
    const parsed = CredentialSchema.safeParse({
      ...base(),
      spendCap: { amountUsd: 5, period: 'day', extra: 'field' },
    })
    expect(parsed.success).toBe(false)
  })
})

describe('CredentialSchema — tags', () => {
  it('rejects tag starting with a separator', () => {
    const parsed = CredentialSchema.safeParse(base({ tags: ['-bad'] }))
    expect(parsed.success).toBe(false)
  })

  it('rejects tag with whitespace', () => {
    const parsed = CredentialSchema.safeParse(base({ tags: ['has space'] }))
    expect(parsed.success).toBe(false)
  })

  it('rejects more than 32 tags', () => {
    const tags = Array.from({ length: 33 }, (_, i) => `tag${i}`)
    const parsed = CredentialSchema.safeParse(base({ tags }))
    expect(parsed.success).toBe(false)
  })
})

describe('SpendCapSchema', () => {
  it('rejects zero amount', () => {
    expect(SpendCapSchema.safeParse({ amountUsd: 0, period: 'day' }).success).toBe(false)
  })

  it('rejects negative amount', () => {
    expect(SpendCapSchema.safeParse({ amountUsd: -1, period: 'day' }).success).toBe(false)
  })

  it('rejects unrealistically large amount', () => {
    expect(SpendCapSchema.safeParse({ amountUsd: 2_000_000, period: 'day' }).success).toBe(false)
  })

  it('rejects unknown period', () => {
    expect(
      SpendCapSchema.safeParse({ amountUsd: 5, period: 'week' as 'day' }).success,
    ).toBe(false)
  })

  it('accepts day + month period', () => {
    expect(SpendCapSchema.safeParse({ amountUsd: 5, period: 'day' }).success).toBe(true)
    expect(SpendCapSchema.safeParse({ amountUsd: 50, period: 'month' }).success).toBe(true)
  })

  it('rejects NaN / Infinity amount', () => {
    expect(SpendCapSchema.safeParse({ amountUsd: NaN, period: 'day' }).success).toBe(false)
    expect(SpendCapSchema.safeParse({ amountUsd: Infinity, period: 'day' }).success).toBe(false)
  })
})
