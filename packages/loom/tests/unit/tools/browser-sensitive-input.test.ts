import { describe, expect, it } from 'vitest'
import {
  BROWSER_SENSITIVE_INPUT_ADAPTER_REVISION,
  captureBrowserSensitiveInputBinding,
  inspectDeclaredSensitiveField,
  prepareBrowserSensitiveInputBinding,
  type BrowserConnection,
} from '../../../src/tools/builtins/browser-session.js'

interface FakeInput {
  tagName: 'INPUT'
  isConnected: boolean
  type: string
  autocomplete: string
  disabled: boolean
  readOnly: boolean
  attributes: Map<string, string>
  setAttribute(name: string, value: string): void
}

function input(attributes: Partial<FakeInput> = {}): FakeInput {
  const result: FakeInput = {
    tagName: 'INPUT',
    isConnected: true,
    type: 'text',
    autocomplete: '',
    disabled: false,
    readOnly: false,
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value) },
    ...attributes,
  }
  return result
}

function pageFor(element: FakeInput, url = 'https://accounts.example.test/login') {
  const locator = {
    count: async () => 1,
    evaluate: async (fn: (element: FakeInput, token?: string) => unknown, token?: string) =>
      fn(element, token),
  }
  return {
    locator: () => locator,
    url: () => url,
    on: () => undefined,
    context: () => ({
      newCDPSession: async () => ({
        send: async () => ({ targetInfo: { targetId: 'target-1' } }),
        detach: async () => undefined,
      }),
    }),
  }
}

describe('browser sensitive-input structural binding', () => {
  it.each([
    [input({ type: 'password' }), 'password'],
    [input({ autocomplete: 'one-time-code' }), 'one-time-code'],
    [input({ autocomplete: 'section-checkout cc-number' }), 'credit-card-number'],
    [input({ autocomplete: 'cc-csc' }), 'credit-card-security-code'],
  ] as const)('classifies supported declarations at the live element', async (element, kind) => {
    await expect(inspectDeclaredSensitiveField(pageFor(element) as never, {
      selector: '#field',
    })).resolves.toBe(kind)
  })

  it('does not claim that labels or arbitrary text fields prove sensitivity', async () => {
    await expect(inspectDeclaredSensitiveField(pageFor(input({
      type: 'text',
      autocomplete: 'email',
    })) as never, { selector: '#password-looking-label' })).resolves.toBeNull()
  })

  it('captures exact origin, CDP target, document and element marker', async () => {
    const element = input({ type: 'password' })
    const page = pageFor(element)
    const connection = {
      cdpUrl: 'http://127.0.0.1:9222',
      browser: {},
      connectedAt: 1,
    } as BrowserConnection

    const captured = await captureBrowserSensitiveInputBinding(
      connection,
      page as never,
      { selector: '#password', submit: true },
    )

    expect(captured).toMatchObject({
      kind: 'browser-field',
      revision: BROWSER_SENSITIVE_INPUT_ADAPTER_REVISION,
      cdpUrl: connection.cdpUrl,
      origin: 'https://accounts.example.test',
      targetId: 'target-1',
      fieldKind: 'password',
      submit: true,
    })
    expect(captured.documentId).not.toHaveLength(0)
    expect(element.attributes.get('data-ownware-sensitive-target'))
      .toBe(captured.elementToken)
    expect(Object.isFrozen(captured)).toBe(true)
  })

  it('rejects malformed or caller-invented adapter-private bindings', () => {
    expect(() => prepareBrowserSensitiveInputBinding({
      kind: 'browser-field',
      revision: 'made-up-revision',
    })).toThrow('malformed')
    expect(() => prepareBrowserSensitiveInputBinding({
      kind: 'browser-field',
      revision: BROWSER_SENSITIVE_INPUT_ADAPTER_REVISION,
      cdpUrl: 'http://127.0.0.1:9222',
      origin: 'javascript:alert(1)',
      targetId: 'target-1',
      documentId: 'document-1',
      elementToken: 'element-1',
      fieldKind: 'password',
      submit: false,
    } as never)).toThrow('canonical HTTP(S)')
  })
})
