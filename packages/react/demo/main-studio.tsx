/**
 * Dev demo for <OwnwareStudio> — the ChatGPT-style shell around <OwnwareChat>,
 * driven by a scripted fake (per-thread channels → conversations are independent).
 *   bun build packages/react/demo/main-studio.tsx --outfile /tmp/ow-studio.js
 */
import { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { OwnwareStudio, type AgentTransport } from '@ownware/react'
import type { AgentEvent } from '@ownware/ui'

interface Chan { q: AgentEvent[]; wake: (() => void) | null; closed: boolean }

function makeFake(): AgentTransport {
  const chans = new Map<string, Chan>()
  let tc = 0
  let seq = 0
  const chan = (tid: string): Chan => {
    let c = chans.get(tid)
    if (!c) { c = { q: [], wake: null, closed: false }; chans.set(tid, c) }
    return c
  }
  const push = (tid: string, type: string, data: Record<string, unknown>) => {
    const c = chan(tid); c.q.push({ type, seq: ++seq, data }); c.wake?.(); c.wake = null
  }
  const streamText = (tid: string, text: string) => {
    const words = text.split(' ')
    words.forEach((w, i) => setTimeout(() => push(tid, 'text.delta', { text: (i ? ' ' : '') + w }), 200 + i * 48))
    setTimeout(() => push(tid, 'turn.end', { stopReason: 'end_turn' }), 200 + words.length * 48 + 120)
  }
  const reply = (tid: string, prompt: string) => {
    setTimeout(() => {
      if (/slack|connect/i.test(prompt)) {
        push(tid, 'permission.request', { requestId: 'r' + seq, toolName: 'slack_connect', reason: 'read + reply in #support only' })
        return
      }
      // built-in tools → descriptor-driven cards ("Searched web", "Wrote …")
      const s = 's' + seq
      push(tid, 'tool.call.start', { toolCallId: s, toolName: 'web_search', input: { query: prompt } })
      setTimeout(() => {
        push(tid, 'tool.call.end', { toolCallId: s, toolName: 'web_search', result: '1. Bloom & Stem — same-day\n2. Petal Post — 2-hour windows\n3. Fern & Co — city-wide delivery', isError: false, durationMs: 420 })
        const w = 'w' + seq
        push(tid, 'tool.call.start', { toolCallId: w, toolName: 'writeFile', input: { file_path: 'rosa/notes/delivery.md', content: '# Delivery windows\n- Whitefield: 10am–2pm\n- Indiranagar: same-day before 4pm\n- Koramangala: 2hr slots' } })
        setTimeout(() => {
          push(tid, 'tool.call.end', { toolCallId: w, toolName: 'writeFile', result: 'ok', isError: false, durationMs: 34 })
          streamText(tid, 'I checked the web and saved the delivery windows to your notes — Whitefield is 10am–2pm today, Indiranagar is same-day before 4pm.')
        }, 520)
      }, 620)
    }, 180)
  }
  return {
    async run({ prompt }) { const tid = 't' + ++tc; reply(tid, prompt); return { threadId: tid } },
    async *events(tid, opts) {
      const c = chan(tid); const signal = opts?.signal
      for (;;) {
        while (c.q.length) yield c.q.shift()!
        if (c.closed || signal?.aborted) return
        await new Promise<void>((r) => { c.wake = r; signal?.addEventListener('abort', () => r(), { once: true }) })
      }
    },
    async resume(tid, input) {
      setTimeout(() => {
        push(tid, 'permission.response', { requestId: input.requestId ?? '' })
        streamText(tid, 'Connected — I now answer in #support. You approved read + reply there; nothing else.')
      }, 150)
    },
    async abort() {},
    async models() { return [{ id: 'ollama:llama3.2', hasCredentials: true, default: true }] },
  }
}

const PROFILES = [
  { id: 'rosa', name: 'Rosa · shop support' },
  { id: 'lex', name: 'Lex · legal review' },
  { id: 'nova', name: 'Nova · research' },
]

function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const client = useMemo(() => makeFake(), [])
  const tab = (t: 'dark' | 'light') => ({
    padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
    border: '1px solid #8884', background: theme === t ? '#8886' : 'transparent', color: 'inherit',
  })
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', gap: 14, background: '#2a2a2c', color: '#ddd', fontFamily: 'system-ui', padding: 20 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={tab('dark')} onClick={() => setTheme('dark')}>Dark</button>
        <button style={tab('light')} onClick={() => setTheme('light')}>Light</button>
      </div>
      <div style={{ height: 660, width: 940 }}>
        <OwnwareStudio client={client} profiles={PROFILES} theme={theme} brand="ownware" />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
