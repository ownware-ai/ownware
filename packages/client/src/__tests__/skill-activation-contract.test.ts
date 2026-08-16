import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { OwnwareClient } from '../client.js'

describe('skill activation public contract', () => {
  it('publishes one capability, SDK read, receipt schema and metadata-only event', async () => {
    const [openapi, asyncapi, compatibility, readme, capabilities] = await Promise.all([
      readFile(new URL('../../spec/openapi.yaml', import.meta.url), 'utf8'),
      readFile(new URL('../../spec/asyncapi.yaml', import.meta.url), 'utf8'),
      readFile(new URL('../../COMPATIBILITY.md', import.meta.url), 'utf8'),
      readFile(new URL('../../README.md', import.meta.url), 'utf8'),
      readFile(
        new URL('../../../cortex/src/gateway/handlers/capabilities.ts', import.meta.url),
        'utf8',
      ),
    ])

    expect(typeof OwnwareClient.prototype.listSkillActivationReceipts).toBe('function')
    expect(capabilities).toContain("{ id: 'runs.skill-activations.read', version: 1 }")
    expect(openapi).toContain('/api/v1/runs/{runId}/skill-activation-receipts:')
    expect(openapi).toContain('operationId: listSkillActivationReceipts')
    expect(openapi).toContain("$ref: '#/components/schemas/SkillActivationReceiptPage'")
    expect(openapi).toContain('SkillActivationReceipt:')
    expect(asyncapi).toContain('name: skill.activation')
    expect(asyncapi).toContain('additionalProperties: false')
    expect(compatibility).toContain('| `0.44.0` | Exact, immutable skill-activation receipts')
    expect(compatibility).toContain('not proof of provider processing or behavioral compliance')
    expect(readme).toContain('`listSkillActivationReceipts(runId, options?)`')

    const forbiddenPayloadFields = ['content', 'body', 'args', 'description']
    const receiptSchema = openapi.slice(
      openapi.indexOf('    SkillActivationReceipt:'),
      openapi.indexOf('    SkillActivationReceiptPage:'),
    )
    for (const field of forbiddenPayloadFields) {
      expect(receiptSchema).not.toContain(`\n        ${field}:`)
    }
  })
})
