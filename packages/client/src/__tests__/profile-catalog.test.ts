import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { OwnwareClient, OwnwareError } from '../client.js'

function clientFor(body: unknown, status = 200): OwnwareClient {
  return clientForRaw(JSON.stringify(body), status)
}

function clientForRaw(responseBody: string, status = 200): OwnwareClient {
  const injectedFetch: typeof fetch = async () => new Response(responseBody, {
    status,
    headers: { 'content-type': 'application/json' },
  })
  return new OwnwareClient({
    baseUrl: 'https://127.0.0.1:4444',
    fetch: injectedFetch,
  })
}

async function expectInvalid(body: unknown): Promise<void> {
  const thrown = await clientFor(body).profiles().catch((error: unknown) => error)
  expect(thrown).toBeInstanceOf(OwnwareError)
  expect(thrown).toMatchObject({
    message: 'Ownware profile catalog response was invalid',
    status: 200,
    code: 'profile_catalog_invalid',
    category: 'validation',
  })
  expect(String(thrown)).not.toContain(JSON.stringify(body))
}

describe('OwnwareClient profile catalog conformance', () => {
  it('accepts the exact empty top-level array', async () => {
    await expect(clientFor([]).profiles()).resolves.toEqual([])
  })

  it('accepts one valid public summary and preserves owner-safe extensions', async () => {
    const candidateId = `sha256:${'a'.repeat(64)}`
    const summary = {
      id: 'portable',
      name: 'portable',
      displayName: 'Portable',
      description: 'A portable profile',
      availability: 'available',
      activeCandidateId: candidateId,
      deploymentRevision: 2,
      health: 'healthy',
      healthObservedAt: 100,
      requiredCapabilities: ['shell'],
      findings: [],
      productId: 'ownware',
      readOnly: false,
    }
    await expect(clientFor([summary]).profiles()).resolves.toEqual([summary])
  })

  it('accepts an identity at the documented 128-character boundary', async () => {
    const summary = { id: 'p'.repeat(128) }
    await expect(clientFor([summary]).profiles()).resolves.toEqual([summary])
  })

  it.each([
    ['object', {}],
    ['legacy wrapper', { profiles: [] }],
    ['null', null],
    ['string', 'profiles'],
    ['number', 1],
    ['object with an unrelated array', { items: [] }],
  ])('rejects a non-array %s top level', async (_label, body) => {
    await expectInvalid(body)
  })

  it.each([
    ['missing identity', {}],
    ['array item', []],
    ['non-string identity', { id: 7 }],
    ['empty identity', { id: '' }],
    ['over-bound identity', { id: 'p'.repeat(129) }],
    ['invalid availability', { id: 'portable', availability: 'ready' }],
    ['invalid candidate identity', { id: 'portable', activeCandidateId: 'candidate' }],
    ['invalid deployment revision', { id: 'portable', deploymentRevision: 0 }],
    ['invalid health observation', { id: 'portable', healthObservedAt: 1.5 }],
    ['invalid capabilities', { id: 'portable', requiredCapabilities: ['shell', 1] }],
    ['invalid finding', { id: 'portable', findings: [{ code: 'bad', severity: 'fatal', message: 'bad' }] }],
  ])('rejects a malformed item with %s', async (_label, item) => {
    await expectInvalid([item])
  })

  it.each([
    ['exact duplicate', [{ id: 'portable' }, { id: 'portable' }]],
    ['case collision', [{ id: 'Portable' }, { id: 'portable' }]],
  ])('rejects %s identities', async (_label, body) => {
    await expectInvalid(body)
  })

  it('maps invalid JSON to the same content-free validation error', async () => {
    const thrown = await clientForRaw('{not-json').profiles().catch((error: unknown) => error)
    expect(thrown).toMatchObject({
      message: 'Ownware profile catalog response was invalid',
      status: 200,
      code: 'profile_catalog_invalid',
      category: 'validation',
    })
  })

  it('keeps the OpenAPI top-level array and public identity bounds aligned', async () => {
    const openapi = await readFile(new URL('../../spec/openapi.yaml', import.meta.url), 'utf8')
    const route = openapi.slice(
      openapi.indexOf('  /api/v1/profiles:'),
      openapi.indexOf('  /api/v1/profile-candidates/'),
    )
    const summary = openapi.slice(
      openapi.indexOf('    PublicProfileSummary:'),
      openapi.indexOf('    DelegatedPrincipal:'),
    )
    expect(route).toContain('operationId: listProfiles')
    expect(route).toContain('type: array')
    expect(summary).toContain('id: { type: string, minLength: 1, maxLength: 128 }')
  })

  it('preserves the existing typed non-success response behavior', async () => {
    const body = {
      error: 'forbidden',
      message: 'Profile access is forbidden',
      category: 'permission',
      correlationId: '97b156b8-5957-4215-ad2e-80ad4af09238',
    }
    const thrown = await clientFor(body, 403).profiles().catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(OwnwareError)
    expect(thrown).toMatchObject({
      message: 'Profile access is forbidden',
      status: 403,
      code: 'forbidden',
      category: 'permission',
      correlationId: body.correlationId,
    })
  })
})
