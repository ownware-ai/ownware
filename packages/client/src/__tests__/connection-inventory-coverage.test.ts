import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { OwnwareClient } from '../client.js'
import { PCC05_CONNECTION_INVENTORY } from './connection-inventory-coverage.js'

describe('PCC-05 owner connection-inventory ownership', () => {
  it('keeps operation, capability, SDK, docs and black-box proof as one release seam', async () => {
    const [openapi, capabilities, readme, compatibility, proof] = await Promise.all([
      readFile(new URL('../../spec/openapi.yaml', import.meta.url), 'utf8'),
      readFile(
        new URL('../../../cortex/src/gateway/handlers/capabilities.ts', import.meta.url),
        'utf8',
      ),
      readFile(new URL('../../README.md', import.meta.url), 'utf8'),
      readFile(new URL('../../COMPATIBILITY.md', import.meta.url), 'utf8'),
      readFile(
        new URL(`../../../../${PCC05_CONNECTION_INVENTORY.proofFile}`, import.meta.url),
        'utf8',
      ),
    ])

    expect(openapi).toContain(`operationId: ${PCC05_CONNECTION_INVENTORY.operationId}`)
    expect(capabilities).toContain(
      `{ id: '${PCC05_CONNECTION_INVENTORY.capabilityId}', version: ${PCC05_CONNECTION_INVENTORY.capabilityVersion} }`,
    )
    expect(typeof OwnwareClient.prototype[PCC05_CONNECTION_INVENTORY.sdkMethod]).toBe('function')
    expect(readme).toContain('| `connections(options?)` | `GET /api/v1/connections` |')
    expect(compatibility).toContain('| `0.29.0` | Owner-only provider-neutral connection inventory')
    expect(proof).toContain(`it('${PCC05_CONNECTION_INVENTORY.proofTitle}'`)
  })
})
