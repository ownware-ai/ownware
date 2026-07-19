import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { OwnwareClient } from '../client.js'
import {
  PCC04_PUBLIC_OPERATIONS,
  PCC04_PUBLIC_PROOFS,
  PCC04_UNHAPPY_STATES,
} from './source-lifecycle-coverage.js'

describe('PCC-04 public source-lifecycle ownership', () => {
  it('maps every published source operation and documents every SDK method', async () => {
    const openapi = await readFile(new URL('../../spec/openapi.yaml', import.meta.url), 'utf8')
    const sourceBlock = openapi.slice(
      openapi.indexOf('  /api/v1/sources:'),
      openapi.indexOf('  /api/v1/candidates/validate:'),
    )
    const sourceOperationIds = [...sourceBlock.matchAll(/^\s+operationId: (\S+)$/gm)]
      .map((match) => match[1]!)
    const prerequisites = ['capabilities', 'issueDelegation']
    expect(new Set(PCC04_PUBLIC_OPERATIONS.map((row) => row.operationId)).size)
      .toBe(PCC04_PUBLIC_OPERATIONS.length)
    expect(PCC04_PUBLIC_OPERATIONS.map((row) => row.operationId).sort())
      .toEqual([...sourceOperationIds, ...prerequisites].sort())

    const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8')
    const capabilitiesSource = await readFile(
      new URL('../../../cortex/src/gateway/handlers/capabilities.ts', import.meta.url),
      'utf8',
    )
    const publishedCapabilities = new Map(
      [...capabilitiesSource.matchAll(/\{ id: '([^']+)', version: (\d+) \}/g)]
        .map((match) => [match[1]!, Number(match[2])] as const),
    )
    const surfaceTable = readme.slice(
      readme.indexOf('| Method | Wire call |'),
      readme.indexOf('\n## ', readme.indexOf('| Method | Wire call |')),
    )
    for (const row of PCC04_PUBLIC_OPERATIONS) {
      expect(surfaceTable, `README surface omits ${row.sdkMethod}`)
        .toContain(`| \`${row.sdkMethod}`)
      expect(typeof OwnwareClient.prototype[row.sdkMethod], `${row.sdkMethod} is not implemented`)
        .toBe('function')
      expect(publishedCapabilities.get(row.capabilityId), row.capabilityId)
        .toBe(row.capabilityVersion)
      expect(PCC04_PUBLIC_PROOFS[row.proofId], row.proofId).toBeDefined()
    }
    expect(surfaceTable).toContain('`createSourceUploadSession(sourceId, input)`')
  })

  it('assigns every unhappy state to one safe proof seam', () => {
    expect(new Set(PCC04_UNHAPPY_STATES.map((row) => row.stateId)).size)
      .toBe(PCC04_UNHAPPY_STATES.length)
    for (const row of PCC04_UNHAPPY_STATES) {
      expect(row.proofFile).not.toBe('')
      expect(row.proofTitle).not.toBe('')
      if (row.seam === 'public') expect(row.reasonNotPublic).toBeUndefined()
      else expect(row.reasonNotPublic).toBeTruthy()
    }
  })

  it('resolves every public and unhappy proof to an exact checked-in test title', async () => {
    const proofs = [
      ...Object.values(PCC04_PUBLIC_PROOFS),
      ...PCC04_UNHAPPY_STATES.map((row) => ({
        proofFile: row.proofFile,
        proofTitle: row.proofTitle,
      })),
    ]
    for (const proof of proofs) {
      const contents = await readFile(
        new URL(`../../../../${proof.proofFile}`, import.meta.url),
        'utf8',
      )
      expect(contents, `${proof.proofFile} omits exact test title: ${proof.proofTitle}`)
        .toContain(`it('${proof.proofTitle}'`)
    }
  })
})
