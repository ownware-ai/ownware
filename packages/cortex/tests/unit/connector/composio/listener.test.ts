/**
 * ComposioCompletionListener — mocked-client tests for each status path.
 */

import { describe, expect, it, vi } from 'vitest'
import { ComposioCompletionListener } from '../../../../src/connector/composio/listener.js'
import type { ComposioClient, ComposioConnectedAccount } from '../../../../src/connector/composio/client.js'
import {
  ConnectorNetworkError,
  ConnectorValidationError,
  ConnectorVendorError,
} from '../../../../src/connector/errors.js'

function makeAccount(status: ComposioConnectedAccount['status'], extra: Partial<ComposioConnectedAccount> = {}): ComposioConnectedAccount {
  return {
    id: 'ca_1',
    toolkit: { slug: 'github' },
    auth_config: { id: 'ac_1', is_composio_managed: true },
    status,
    ...extra,
  }
}

function makeClient(impl: Partial<Pick<ComposioClient, 'getConnectedAccount'>>): ComposioClient {
  return impl as unknown as ComposioClient
}

const unabortedSignal = new AbortController().signal

describe('ComposioCompletionListener.checkStatus', () => {
  it('maps INITIALIZING → pending', async () => {
    const l = new ComposioCompletionListener({
      client: makeClient({ getConnectedAccount: vi.fn(async () => makeAccount('INITIALIZING')) }),
    })
    const r = await l.checkStatus('ca_1', null, unabortedSignal)
    expect(r.status).toBe('pending')
  })

  it('maps INITIATED → pending', async () => {
    const l = new ComposioCompletionListener({
      client: makeClient({ getConnectedAccount: vi.fn(async () => makeAccount('INITIATED')) }),
    })
    expect((await l.checkStatus('ca_1', null, unabortedSignal)).status).toBe('pending')
  })

  it('maps ACTIVE → ready with metadata', async () => {
    const l = new ComposioCompletionListener({
      client: makeClient({ getConnectedAccount: vi.fn(async () => makeAccount('ACTIVE')) }),
    })
    const r = await l.checkStatus('ca_1', null, unabortedSignal)
    expect(r.status).toBe('ready')
    expect(r.status === 'ready' && r.completedMetadata).toMatchObject({
      composioConnectedAccountId: 'ca_1',
      composioAuthConfigId: 'ac_1',
      composioToolkitSlug: 'github',
    })
  })

  it('maps FAILED → failed with status_reason', async () => {
    const l = new ComposioCompletionListener({
      client: makeClient({
        getConnectedAccount: vi.fn(async () => makeAccount('FAILED', { status_reason: 'user denied' })),
      }),
    })
    const r = await l.checkStatus('ca_1', null, unabortedSignal)
    expect(r.status).toBe('failed')
    expect(r.status === 'failed' && r.errorReason).toBe('user denied')
  })

  it('maps EXPIRED → failed with actionable reason', async () => {
    const l = new ComposioCompletionListener({
      client: makeClient({ getConnectedAccount: vi.fn(async () => makeAccount('EXPIRED')) }),
    })
    const r = await l.checkStatus('ca_1', null, unabortedSignal)
    expect(r.status).toBe('failed')
    expect(r.status === 'failed' && r.errorReason).toMatch(/expired/i)
  })

  it('maps INACTIVE → failed', async () => {
    const l = new ComposioCompletionListener({
      client: makeClient({ getConnectedAccount: vi.fn(async () => makeAccount('INACTIVE')) }),
    })
    const r = await l.checkStatus('ca_1', null, unabortedSignal)
    expect(r.status).toBe('failed')
  })

  it('maps 404 ConnectorValidationError → not_found', async () => {
    const err = new ConnectorValidationError('HTTP 404 not found', { source: 'composio' })
    const l = new ComposioCompletionListener({
      client: makeClient({ getConnectedAccount: vi.fn(async () => { throw err }) }),
    })
    const r = await l.checkStatus('ca_1', null, unabortedSignal)
    expect(r.status).toBe('not_found')
  })

  it('maps network error → pending (transient)', async () => {
    const err = new ConnectorNetworkError('down', { source: 'composio' })
    const l = new ComposioCompletionListener({
      client: makeClient({ getConnectedAccount: vi.fn(async () => { throw err }) }),
    })
    expect((await l.checkStatus('ca_1', null, unabortedSignal)).status).toBe('pending')
  })

  it('rethrows ConnectorVendorError (terminal for the poller)', async () => {
    const err = new ConnectorVendorError('shape mismatch', { source: 'composio' })
    const l = new ComposioCompletionListener({
      client: makeClient({ getConnectedAccount: vi.fn(async () => { throw err }) }),
    })
    await expect(l.checkStatus('ca_1', null, unabortedSignal)).rejects.toBe(err)
  })

  it('returns pending when signal already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const getter = vi.fn()
    const l = new ComposioCompletionListener({ client: makeClient({ getConnectedAccount: getter }) })
    const r = await l.checkStatus('ca_1', null, ctrl.signal)
    expect(r.status).toBe('pending')
    expect(getter).not.toHaveBeenCalled()
  })

  it('source is "composio"', () => {
    const l = new ComposioCompletionListener({ client: makeClient({ getConnectedAccount: vi.fn() }) })
    expect(l.source).toBe('composio')
  })
})
