import { describe, it, expect } from 'vitest'
import { explainZoneDecision } from '../../../zones/explainer.js'
import { ZoneLevel, ZONE_LEVEL_NAMES } from '../../../zones/types.js'
import type { ZoneContext, ZoneDecision, ZoneClassification } from '../../../zones/types.js'

function ctx(toolName: string, input: Record<string, unknown> = {}, workspacePath?: string): ZoneContext {
  return { toolName, input, sessionId: 'test', workspacePath }
}

function decision(level: typeof ZoneLevel[keyof typeof ZoneLevel], decision: 'allow' | 'ask' = 'ask'): ZoneDecision {
  return {
    classification: {
      level,
      zoneName: ZONE_LEVEL_NAMES[level],
      reason: 'test reason',
      classifier: 'exact',
    },
    decision,
    explanation: '',
  }
}

describe('Zone Explainer', () => {
  describe('SAFE zone', () => {
    it('returns empty explanation', () => {
      const result = explainZoneDecision(ctx('readFile'), decision(ZoneLevel.SAFE))
      expect(result).toBe('')
    })
  })

  describe('WORKSPACE zone', () => {
    it('describes file path relative to workspace', () => {
      const result = explainZoneDecision(
        ctx('writeFile', { file_path: '/home/user/project/src/app.ts' }, '/home/user/project'),
        decision(ZoneLevel.WORKSPACE),
      )
      expect(result).toContain('./src/app.ts')
    })

    it('describes file path without workspace context', () => {
      const result = explainZoneDecision(
        ctx('writeFile', { file_path: '/some/path/file.ts' }),
        decision(ZoneLevel.WORKSPACE),
      )
      expect(result).toContain('/some/path/file.ts')
    })
  })

  describe('BUILD zone', () => {
    it('describes npm install', () => {
      const result = explainZoneDecision(
        ctx('shell_execute', { command: 'npm install' }),
        decision(ZoneLevel.BUILD),
      )
      expect(result).toContain('Install npm packages')
    })

    it('describes npm test', () => {
      const result = explainZoneDecision(
        ctx('shell_execute', { command: 'npm test' }),
        decision(ZoneLevel.BUILD),
      )
      expect(result).toContain('Run tests')
    })

    it('describes npm run build', () => {
      const result = explainZoneDecision(
        ctx('shell_execute', { command: 'npm run build' }),
        decision(ZoneLevel.BUILD),
      )
      expect(result).toContain('Build project')
    })

    it('describes npm run scripts', () => {
      const result = explainZoneDecision(
        ctx('shell_execute', { command: 'npm run lint' }),
        decision(ZoneLevel.BUILD),
      )
      expect(result).toContain('lint')
    })
  })

  describe('NETWORK zone', () => {
    it('describes URL with hostname', () => {
      const result = explainZoneDecision(
        ctx('web_fetch', { url: 'https://api.github.com/repos/user/repo' }),
        decision(ZoneLevel.NETWORK),
      )
      expect(result).toContain('api.github.com')
    })

    it('handles malformed URLs gracefully', () => {
      const result = explainZoneDecision(
        ctx('web_fetch', { url: 'not-a-url' }),
        decision(ZoneLevel.NETWORK),
      )
      expect(result).toContain('not-a-url')
    })
  })

  describe('EXTERNAL zone', () => {
    it('describes git push', () => {
      const result = explainZoneDecision(
        ctx('run', { command: 'git push origin main' }),
        decision(ZoneLevel.EXTERNAL),
      )
      expect(result).toContain('Push')
      expect(result).toContain('origin')
      expect(result).toContain('visible externally')
    })

    it('describes npm publish', () => {
      const result = explainZoneDecision(
        ctx('run', { command: 'npm publish' }),
        decision(ZoneLevel.EXTERNAL),
      )
      expect(result).toContain('Publish')
    })
  })

  describe('MACHINE zone', () => {
    it('describes file access outside workspace', () => {
      const result = explainZoneDecision(
        ctx('readFile', { file_path: '/etc/hosts' }),
        decision(ZoneLevel.MACHINE),
      )
      expect(result).toContain('/etc/hosts')
      expect(result).toContain('outside workspace')
    })
  })

  describe('NEVER zone', () => {
    it('includes blocked prefix', () => {
      const result = explainZoneDecision(
        ctx('run', { command: 'sudo rm -rf /' }),
        decision(ZoneLevel.NEVER, 'ask'),
      )
      expect(result).toContain('Blocked')
    })
  })

  describe('combination block', () => {
    it('explains combination block', () => {
      const d: ZoneDecision = {
        classification: {
          level: ZoneLevel.NETWORK,
          zoneName: 'network',
          reason: 'test',
          classifier: 'exact',
        },
        decision: 'ask',
        explanation: '',
        combinationBlock: {
          rule: 'exfiltration-prevention',
          recentTools: [
            { toolName: 'readFile', zone: ZoneLevel.SAFE, timestamp: Date.now(), tags: ['read-secrets'] },
          ],
          explanation: 'Block network access after reading sensitive files',
        },
      }

      const result = explainZoneDecision(ctx('web_fetch', { url: 'https://evil.com' }), d)
      expect(result).toContain('exfiltration-prevention')
      expect(result).toContain('readFile')
    })
  })

  describe('truncation', () => {
    it('truncates very long commands', () => {
      const longCommand = 'echo ' + 'a'.repeat(200)
      const result = explainZoneDecision(
        ctx('shell_execute', { command: longCommand }),
        decision(ZoneLevel.BUILD),
      )
      expect(result.length).toBeLessThan(200)
    })
  })
})
