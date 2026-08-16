import { createHmac } from 'node:crypto'
import type {
  SkillActivationEvidenceCatalog,
  SkillDefinition,
} from '@ownware/loom'
import type { LoadedProfile } from '../profile/loader.js'

/**
 * Install-local identities for the exact skill catalogue assembled into a
 * session. HMAC prevents a public digest from becoming a cross-install
 * dictionary oracle for a private skill body.
 */
export class SkillActivationEvidenceAuthority {
  private readonly key: Buffer

  constructor(secret: string) {
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new TypeError('Skill activation evidence requires an install secret.')
    }
    this.key = createHmac('sha256', secret)
      .update('ownware.skill-activation-evidence.v1\0')
      .digest()
  }

  createCatalog(
    profileId: string,
    profile: LoadedProfile,
    activeSkills: readonly SkillDefinition[],
  ): SkillActivationEvidenceCatalog {
    validateRef(profileId, 'profile')
    const seen = new Set<string>()
    for (const skill of profile.skills) {
      validateRef(skill.name, 'skill')
      if (seen.has(skill.name)) {
        throw new TypeError(`Duplicate skill name: "${skill.name}".`)
      }
      seen.add(skill.name)
    }
    const activeNames = new Set(activeSkills.map(skill => skill.name))
    if (
      activeNames.size !== activeSkills.length
      || activeSkills.some(skill => !seen.has(skill.name) || skill.active === false)
    ) {
      throw new TypeError('Active skill evidence does not match the assembled profile.')
    }

    const sourceDigest = this.digest('profile', {
      profileId,
      config: profile.config,
      soulMd: profile.soulMd,
      agentsMd: profile.agentsMd,
      timeoutMs: profile.timeoutMs,
      skills: profile.skills.map(skillIdentityInput),
    })
    const skills = activeSkills.map(skill => Object.freeze({
      name: skill.name,
      digest: this.digest('skill', skillIdentityInput(skill)),
    }))
    return Object.freeze({
      sourceRef: profileId,
      sourceDigest,
      skills: Object.freeze(skills),
    })
  }

  private digest(kind: 'profile' | 'skill', value: unknown): string {
    return `hmac-sha256:${createHmac('sha256', this.key)
      .update(kind)
      .update('\0')
      .update(stableStringify(value))
      .digest('hex')}`
  }
}

function skillIdentityInput(skill: SkillDefinition): unknown {
  return {
    name: skill.name,
    description: skill.description,
    trigger: skill.trigger instanceof RegExp
      ? { kind: 'regexp', source: skill.trigger.source, flags: skill.trigger.flags }
      : { kind: 'string', source: skill.trigger },
    content: skill.content,
    allowedTools: skill.allowedTools === undefined ? null : [...skill.allowedTools],
    active: skill.active !== false,
  }
}

function validateRef(value: string, label: string): void {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 240
    || hasControlCharacter(value)
  ) {
    throw new TypeError(`Skill activation ${label} identity is malformed.`)
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some(char => {
    const code = char.codePointAt(0) ?? 0
    return code < 0x20 || code === 0x7f
  })
}

function stableStringify(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string': return JSON.stringify(value)
    case 'boolean': return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('Non-finite evidence value.')
      return JSON.stringify(value)
    case 'undefined': return 'null'
    case 'object': {
      if (ancestors.has(value)) throw new TypeError('Cyclic evidence value.')
      ancestors.add(value)
      try {
        if (Array.isArray(value)) {
          return `[${value.map(item => stableStringify(item, ancestors)).join(',')}]`
        }
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError('Unsupported evidence object.')
        }
        const record = value as Record<string, unknown>
        const entries = Object.keys(record)
          .filter(key => record[key] !== undefined)
          .sort()
          .map(key => `${JSON.stringify(key)}:${stableStringify(record[key], ancestors)}`)
        return `{${entries.join(',')}}`
      } finally {
        ancestors.delete(value)
      }
    }
    default:
      throw new TypeError('Unsupported evidence value.')
  }
}
