// chat.mjs — a terminal chat for your served agent, using only the wire
// contract (plain fetch + SSE). Everything here works from any language.
//
//   node chat.mjs
//
// What it shows: start a run (POST /run), watch it think (SSE events),
// approve tool permissions (POST /resume), keep one conversation thread.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import readline from 'node:readline/promises'

const here = dirname(fileURLToPath(import.meta.url))

let conn
try {
  conn = JSON.parse(readFileSync(join(here, '.ownware-connection.json'), 'utf8'))
} catch {
  console.error('No connection file found — start the agent first: node serve.mjs')
  process.exit(1)
}
const HEADERS = { Authorization: `Bearer ${conn.token}`, 'Content-Type': 'application/json' }

async function api(path, init) {
  const res = await fetch(`${conn.url}${path}`, { headers: HEADERS, ...init })
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${await res.text()}`)
  return res.json()
}

// Pick the first model the gateway says is actually usable right now —
// a cloud key you've set, or a running local Ollama. No config needed.
const models = await api('/api/v1/models')
const usable = models.filter((m) => m.hasCredentials)
const model = (usable.find((m) => m.default) ?? usable[0])?.id
if (!model) {
  const ollamaHint =
    process.platform === 'darwin' ? 'brew install ollama && ollama pull llama3.2'
    : process.platform === 'linux' ? 'curl -fsSL https://ollama.com/install.sh | sh && ollama pull llama3.2'
    : 'install Ollama from https://ollama.com, then: ollama pull llama3.2'
  console.error(
    'No model available. Set an API key (ANTHROPIC_API_KEY / OPENAI_API_KEY / ' +
      'GOOGLE_API_KEY / OPENROUTER_API_KEY) before `node serve.mjs` — or run keyless:\n' +
      `  ${ollamaHint}\n` +
      'then restart serve.mjs.',
  )
  process.exit(1)
}
console.log(`chatting with "assistant" via ${model} — Ctrl-C to quit\n`)

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
// Queue lines instead of using rl.question(): anything you type while the
// agent is still answering is kept, not dropped.
const pendingLines = []
const pendingWaiters = []
rl.on('line', (line) => {
  const waiter = pendingWaiters.shift()
  if (waiter) waiter(line)
  else pendingLines.push(line)
})
function ask(promptText) {
  process.stdout.write(promptText)
  if (pendingLines.length > 0) return Promise.resolve(pendingLines.shift())
  return new Promise((resolve) => pendingWaiters.push(resolve))
}
let threadId // one conversation across turns
let lastSeq = 0 // resume cursor — skips SSE replay of earlier turns

// Tail one run's SSE stream; returns when the session ends.
async function watch(tid) {
  const res = await fetch(
    `${conn.url}/api/v1/threads/${tid}/agents/root/events?since=${lastSeq}`,
    { headers: { Authorization: `Bearer ${conn.token}`, Accept: 'text/event-stream' } },
  )
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    let sep
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
      if (!dataLine) continue
      let event
      try {
        event = JSON.parse(dataLine.slice(5))
      } catch {
        continue
      }
      // Each event carries its log sequence — remember it so the next
      // turn's stream resumes after it instead of replaying history.
      if (Number.isFinite(event.seq) && event.seq > lastSeq) lastSeq = event.seq
      switch (event.type) {
        case 'text.delta':
          process.stdout.write(event.text)
          break
        case 'tool.call.start':
          process.stdout.write(`\n  [tool] ${event.toolName}…`)
          break
        case 'tool.call.end':
          process.stdout.write(' done\n')
          break
        case 'permission.request': {
          const yn = await ask(
            `\n  [permission] allow ${event.toolName}? (y/n) `,
          )
          await api(`/api/v1/threads/${tid}/resume`, {
            method: 'POST',
            body: JSON.stringify({ action: yn.trim().toLowerCase().startsWith('y') ? 'approve' : 'deny' }),
          })
          break
        }
        case 'turn.end':
          if (event.usage?.costUsd != null) {
            process.stdout.write(`\n  ($${event.usage.costUsd.toFixed(4)})`)
          }
          break
        case 'error':
          console.error(`\n  [error] ${event.code}: ${event.message}`)
          break
        case 'session.end':
          reader.cancel().catch(() => {})
          return
      }
    }
  }
}

for (;;) {
  const prompt = (await ask('\nyou › ')).trim()
  if (!prompt) continue
  const started = await api('/api/v1/run', {
    method: 'POST',
    body: JSON.stringify({ prompt, profileId: 'assistant', model, ...(threadId ? { threadId } : {}) }),
  })
  threadId = started.threadId
  process.stdout.write('\nassistant › ')
  await watch(threadId)
  process.stdout.write('\n')
}
