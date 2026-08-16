import { describe, expect, it } from 'vitest'
import {
  BROWSER_SENSITIVE_INPUT_ADAPTER_REVISION,
  injectBrowserSensitiveInput,
  type BrowserSensitiveInputBinding,
} from '@ownware/loom'
import { createBrowserSensitiveInputAdapter } from '../../../src/gateway/browser-sensitive-input-adapter.js'

const binding: BrowserSensitiveInputBinding = {
  kind: 'browser-field',
  revision: BROWSER_SENSITIVE_INPUT_ADAPTER_REVISION,
  cdpUrl: 'http://127.0.0.1:9222',
  origin: 'https://accounts.example.test',
  targetId: 'target-1',
  documentId: 'document-1',
  elementToken: 'element-1',
  fieldKind: 'password',
  submit: false,
}

describe('browser sensitive-input adapter', () => {
  it('prepares an immutable root target and binds the real injector', () => {
    const adapter = createBrowserSensitiveInputAdapter({
      hasActiveHelpers: () => false,
      isEphemeralManagedContext: cdpUrl => cdpUrl === binding.cdpUrl,
    })
    const prepared = adapter.prepare(binding, {
      runId: 'run-1',
      toolCallId: 'call-1',
      agentId: null,
    })

    expect(prepared).toEqual(binding)
    expect(Object.isFrozen(prepared)).toBe(true)
    expect(adapter.inject).toBe(injectBrowserSensitiveInput)
  })

  it('rejects helpers and concurrent helper ownership before a request exists', () => {
    const rootOnly = createBrowserSensitiveInputAdapter({
      hasActiveHelpers: () => false,
      isEphemeralManagedContext: () => true,
    })
    expect(() => rootOnly.prepare(binding, {
      runId: 'run-1',
      toolCallId: 'call-1',
      agentId: 'helper-1',
    })).toThrow('exclusively owned root browser session')

    const busy = createBrowserSensitiveInputAdapter({
      hasActiveHelpers: () => true,
      isEphemeralManagedContext: () => true,
    })
    expect(() => busy.prepare(binding, {
      runId: 'run-1',
      toolCallId: 'call-1',
      agentId: null,
    })).toThrow('exclusively owned root browser session')
  })

  it('rejects an unowned or persistent browser context before a request exists', () => {
    const adapter = createBrowserSensitiveInputAdapter({
      hasActiveHelpers: () => false,
      isEphemeralManagedContext: () => false,
    })
    expect(() => adapter.prepare(binding, {
      runId: 'run-1',
      toolCallId: 'call-1',
      agentId: null,
    })).toThrow('exact live ephemeral managed browser context')
  })
})
