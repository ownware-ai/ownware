/**
 * Showcase demo — every tool-card kind the kit renders, in one chat.
 *   bun build packages/react/demo/main-showcase.tsx --outfile /tmp/ow-showcase.js
 */
import { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { OwnwareChat, type AgentTransport } from '@ownware/react'
import type { AgentEvent, ToolUIDescriptor } from '@ownware/ui'

// A custom (non-built-in) tool — demonstrates the `descriptors` prop.
const CUSTOM: Record<string, ToolUIDescriptor> = {
  delete_order: { kind: 'external-action', summary: { verb: 'Deleted order', primaryField: 'order_id' } },
}

interface Chan { q: AgentEvent[]; wake: (() => void) | null }

function makeFake(): AgentTransport {
  const ch: Chan = { q: [], wake: null }
  let seq = 0
  const push = (type: string, data: Record<string, unknown>) => { ch.q.push({ type, seq: ++seq, data }); ch.wake?.(); ch.wake = null }
  const tool = (id: string, name: string, input: Record<string, unknown>, result: string, isError = false, ms = 120) => {
    push('tool.call.start', { toolCallId: id, toolName: name, input })
    setTimeout(() => push('tool.call.end', { toolCallId: id, toolName: name, result, isError, durationMs: ms }), 120)
  }
  return {
    async run({ prompt }) {
      if (/slack|connect/i.test(prompt)) {
        setTimeout(() => push('permission.request', { requestId: 'r1', toolName: 'slack_connect', reason: 'read + reply in #support only' }), 150)
        return { threadId: 't' }
      }
      let t = 150
      const at = (fn: () => void) => { setTimeout(fn, t); t += 300 }
      at(() => tool('a', 'web_search', { query: 'flower delivery bangalore' }, '1. Bloom & Stem\n2. Petal Post\n3. Fern & Co'))
      at(() => tool('b', 'web_fetch', { url: 'https://bloomandstem.com/delivery' }, '# Delivery\nSame-day within 8km.'))
      at(() => tool('c', 'writeFile', { file_path: 'rosa/SOUL.md', content: 'You are Rosa, the warm voice of Bloom & Stem.\nAnswer only from real shop info.' }, 'ok', false, 22))
      at(() => tool('d', 'editFile', { file_path: 'rosa/agent.json', new_string: '  "model": "openrouter:anthropic/claude-3.5-sonnet",\n- "model": "ollama:llama3.2",\n+ "temperature": 0.4' }, 'ok', false, 18))
      at(() => tool('e', 'shell_execute', { command: 'ownware serve --port 4000' }, 'Ownware gateway running on http://127.0.0.1:4000\nLISTENING', false, 340))
      at(() => tool('f', 'grep', { pattern: 'delivery', path: 'notes' }, 'notes/delivery.md: same-day before 4pm\nnotes/zones.md: Whitefield 10–2', false, 30))
      at(() => tool('g', 'memory_store', { content: 'Customer prefers same-day delivery to Whitefield' }, 'remembered'))
      at(() => tool('h', 'agent_spawn', { subagent_type: 'researcher' }, 'done'))
      at(() => tool('i', 'delete_order', { order_id: '1042' }, 'permission denied', true, 12))
      at(() => {
        const words = 'Done — I searched, saved your SOUL file, updated the model, and stored your delivery preference. One action was blocked, as it should be.'.split(' ')
        words.forEach((w, i) => setTimeout(() => push('text.delta', { text: (i ? ' ' : '') + w }), i * 40))
        setTimeout(() => push('turn.end', { stopReason: 'end_turn' }), words.length * 40 + 100)
      })
      return { threadId: 't' }
    },
    async *events(_t, opts) {
      const signal = opts?.signal
      for (;;) {
        while (ch.q.length) yield ch.q.shift()!
        if (signal?.aborted) return
        await new Promise<void>((r) => { ch.wake = r; signal?.addEventListener('abort', () => r(), { once: true }) })
      }
    },
    async resume(_t, input) {
      setTimeout(() => { push('permission.response', { requestId: input.requestId ?? '' }); push('text.delta', { text: 'Connected.' }); push('turn.end', { stopReason: 'end_turn' }) }, 120)
    },
    async abort() {},
    async models() { return [{ id: 'openrouter:anthropic/claude-3.5-sonnet', hasCredentials: true, default: true }] },
  }
}

function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const client = useMemo(() => makeFake(), [])
  const tab = (x: 'dark' | 'light') => ({ padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, border: '1px solid #8884', background: theme === x ? '#8886' : 'transparent', color: 'inherit' })
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', gap: 12, background: '#2a2a2c', color: '#ddd', fontFamily: 'system-ui', padding: 16 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={tab('dark')} onClick={() => setTheme('dark')}>Dark</button>
        <button style={tab('light')} onClick={() => setTheme('light')}>Light</button>
      </div>
      <div style={{ height: 760, width: 560 }}>
        <OwnwareChat
          client={client}
          profileId="rosa"
          agentName="Rosa · shop support"
          greeting="Type anything to see the kit render every built-in tool card."
          descriptors={CUSTOM}
          theme={theme}
        />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
