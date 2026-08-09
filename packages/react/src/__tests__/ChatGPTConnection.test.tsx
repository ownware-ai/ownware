// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  CodexModelCatalog,
  CodexRuntimeStatus,
} from '@ownware/client'
import {
  ChatGPTConnection,
  type ChatGPTConnectionClient,
} from '../index.js'

afterEach(cleanup)

const runtime = {
  id: 'openai-codex',
  accessRoute: 'openai-chatgpt-managed',
  support: 'experimental',
  upstreamSupport: 'experimental_unsupported_for_production',
  processState: 'running',
  protocolVersion: '0.147.0',
  supportedVersionRange: '>=0.145.0 <0.146.0 || >=0.147.0 <0.148.0',
} as const

const signedOut: CodexRuntimeStatus = {
  runtime,
  account: {
    state: 'signed_out',
    requiresOpenaiAuth: true,
    authority: 'account/read',
    observedAt: '2026-08-09T00:00:00.000Z',
    validUntil: null,
  },
  login: { phase: 'idle' },
  quota: { state: 'unknown', reason: 'not_read', validUntil: null },
}

const authenticated: CodexRuntimeStatus = {
  runtime,
  account: {
    state: 'authenticated',
    authMode: 'chatgpt',
    plan: 'plus',
    requiresOpenaiAuth: true,
    authority: 'account/read',
    observedAt: '2026-08-09T00:00:01.000Z',
    validUntil: null,
  },
  login: { phase: 'succeeded' },
  quota: { state: 'unknown', reason: 'provider_stated_no_usable_limit', validUntil: null },
}

const pending: CodexRuntimeStatus = {
  ...signedOut,
  login: { phase: 'pending' },
}

const catalog: CodexModelCatalog = {
  authority: 'model/list',
  observedAt: '2026-08-09T00:00:02.000Z',
  validUntil: null,
  models: [{
    id: 'gpt-5.2-codex',
    model: 'gpt-5.2-codex',
    displayName: 'GPT-5.2 Codex',
    description: 'Coding model',
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: 'medium',
    reasoningEfforts: ['medium'],
    inputModalities: ['text'],
    serviceTiers: [],
    defaultServiceTier: null,
    supportsPersonality: false,
  }],
}

function client(overrides: Partial<ChatGPTConnectionClient> = {}): ChatGPTConnectionClient {
  return {
    codexRuntime: vi.fn(async () => signedOut),
    startCodexLogin: vi.fn(async () => ({
      kind: 'browser' as const,
      loginId: 'one-time-login',
      url: 'https://example.test/sign-in',
    })),
    waitForCodexLogin: vi.fn(async () => pending),
    cancelCodexLogin: vi.fn(async () => ({ ...signedOut, login: { phase: 'cancelled' as const } })),
    logoutCodex: vi.fn(async () => signedOut),
    codexModels: vi.fn(async () => catalog),
    ...overrides,
  }
}

describe('<ChatGPTConnection>', () => {
  it('shows the two routes honestly and keeps the unproven route disabled', async () => {
    render(<ChatGPTConnection client={client()} />)

    await screen.findByText('Not connected')
    expect(screen.getByText('Codex managed')).toBeTruthy()
    expect(screen.getByText('Experimental')).toBeTruthy()
    expect(screen.getByText('Direct transport')).toBeTruthy()
    expect(screen.getByText('Not enabled')).toBeTruthy()
    expect(screen.getByText(/does not read or copy your ChatGPT token/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect in browser' })).toBeTruthy()
  })

  it('presents one-time browser material, then renders redacted account and exact models', async () => {
    let resolveWait!: (status: CodexRuntimeStatus) => void
    const wait = vi.fn(() => new Promise<CodexRuntimeStatus>((resolve) => {
      resolveWait = resolve
    }))
    const transport = client({ waitForCodexLogin: wait })
    render(<ChatGPTConnection client={transport} />)
    await screen.findByText('Not connected')

    fireEvent.click(screen.getByRole('button', { name: 'Connect in browser' }))
    const link = await screen.findByRole('link', { name: /Open ChatGPT sign-in/ })
    expect(link.getAttribute('href')).toBe('https://example.test/sign-in')
    expect(wait).toHaveBeenCalledWith(20_000)

    resolveWait(authenticated)
    await screen.findByText('Connected')
    expect(screen.getByText('plus')).toBeTruthy()
    expect(screen.getByText('GPT-5.2 Codex')).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Open ChatGPT sign-in/ })).toBeNull()
    expect(document.body.textContent).not.toContain('one-time-login')
  })

  it('supports device-code login and clears the one-time code on cancellation', async () => {
    const transport = client({
      startCodexLogin: vi.fn(async () => ({
        kind: 'device' as const,
        loginId: 'device-attempt',
        verificationUrl: 'https://example.test/device',
        userCode: 'ABCD-EFGH',
      })),
    })
    render(<ChatGPTConnection client={transport} />)
    await screen.findByText('Not connected')

    fireEvent.click(screen.getByRole('button', { name: 'Use a code' }))
    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByText('ABCD-EFGH')).toBeNull())
    expect(transport.cancelCodexLogin).toHaveBeenCalledOnce()
  })

  it('shows a content-free recovery message when status inspection fails', async () => {
    render(<ChatGPTConnection client={client({
      codexRuntime: vi.fn(async () => { throw new Error('secret upstream detail') }),
    })} />)

    expect((await screen.findByRole('alert')).textContent).toContain('Could not inspect the local Codex connection.')
    expect(document.body.textContent).not.toContain('secret upstream detail')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })
})
