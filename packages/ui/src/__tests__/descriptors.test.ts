import { describe, it, expect } from 'vitest'
import { describeToolCall } from '../index.js'
import type { ToolCall, ToolUIDescriptor } from '../index.js'

const call = (name: string, input: Record<string, unknown>, extra: Partial<ToolCall> = {}): ToolCall => ({
  id: 't1',
  name,
  input,
  status: 'done',
  ...extra,
})

/**
 * Descriptors are supplied by the exact tool event, never looked up by name.
 * These fixtures stand in for that event payload; the package deliberately
 * exports no name-keyed catalogue a host could reach for instead.
 */
const FILE_WRITE: ToolUIDescriptor = {
  kind: 'file-write',
  summary: { verb: 'Write file', primaryField: 'file_path' },
  preview: { contentField: 'content', format: 'code', truncateAtLines: 10 },
  openAction: { target: 'file-pane', pathField: 'file_path' },
}
const SHELL: ToolUIDescriptor = {
  kind: 'shell',
  summary: { verb: 'Run command', primaryField: 'command' },
  preview: { contentField: 'output', format: 'plain', truncateAtLines: 10 },
}
const WEB_SEARCH: ToolUIDescriptor = {
  kind: 'search',
  summary: { verb: 'Search web', primaryField: 'query' },
  preview: { contentField: 'results', format: 'markdown', truncateAtLines: 10 },
}
const WEB_FETCH: ToolUIDescriptor = {
  kind: 'external-action',
  summary: { verb: 'Fetch URL', primaryField: 'url' },
  openAction: { target: 'url', pathField: 'url' },
}
const DELEGATE: ToolUIDescriptor = {
  kind: 'conversational',
  summary: { verb: 'Delegate task', primaryField: 'subagent_type' },
}

describe('describeToolCall', () => {
  it('renders a supplied descriptor as an operation label, not an effect claim', () => {
    const r = describeToolCall(
      call('writeFile', { file_path: 'src/rosa/SOUL.md', content: 'You are Rosa.' }),
      FILE_WRITE,
    )
    expect(r.verb).toBe('Write file')
    expect(r.primary).toBe('src/rosa/SOUL.md')
    expect(r.kind).toBe('file-write')
    expect(r.preview).toEqual({ text: 'You are Rosa.', format: 'code' })
    expect(r.conversational).toBe(false)
  })

  it('renders a shell descriptor with the command as headline and the result as the preview', () => {
    const r = describeToolCall(
      call('shell_execute', { command: 'npm test' }, { result: 'PASS 12 tests' }),
      SHELL,
    )
    expect(r.verb).toBe('Run command')
    expect(r.primary).toBe('npm test')
    // preview.contentField='output' isn't in input → falls back to the result string
    expect(r.preview).toEqual({ text: 'PASS 12 tests', format: 'plain' })
  })

  it('renders search + fetch descriptors (the latter with an open URL)', () => {
    const s = describeToolCall(
      call('web_search', { query: 'flower shops' }, { result: '5 results' }),
      WEB_SEARCH,
    )
    expect(s.verb).toBe('Search web')
    expect(s.primary).toBe('flower shops')

    const f = describeToolCall(
      call('web_fetch', { url: 'https://example.com' }, { result: '# Page' }),
      WEB_FETCH,
    )
    expect(f.verb).toBe('Fetch URL')
    expect(f.openUrl).toBe('https://example.com')
  })

  it('marks a conversational descriptor as conversational', () => {
    const r = describeToolCall(call('agent_spawn', { subagent_type: 'researcher' }), DELEGATE)
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

  it('uses an explicitly supplied compatibility descriptor', () => {
    const r = describeToolCall(call('writeFile', { file_path: 'x' }), {
      kind: 'external-action',
      summary: { verb: 'Saved', primaryField: 'file_path' },
    })
    expect(r.verb).toBe('Saved')
  })

  it('prefers the exact event descriptor without consulting a name catalogue', () => {
    const r = describeToolCall(call('writeFile', { destination: 'x' }, {
      uiDescriptor: {
        kind: 'external-action',
        summary: { verb: 'Custom operation', primaryField: 'destination' },
      },
    }))
    expect(r).toMatchObject({ verb: 'Custom operation', primary: 'x' })
  })

  it('never exposes non-HTTP destinations as open links', () => {
    expect(describeToolCall(call('web_fetch', { url: 'javascript:alert(1)' }), WEB_FETCH).openUrl).toBeUndefined()
    expect(describeToolCall(call('web_fetch', { url: 'data:text/html,unsafe' }), WEB_FETCH).openUrl).toBeUndefined()
    expect(describeToolCall(call('web_fetch', { url: '/relative' }), WEB_FETCH).openUrl).toBeUndefined()
  })

  it('gives a familiar built-in name no privileged rendering without its descriptor', () => {
    // A tool CALLED writeFile, from any source, is not a file write to this
    // package. Without an exact descriptor it is a generic external action
    // under its own name — no kind, no open action, no shell prefix.
    for (const name of ['readFile', 'writeFile', 'editFile', 'shell_execute', 'web_search', 'web_fetch', 'grep']) {
      const r = describeToolCall(call(name, { file_path: '/etc/passwd', command: 'rm -rf /' }))
      expect(r.verb).toBe(name)
      expect(r.kind).toBe('external-action')
      expect(r.openUrl).toBeUndefined()
    }
  })

  it('gives a misleading new tool name no semantics it did not declare', () => {
    const r = describeToolCall(call('write_file_then_charge_card', {
      file_path: '/tmp/invoice.txt',
      command: 'charge --amount 9999',
    }))
    expect(r.verb).toBe('write_file_then_charge_card')
    expect(r.kind).toBe('external-action')
    expect(r.conversational).toBe(false)
    expect(r.openUrl).toBeUndefined()
  })
})
