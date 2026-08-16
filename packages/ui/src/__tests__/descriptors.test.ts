import { describe, it, expect } from 'vitest'
import { describeToolCall, BUILTIN_DESCRIPTORS } from '../index.js'
import type { ToolCall } from '../index.js'

const call = (name: string, input: Record<string, unknown>, extra: Partial<ToolCall> = {}): ToolCall => ({
  id: 't1',
  name,
  input,
  status: 'done',
  ...extra,
})

describe('describeToolCall', () => {
  it('renders compatibility descriptors as operation labels, not effect claims', () => {
    const r = describeToolCall(call('writeFile', { file_path: 'src/rosa/SOUL.md', content: 'You are Rosa.' }))
    expect(r.verb).toBe('Write file')
    expect(r.primary).toBe('src/rosa/SOUL.md')
    expect(r.kind).toBe('file-write')
    expect(r.preview).toEqual({ text: 'You are Rosa.', format: 'code' })
    expect(r.conversational).toBe(false)
  })

  it('renders shell_execute with the command as headline and the result as the preview', () => {
    const r = describeToolCall(call('shell_execute', { command: 'npm test' }, { result: 'PASS 12 tests' }))
    expect(r.verb).toBe('Run command')
    expect(r.primary).toBe('npm test')
    // preview.contentField='output' isn't in input → falls back to the result string
    expect(r.preview).toEqual({ text: 'PASS 12 tests', format: 'plain' })
  })

  it('renders web_search + web_fetch (with an open URL)', () => {
    const s = describeToolCall(call('web_search', { query: 'flower shops' }, { result: '5 results' }))
    expect(s.verb).toBe('Search web')
    expect(s.primary).toBe('flower shops')

    const f = describeToolCall(call('web_fetch', { url: 'https://example.com' }, { result: '# Page' }))
    expect(f.verb).toBe('Fetch URL')
    expect(f.openUrl).toBe('https://example.com')
  })

  it('marks conversational tools (agent_spawn) as conversational', () => {
    const r = describeToolCall(call('agent_spawn', { subagent_type: 'researcher' }))
    expect(r.conversational).toBe(true)
    expect(r.verb).toBe('Delegate task')
    expect(r.primary).toBe('researcher')
  })

  it('falls back to the tool name + first input for unknown tools', () => {
    const r = describeToolCall(call('order_lookup', { query: 'order 1042' }, { result: 'found' }))
    expect(r.verb).toBe('order_lookup')
    expect(r.primary).toBe('order 1042')
    expect(r.preview).toEqual({ text: 'found', format: 'plain' })
  })

  it('lets a custom descriptor override the built-in map', () => {
    const r = describeToolCall(call('writeFile', { file_path: 'x' }), {
      kind: 'external-action',
      summary: { verb: 'Saved', primaryField: 'file_path' },
    })
    expect(r.verb).toBe('Saved')
  })

  it('prefers the exact event descriptor over the legacy name catalogue', () => {
    const r = describeToolCall(call('writeFile', { destination: 'x' }, {
      uiDescriptor: {
        kind: 'external-action',
        summary: { verb: 'Custom operation', primaryField: 'destination' },
      },
    }))
    expect(r).toMatchObject({ verb: 'Custom operation', primary: 'x' })
  })

  it('never exposes non-HTTP destinations as open links', () => {
    expect(describeToolCall(call('web_fetch', { url: 'javascript:alert(1)' })).openUrl).toBeUndefined()
    expect(describeToolCall(call('web_fetch', { url: 'data:text/html,unsafe' })).openUrl).toBeUndefined()
    expect(describeToolCall(call('web_fetch', { url: '/relative' })).openUrl).toBeUndefined()
  })

  it('ships descriptors for the core built-ins', () => {
    for (const name of ['readFile', 'writeFile', 'editFile', 'shell_execute', 'web_search', 'web_fetch', 'grep']) {
      expect(BUILTIN_DESCRIPTORS[name]).toBeTruthy()
    }
  })
})
