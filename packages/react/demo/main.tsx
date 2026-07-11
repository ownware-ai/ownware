/**
 * Dev demo for <OwnwareChat> — a scripted fake agent, no gateway needed.
 * Bundle it and open in a browser to see the component in the v2 skin:
 *   bun build packages/react/demo/main.tsx --outfile /tmp/ow-demo.js
 * (Dev-only; not part of the published package — `files` ships only `dist`.)
 */
import { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { OwnwareChat, type AgentTransport } from '@ownware/react'
import type { AgentEvent } from '@ownware/ui'

function channel() {
  const q: AgentEvent[] = []
  let wake: (() => void) | null = null
  let closed = false
  return {
    push(e: AgentEvent) { q.push(e); wake?.(); wake = null },
    async *stream(_t: string, opts?: { signal?: AbortSignal }): AsyncGenerator<AgentEvent> {
      const signal = opts?.signal
      for (;;) {
        while (q.length) yield q.shift()!
        if (closed || signal?.aborted) return
        await new Promise<void>((r) => { wake = r; signal?.addEventListener('abort', () => r(), { once: true }) })
      }
    },
  }
}

/** A fake transport that auto-scripts a reply (or an approval) to any prompt. */
function makeFake(): AgentTransport {
  const ch = channel()
  let seq = 0
  const push = (type: string, data: Record<string, unknown>) => ch.push({ type, seq: ++seq, data })
  const stream = (text: string, done = true) => {
    const words = text.split(' ')
    words.forEach((w, i) => setTimeout(() => push('text.delta', { text: (i ? ' ' : '') + w }), 220 + i * 55))
    if (done) setTimeout(() => push('turn.end', { stopReason: 'end_turn' }), 220 + words.length * 55 + 120)
  }
  return {
    async run({ prompt }) {
      setTimeout(() => {
        if (/slack|connect|approve/i.test(prompt)) {
          push('permission.request', { requestId: 'r' + seq, toolName: 'slack_connect', reason: 'read + reply in #support only' })
          return
        }
        const cid = 'c' + seq
        push('tool.call.start', { toolCallId: cid, toolName: 'order_lookup', input: { query: prompt } })
        setTimeout(() => {
          push('tool.call.end', { toolCallId: cid, result: `Found 3 matches for "${prompt}"\n- #1042 · out for delivery\n- #1039 · delivered\n- #1036 · preparing`, isError: false, durationMs: 380 })
          stream('Here’s what I found in our orders — I can pull tracking on any of them, or check delivery windows for your area.')
        }, 650)
      }, 200)
      return { threadId: 't-demo' }
    },
    events: (t, opts) => ch.stream(t, opts),
    async resume(_t, input) {
      setTimeout(() => {
        push('permission.response', { requestId: input.requestId ?? '' })
        stream('Connected — Rosa now answers in #support. You approved read + reply there; nothing else.')
      }, 150)
    },
    async abort() {},
    async models() { return [{ id: 'ollama:llama3.2', hasCredentials: true, default: true }] },
  }
}

function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const transport = useMemo(() => makeFake(), [])
  const tab = (t: 'dark' | 'light') => ({
    padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
    border: '1px solid #8884', background: theme === t ? '#8886' : 'transparent', color: 'inherit',
  })
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', gap: 16, background: '#2a2a2c', color: '#ddd', fontFamily: 'system-ui', padding: 24 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={tab('dark')} onClick={() => setTheme('dark')}>Dark</button>
        <button style={tab('light')} onClick={() => setTheme('light')}>Light</button>
      </div>
      <div style={{ height: 640, width: 460 }}>
        <OwnwareChat
          profileId="assistant"
          client={transport}
          agentName="Rosa"
          greeting="Ask Rosa about the shop — orders, delivery windows, hours."
          placeholder="Ask about an order… (try “connect slack”)"
          theme={theme}
        />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
