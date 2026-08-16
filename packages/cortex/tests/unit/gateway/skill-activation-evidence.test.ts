import { afterEach, describe, expect, it } from 'vitest'
import { SkillActivationEvidenceAuthority } from '../../../src/gateway/skill-activation-evidence.js'
import { loadProfile } from '../../../src/profile/loader.js'
import { createTempProfile } from '../../helpers/fixtures.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function profileWithSkill(content: string) {
  const temp = await createTempProfile({
    'agent.json': JSON.stringify({ name: 'evidence-profile' }),
    'SOUL.md': 'PRIVATE_SOUL_BODY',
    'skills/unfamiliar.md': [
      '---',
      'name: unfamiliar',
      'description: Exact unfamiliar workflow',
      'trigger: /unfamiliar',
      '---',
      content,
    ].join('\n'),
  })
  cleanups.push(temp.cleanup)
  return loadProfile(temp.dir)
}

describe('SkillActivationEvidenceAuthority', () => {
  it('creates stable install-local opaque identities for the exact loaded bytes', async () => {
    const profile = await profileWithSkill('PRIVATE_SKILL_BODY_A')
    const first = new SkillActivationEvidenceAuthority('install-secret-a')
      .createCatalog('profile-a', profile, profile.skills)
    const repeated = new SkillActivationEvidenceAuthority('install-secret-a')
      .createCatalog('profile-a', profile, profile.skills)
    const otherInstall = new SkillActivationEvidenceAuthority('install-secret-b')
      .createCatalog('profile-a', profile, profile.skills)

    expect(repeated).toEqual(first)
    expect(otherInstall.sourceDigest).not.toBe(first.sourceDigest)
    expect(otherInstall.skills[0]!.digest).not.toBe(first.skills[0]!.digest)
    expect(first).toMatchObject({
      sourceRef: 'profile-a',
      sourceDigest: expect.stringMatching(/^hmac-sha256:[0-9a-f]{64}$/),
      skills: [{
        name: 'unfamiliar',
        digest: expect.stringMatching(/^hmac-sha256:[0-9a-f]{64}$/),
      }],
    })
    expect(JSON.stringify(first)).not.toContain('PRIVATE_SKILL_BODY_A')
    expect(JSON.stringify(first)).not.toContain('PRIVATE_SOUL_BODY')
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.skills)).toBe(true)
  })

  it('changes both profile and skill identity when the skill body changes', async () => {
    const firstProfile = await profileWithSkill('PRIVATE_SKILL_BODY_A')
    const secondProfile = await profileWithSkill('PRIVATE_SKILL_BODY_B')
    const authority = new SkillActivationEvidenceAuthority('install-secret-a')
    const first = authority.createCatalog('profile-a', firstProfile, firstProfile.skills)
    const second = authority.createCatalog('profile-a', secondProfile, secondProfile.skills)
    expect(second.sourceDigest).not.toBe(first.sourceDigest)
    expect(second.skills[0]!.digest).not.toBe(first.skills[0]!.digest)
  })

  it('rejects duplicate, disabled and catalogue-mismatched inputs', async () => {
    const profile = await profileWithSkill('body')
    const skill = profile.skills[0]!
    const authority = new SkillActivationEvidenceAuthority('install-secret-a')
    expect(() => authority.createCatalog('profile-a', {
      ...profile,
      skills: [skill, { ...skill }],
    }, [skill])).toThrow(/Duplicate skill name/)
    expect(() => authority.createCatalog('profile-a', profile, [
      { ...skill, name: 'unknown' },
    ])).toThrow(/does not match/)
    expect(() => authority.createCatalog('profile-a', {
      ...profile,
      skills: [{ ...skill, active: false }],
    }, [{ ...skill, active: false }])).toThrow(/does not match/)
  })
})
