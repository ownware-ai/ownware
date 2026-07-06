/**
 * Unit tests for OAuth provider presets.
 *
 * Locks in the audit Hazard 22 fix: Notion needs a tokenTransform that
 * wraps the access token in the JSON-encoded headers shape its MCP
 * server expects. The previous code stored a bare token in
 * OPENAPI_MCP_HEADERS and the server crashed on parse.
 */

import { describe, it, expect } from 'vitest'
import { OAUTH_PRESETS } from '../../../src/connector/mcp/oauth-presets.js'
import type { OAuthTokens } from '@ownware/loom'

const fakeTokens = (overrides: Partial<OAuthTokens> = {}): OAuthTokens => ({
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token',
  expiresAt: Date.now() + 3600_000,
  scope: 'read write',
  tokenType: 'Bearer',
  ...overrides,
})

describe('OAUTH_PRESETS', () => {
  it('every preset has the required base fields', () => {
    for (const [id, preset] of Object.entries(OAUTH_PRESETS)) {
      expect(preset.serverId).toBe(id)
      expect(preset.name.length).toBeGreaterThan(0)
      expect(preset.authorizationUrl.startsWith('https://')).toBe(true)
      expect(preset.tokenUrl.startsWith('https://')).toBe(true)
      expect(typeof preset.tokenToEnv).toBe('string')
    }
  })

  describe('notion preset (Hazard 22 fix)', () => {
    it('has a tokenTransform that produces the OPENAPI_MCP_HEADERS JSON shape', () => {
      const preset = OAUTH_PRESETS['notion']
      expect(preset).toBeDefined()
      expect(preset!.tokenTransform).toBeTypeOf('function')

      const env = preset!.tokenTransform!(fakeTokens({ accessToken: 'ntn_xyz' }))
      expect(env.OPENAPI_MCP_HEADERS).toBeDefined()

      // The transform output MUST be valid JSON the Notion MCP server
      // can parse. Decode and verify shape.
      const parsed = JSON.parse(env.OPENAPI_MCP_HEADERS!)
      expect(parsed.Authorization).toBe('Bearer ntn_xyz')
      expect(parsed['Notion-Version']).toBe('2022-06-28')
    })

    it('produces a single env var, not multiple', () => {
      const preset = OAUTH_PRESETS['notion']!
      const env = preset.tokenTransform!(fakeTokens())
      expect(Object.keys(env)).toEqual(['OPENAPI_MCP_HEADERS'])
    })
  })

  describe('legacy single-env presets (github, gitlab, slack)', () => {
    // These presets do NOT need a transform — the access token is the
    // value the MCP server reads. Verify they leave tokenTransform unset
    // so the gateway falls back to the simple { [tokenToEnv]: accessToken }
    // path.
    it.each(['github', 'gitlab', 'slack'])('%s does NOT need tokenTransform', (id) => {
      const preset = OAUTH_PRESETS[id]
      expect(preset).toBeDefined()
      expect(preset!.tokenTransform).toBeUndefined()
    })

    it('github → GITHUB_PERSONAL_ACCESS_TOKEN', () => {
      expect(OAUTH_PRESETS['github']!.tokenToEnv).toBe('GITHUB_PERSONAL_ACCESS_TOKEN')
    })

    it('slack → SLACK_BOT_TOKEN (which is what oauth.v2.access.access_token actually is)', () => {
      expect(OAUTH_PRESETS['slack']!.tokenToEnv).toBe('SLACK_BOT_TOKEN')
    })

    it('gitlab → GITLAB_PERSONAL_ACCESS_TOKEN', () => {
      expect(OAUTH_PRESETS['gitlab']!.tokenToEnv).toBe('GITLAB_PERSONAL_ACCESS_TOKEN')
    })
  })
})
