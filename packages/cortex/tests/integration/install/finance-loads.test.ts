/**
 * Smoke test: the `finance` builtin profile loads cleanly,
 * including its 23 skills and all 6 nested helpers.
 *
 * Catches breakage in agent.json schemas, SKILL.md frontmatter, helper
 * agent.jsons, and the local-helper resolver in one shot. Runs as part
 * of the integration suite so a typo in the profile content fails CI
 * before it reaches the user.
 */

import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { loadProfile } from '../../../src/profile/loader.js'
import {
  resolveLocalHelperDir,
  loadLocalHelperProfile,
} from '../../../src/profile/local-helpers.js'

/**
 * The `finance` profile lives in the private `ownware-profiles` repo at
 * `~/journey/ownware-profiles/`. CI's sync script populates
 * `packages/cortex/profiles/finance/` from that source on each release
 * build. The test prefers the synced copy when present and falls back
 * to the sibling ownware-profiles checkout. It skips when neither
 * exists (a fresh clone of just Cortex without the sibling repo).
 */
const OWNWARE_PROFILES_DIR = join(__dirname, '..', '..', '..', '..', '..', '..', 'ownware-profiles', 'profiles')
const SYNCED_DIR = join(__dirname, '..', '..', '..', 'profiles', 'finance')
const PROFILE_DIR = existsSync(SYNCED_DIR)
  ? SYNCED_DIR
  : join(OWNWARE_PROFILES_DIR, 'finance')

const profileExists = existsSync(PROFILE_DIR)

const EXPECTED_SKILL_TRIGGERS = [
  '/3sm',
  '/buyer-list',
  '/cim',
  '/client-review',
  '/comps',
  '/dcf',
  '/dd-checklist',
  '/docx',
  '/earnings',
  '/earnings-preview',
  '/financial-plan',
  '/ic-memo',
  '/initiate',
  '/kyc',
  '/lbo',
  '/merger-model',
  '/one-pager',
  '/pdf',
  '/portfolio-review',
  '/pptx',
  '/process-letter',
  '/rebalance',
  '/screen',
  '/sector',
  '/teaser',
  '/variance',
  '/xlsx',
]

const EXPECTED_HELPER_NAMES = [
  'deck-author',
  'diligence-runner',
  'earnings-reviewer',
  'filings-explorer',
  'market-researcher',
  'valuation-builder',
]

describe.skipIf(!profileExists)('finance builtin profile', () => {
  it('loads via loadProfile without error', async () => {
    const profile = await loadProfile(PROFILE_DIR)
    expect(profile.config.name).toBe('finance')
    expect(profile.config.kind).toBe('agent')
    expect(profile.config.description).toBeDefined()
    expect(profile.soulMd).toContain('Finance')
    expect(profile.agentsMd).toContain('Memory seed')
  })

  it(`discovers all ${EXPECTED_SKILL_TRIGGERS.length} skills with correct triggers`, async () => {
    const profile = await loadProfile(PROFILE_DIR)
    const triggers = profile.skills.map((s) => s.trigger).sort()
    expect(triggers).toEqual(EXPECTED_SKILL_TRIGGERS)
  })

  it(`declares ${EXPECTED_HELPER_NAMES.length} subagents`, async () => {
    const profile = await loadProfile(PROFILE_DIR)
    const names = profile.config.subagents.map((s) => s.name).sort()
    expect(names).toEqual(EXPECTED_HELPER_NAMES)
  })

  it('resolveLocalHelperDir finds each declared helper', async () => {
    const profile = await loadProfile(PROFILE_DIR)
    for (const sa of profile.config.subagents) {
      const dir = await resolveLocalHelperDir(profile.basePath, sa.name)
      expect(dir, `helper '${sa.name}' should resolve`).not.toBeNull()
    }
  })

  it('each helper loads cleanly with kind=helper', async () => {
    const profile = await loadProfile(PROFILE_DIR)
    for (const sa of profile.config.subagents) {
      const helperDir = await resolveLocalHelperDir(profile.basePath, sa.name)
      expect(helperDir).not.toBeNull()
      const helper = await loadLocalHelperProfile(helperDir!)
      expect(helper.config.kind).toBe('helper')
      expect(helper.config.name).toBe(sa.name)
      expect(helper.soulMd).toBeTruthy()
    }
  })

  it('returns null for unknown helper names + traversal attempts', async () => {
    const profile = await loadProfile(PROFILE_DIR)
    expect(await resolveLocalHelperDir(profile.basePath, 'does-not-exist')).toBeNull()
    expect(await resolveLocalHelperDir(profile.basePath, '../escape')).toBeNull()
    expect(await resolveLocalHelperDir(profile.basePath, '..')).toBeNull()
    expect(await resolveLocalHelperDir(profile.basePath, '')).toBeNull()
  })

  it('declares opus-4-7 main model with sonnet-4-6 helpers', async () => {
    const profile = await loadProfile(PROFILE_DIR)
    expect(profile.config.model).toBe('anthropic:claude-opus-4-7')

    for (const sa of profile.config.subagents) {
      const helperDir = await resolveLocalHelperDir(profile.basePath, sa.name)
      const helper = await loadLocalHelperProfile(helperDir!)
      expect(helper.config.model).toBe('anthropic:claude-sonnet-4-6')
    }
  })

  it('declares paid-feed secrets as optional with hint URLs', async () => {
    const profile = await loadProfile(PROFILE_DIR)
    const secrets = profile.config.metadata.requiredSecrets
    expect(secrets.length).toBeGreaterThanOrEqual(8)
    for (const s of secrets) {
      expect(s.required).toBe(false)
      expect(s.hint.length).toBeGreaterThan(0)
    }
  })
})
