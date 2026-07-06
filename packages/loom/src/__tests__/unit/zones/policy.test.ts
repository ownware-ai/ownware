import { describe, it, expect } from 'vitest'
import { evaluateZonePolicy } from '../../../zones/policy.js'
import { ZoneLevel, ZONE_LEVEL_NAMES } from '../../../zones/types.js'
import { ZONE_CONFIGS } from '../../../zones/defaults.js'
import type { ZoneClassification } from '../../../zones/types.js'

function classification(level: typeof ZoneLevel[keyof typeof ZoneLevel]): ZoneClassification {
  return {
    level,
    zoneName: ZONE_LEVEL_NAMES[level],
    reason: 'test',
    classifier: 'exact',
  }
}

describe('Zone Policy', () => {
  describe('NEVER zone', () => {
    it('always asks regardless of security level (post-redesign: user decides, never auto-deny)', () => {
      for (const level of ['permissive', 'standard', 'strict', 'paranoid'] as const) {
        expect(evaluateZonePolicy(classification(ZoneLevel.NEVER), ZONE_CONFIGS[level])).toBe('ask')
      }
    })
  })

  describe('permissive level', () => {
    const config = ZONE_CONFIGS.permissive
    // maxAutoZone: NETWORK (3), maxAskZone: MACHINE (5)

    it('auto-allows SAFE', () => {
      expect(evaluateZonePolicy(classification(ZoneLevel.SAFE), config)).toBe('allow')
    })

    it('auto-allows WORKSPACE', () => {
      expect(evaluateZonePolicy(classification(ZoneLevel.WORKSPACE), config)).toBe('allow')
    })

    it('auto-allows BUILD', () => {
      expect(evaluateZonePolicy(classification(ZoneLevel.BUILD), config)).toBe('allow')
    })

    it('auto-allows NETWORK', () => {
      expect(evaluateZonePolicy(classification(ZoneLevel.NETWORK), config)).toBe('allow')
    })

    it('asks for EXTERNAL', () => {
      expect(evaluateZonePolicy(classification(ZoneLevel.EXTERNAL), config)).toBe('ask')
    })

    it('asks for MACHINE', () => {
      expect(evaluateZonePolicy(classification(ZoneLevel.MACHINE), config)).toBe('ask')
    })
  })

  describe('standard level', () => {
    const config = ZONE_CONFIGS.standard
    // maxAutoZone: WORKSPACE (1), maxAskZone: MACHINE (5)

    it('auto-allows SAFE', () => {
      expect(evaluateZonePolicy(classification(ZoneLevel.SAFE), config)).toBe('allow')
    })

    it('auto-allows WORKSPACE', () => {
      expect(evaluateZonePolicy(classification(ZoneLevel.WORKSPACE), config)).toBe('allow')
    })

    it('asks for BUILD', () => {
      expect(evaluateZonePolicy(classification(ZoneLevel.BUILD), config)).toBe('ask')
    })

    it('asks for NETWORK', () => {
      expect(evaluateZonePolicy(classification(ZoneLevel.NETWORK), config)).toBe('ask')
    })

    it('asks for EXTERNAL', () => {
      expect(evaluateZonePolicy(classification(ZoneLevel.EXTERNAL), config)).toBe('ask')
    })

    it('asks for MACHINE (read outside workspace)', () => {
      expect(evaluateZonePolicy(classification(ZoneLevel.MACHINE), config)).toBe('ask')
    })

    it('asks for NEVER (post-redesign: critical-severity prompt, never auto-deny)', () => {
      expect(evaluateZonePolicy(classification(ZoneLevel.NEVER), config)).toBe('ask')
    })
  })

  describe('strict level', () => {
    const config = ZONE_CONFIGS.strict
    // maxAutoZone: SAFE (0), maxAskZone: BUILD (2)

    it('auto-allows SAFE', () => {
      expect(evaluateZonePolicy(classification(ZoneLevel.SAFE), config)).toBe('allow')
    })

    it('asks for WORKSPACE', () => {
      expect(evaluateZonePolicy(classification(ZoneLevel.WORKSPACE), config)).toBe('ask')
    })

    it('asks for BUILD', () => {
      expect(evaluateZonePolicy(classification(ZoneLevel.BUILD), config)).toBe('ask')
    })

    it('asks for NETWORK (post-redesign: above-threshold zones ask, never deny)', () => {
      expect(evaluateZonePolicy(classification(ZoneLevel.NETWORK), config)).toBe('ask')
    })

    it('asks for EXTERNAL', () => {
      expect(evaluateZonePolicy(classification(ZoneLevel.EXTERNAL), config)).toBe('ask')
    })

    it('asks for MACHINE', () => {
      expect(evaluateZonePolicy(classification(ZoneLevel.MACHINE), config)).toBe('ask')
    })
  })

  describe('paranoid level', () => {
    const config = ZONE_CONFIGS.paranoid
    // maxAutoZone: SAFE (0), maxAskZone: SAFE (0)

    it('auto-allows SAFE', () => {
      expect(evaluateZonePolicy(classification(ZoneLevel.SAFE), config)).toBe('allow')
    })

    it('asks for WORKSPACE (post-redesign: paranoid still asks rather than auto-denying)', () => {
      expect(evaluateZonePolicy(classification(ZoneLevel.WORKSPACE), config)).toBe('ask')
    })

    it('asks for BUILD', () => {
      expect(evaluateZonePolicy(classification(ZoneLevel.BUILD), config)).toBe('ask')
    })

    it('asks for everything above SAFE', () => {
      for (const level of [ZoneLevel.NETWORK, ZoneLevel.EXTERNAL, ZoneLevel.MACHINE]) {
        expect(evaluateZonePolicy(classification(level), config)).toBe('ask')
      }
    })
  })

  describe('boundary conditions', () => {
    it('zone exactly at maxAutoZone threshold is allowed', () => {
      // standard: maxAutoZone = WORKSPACE (1)
      expect(evaluateZonePolicy(classification(ZoneLevel.WORKSPACE), ZONE_CONFIGS.standard)).toBe('allow')
    })

    it('zone one above maxAutoZone is asked', () => {
      // standard: maxAutoZone = WORKSPACE (1), so BUILD (2) should ask
      expect(evaluateZonePolicy(classification(ZoneLevel.BUILD), ZONE_CONFIGS.standard)).toBe('ask')
    })

    it('zone exactly at maxAskZone threshold is asked', () => {
      // standard: maxAskZone = MACHINE (5)
      expect(evaluateZonePolicy(classification(ZoneLevel.MACHINE), ZONE_CONFIGS.standard)).toBe('ask')
    })

    it('zone above maxAskZone still asks (post-redesign: no above-threshold deny)', () => {
      // standard: maxAskZone = MACHINE (5). Pre-redesign NEVER (6) denied;
      // now it asks with critical severity so the user always sees the prompt.
      expect(evaluateZonePolicy(classification(ZoneLevel.NEVER), ZONE_CONFIGS.standard)).toBe('ask')
    })
  })
})
