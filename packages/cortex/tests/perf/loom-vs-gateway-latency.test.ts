/**
 * Loom-direct vs Gateway latency benchmark.
 *
 * Answers the owner's Phase-3 question: "how much faster is Loom directly
 * vs going through the gateway?" — with measured numbers, not guesses.
 *
 * Three measurements:
 *   (A) Deterministic SQLite-append micro-bench — isolates the hypothesized
 *       dominant gateway hop (the synchronous better-sqlite3 append that sits
 *       between a model token and the bus/SSE, event-ingestor.ts:113). No model.
 *   (B) Raw in-process Loom — assemble a Session, consume its AsyncGenerator.
 *   (C) Gateway — POST /run + consume the SSE stream over loopback.
 * (B) and (C) use the SAME prompt + model (Haiku via OpenRouter) so the delta
 * is the gateway tax. Primary fair metrics: time-to-first-text (TTFT) and
 * per-text-event cadence — both normalize for the model's non-deterministic
 * output length.
 *
 * Run (from repo root, loads .env for OPENROUTER_API_KEY):
 *   bun run packages/cortex/tests/perf/loom-vs-gateway-latency.ts
 *
 * The benchmark uses only temp dirs and OPENROUTER_API_KEY (referenced by
 * name, never logged). It never touches ~/.cortex or ~/.ownware.
 */

import { describe, it, expect } from 'vitest'
import { performance } from 'node:perf_hooks'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Session, OpenRouterProvider, registerProvider } from '@ownware/loom'
import type { LoomEvent } from '@ownware/loom'
import { loadProfile } from '../../src/profile/loader.js'
import { assembleAgent } from '../../src/profile/assembler.js'
import { OwnwareGateway } from '../../src/gateway/server.js'
import { CortexDatabase } from '../../src/gateway/db/database.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const MODEL = 'openrouter:haiku-4.5'
const PROMPT =
  'List 12 common kitchen utensils. One per line, each followed by a short five-word description.'
const MAX_TOKENS = 320
const ITERS = 6 // recorded iterations per path (plus 1 warmup)
const APPEND_N = 20_000 // deterministic micro-bench sample count
const APPEND_ROTATE = 200 // new (thread,agent) stream every N appends (realistic stream size)

const KEY =
  process.env.OPENROUTER_API_KEY &&
  !process.env.OPENROUTER_API_KEY.includes('OWNWARE_TEST_DUMMY')
    ? process.env.OPENROUTER_API_KEY
    : undefined

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------
interface Stats {
  readonly n: number
  readonly mean: number
  readonly p50: number
  readonly p99: number
  readonly min: number
  readonly max: number
}
function stats(xs: readonly number[]): Stats {
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  const pct = (p: number) => s[Math.min(n - 1, Math.floor((p / 100) * n))]!
  const mean = s.reduce((a, b) => a + b, 0) / n
  return { n, mean, p50: pct(50), p99: pct(99), min: s[0]!, max: s[n - 1]! }
}
const ms = (x: number) => `${x.toFixed(2)}ms`
const us = (x: number) => `${(x * 1000).toFixed(1)}µs`

interface RunSample {
  readonly ttfe: number // time to first (non-setup) event
  readonly ttft: number // time to first text.delta
  readonly total: number // total wall
  readonly count: number // total events seen
  readonly textCount: number // text.delta count
  readonly interTextP50: number // median gap between consecutive text.deltas
  readonly ok: boolean
  readonly note?: string
}

function summarizeRuns(label: string, runs: readonly RunSample[]): void {
  const ok = runs.filter((r) => r.ok)
  if (ok.length === 0) {
    console.log(`\n${label}: ALL ${runs.length} runs FAILED`)
    for (const r of runs) console.log(`   - ${r.note ?? 'unknown failure'}`)
    return
  }
  const ttft = stats(ok.map((r) => r.ttft))
  const ttfe = stats(ok.map((r) => r.ttfe))
  const total = stats(ok.map((r) => r.total))
  const interText = stats(ok.map((r) => r.interTextP50))
  const avgText = ok.reduce((a, r) => a + r.textCount, 0) / ok.length
  const avgCount = ok.reduce((a, r) => a + r.count, 0) / ok.length
  console.log(`\n${label}  (${ok.length}/${runs.length} ok)`)
  console.log(`   time-to-first-text   p50=${ms(ttft.p50)}  mean=${ms(ttft.mean)}  min=${ms(ttft.min)}  max=${ms(ttft.max)}`)
  console.log(`   time-to-first-event  p50=${ms(ttfe.p50)}  mean=${ms(ttfe.mean)}`)
  console.log(`   total wall           p50=${ms(total.p50)}  mean=${ms(total.mean)}`)
  console.log(`   inter-text gap (p50) p50=${ms(interText.p50)}  mean=${ms(interText.mean)}   [per-token cadence]`)
  console.log(`   events/run           total~${avgCount.toFixed(0)}  text.delta~${avgText.toFixed(0)}`)
}

function medianGap(times: readonly number[]): number {
  if (times.length < 2) return 0
  const gaps: number[] = []
  for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!)
  return stats(gaps).p50
}

// ---------------------------------------------------------------------------
// (A) SQLite append micro-bench
// ---------------------------------------------------------------------------
function benchAppend(): Stats {
  const dir = mkdtempSync(join(tmpdir(), 'bench-append-'))
  try {
    const db = new CortexDatabase(join(dir, 'a.db'))
    const payload = { type: 'text.delta', text: 'a representative streamed token chunk' }
    const mk = (i: number) => ({
      threadId: `thread_${Math.floor(i / APPEND_ROTATE)}`,
      agentId: 'root',
      parentAgentId: null as string | null,
      type: 'text.delta',
      payload,
    })
    // warmup
    for (let i = 0; i < 2000; i++) db.appendAgentEvent(mk(i))
    const samples = new Array<number>(APPEND_N)
    for (let i = 0; i < APPEND_N; i++) {
      const t0 = performance.now()
      db.appendAgentEvent(mk(i))
      samples[i] = performance.now() - t0
    }
    db.close()
    return stats(samples)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// (B) Raw in-process Loom
// ---------------------------------------------------------------------------
async function benchRawLoom(profileDir: string): Promise<RunSample[]> {
  const profile = await loadProfile(profileDir)
  const assembled = await assembleAgent(profile)
  const out: RunSample[] = []
  for (let k = -1; k < ITERS; k++) {
    const session = new Session({
      config: { ...assembled.config, maxTokens: MAX_TOKENS, model: MODEL },
      provider: assembled.provider,
      tools: [],
    })
    const t0 = performance.now()
    let ttfe = -1
    let ttft = -1
    let count = 0
    const textTimes: number[] = []
    let ok = true
    let note: string | undefined
    try {
      const gen = session.submitMessage(PROMPT) as AsyncGenerator<LoomEvent, unknown>
      let next = await gen.next()
      while (!next.done) {
        const now = performance.now() - t0
        const ev = next.value
        if (ttfe < 0) ttfe = now
        count++
        if (ev.type === 'text.delta') {
          if (ttft < 0) ttft = now
          textTimes.push(now)
        }
        if (ev.type === 'error') {
          ok = false
          note = `error event: ${(ev as { error?: { message?: string } }).error?.message ?? 'unknown'}`
        }
        next = await gen.next()
      }
    } catch (err) {
      ok = false
      note = err instanceof Error ? err.message : String(err)
    }
    const total = performance.now() - t0
    if (k < 0) continue // discard warmup
    out.push({ ttfe, ttft, total, count, textCount: textTimes.length, interTextP50: medianGap(textTimes), ok: ok && textTimes.length > 0, note })
  }
  return out
}

// ---------------------------------------------------------------------------
// (C) Gateway
// ---------------------------------------------------------------------------
async function benchGateway(baseUrl: string): Promise<RunSample[]> {
  const out: RunSample[] = []
  for (let k = -1; k < ITERS; k++) {
    const t0 = performance.now()
    let ttfe = -1
    let ttft = -1
    let count = 0
    const textTimes: number[] = []
    let ok = true
    let note: string | undefined
    try {
      const runRes = await fetch(`${baseUrl}/api/v1/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: PROMPT, profileId: 'bench', model: MODEL }),
      })
      if (runRes.status !== 200) {
        out.push(await failRun(k, `POST /run -> ${runRes.status}: ${await runRes.text()}`))
        continue
      }
      const start = (await runRes.json()) as { threadId: string; agentId?: string }
      const sseRes = await fetch(
        `${baseUrl}/api/v1/threads/${start.threadId}/agents/${start.agentId ?? 'root'}/events`,
      )
      const reader = sseRes.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let done = false
      while (!done) {
        const { done: rd, value } = await reader.read()
        if (rd) break
        buf += dec.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          let evName = ''
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) evName = line.slice(7).trim()
          }
          if (!evName) continue
          const now = performance.now() - t0
          // stream.start / replay.complete / user.message are gateway setup frames,
          // not model output — exclude from "first real event".
          const isSetup = evName.startsWith('stream.') || evName === 'user.message'
          if (ttfe < 0 && !isSetup) ttfe = now
          count++
          if (evName === 'text.delta') {
            if (ttft < 0) ttft = now
            textTimes.push(now)
          }
          if (evName === 'error') {
            ok = false
            note = `error event`
          }
          if (evName === 'done' || evName === 'session.end') done = true
        }
      }
      try {
        reader.releaseLock()
        await sseRes.body!.cancel()
      } catch {
        /* stream already closed */
      }
    } catch (err) {
      ok = false
      note = err instanceof Error ? err.message : String(err)
    }
    const total = performance.now() - t0
    if (k < 0) continue
    out.push({ ttfe, ttft, total, count, textCount: textTimes.length, interTextP50: medianGap(textTimes), ok: ok && textTimes.length > 0, note })
  }
  return out
}
function failRun(k: number, note: string): RunSample {
  return { ttfe: -1, ttft: -1, total: -1, count: 0, textCount: 0, interTextP50: 0, ok: false, note }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════')
  console.log(' Loom-direct vs Gateway — latency benchmark')
  console.log(`  model=${MODEL}  maxTokens=${MAX_TOKENS}  iters=${ITERS}`)
  console.log('═══════════════════════════════════════════════════════════════')

  // (A) — always runs (no API).
  console.log('\n(A) SQLite append micro-bench — the hypothesized dominant gateway hop')
  const a = benchAppend()
  console.log(`   appendAgentEvent: p50=${us(a.p50)}  mean=${us(a.mean)}  p99=${us(a.p99)}  max=${us(a.max)}  (n=${a.n})`)

  if (!KEY) {
    console.log('\n⏭  OPENROUTER_API_KEY not set — skipping (B) raw-Loom and (C) gateway.')
    console.log('   Set it in .env and re-run for the full comparison.')
    return
  }
  registerProvider(new OpenRouterProvider({ apiKey: KEY }))

  // Shared temp profile (used by both raw-Loom loadProfile and the gateway profilesDir).
  const root = mkdtempSync(join(tmpdir(), 'bench-lvg-'))
  const profilesDir = join(root, 'profiles')
  const benchProfileDir = join(profilesDir, 'bench')
  mkdirSync(benchProfileDir, { recursive: true })
  writeFileSync(
    join(benchProfileDir, 'agent.json'),
    JSON.stringify(
      { name: 'bench', description: 'latency bench agent', model: MODEL, tools: { preset: 'none' }, context: { git: false, os: false, cwd: false, datetime: false, project: false } },
      null,
      2,
    ),
  )
  writeFileSync(join(benchProfileDir, 'SOUL.md'), '# Bench\nReply concisely.')

  let gateway: OwnwareGateway | undefined
  try {
    // (B) raw Loom
    console.log('\n(B) Raw in-process Loom — warming up + measuring…')
    const bRuns = await benchRawLoom(benchProfileDir)

    // (C) gateway
    console.log('(C) Gateway — starting in-process (tls:false, auth disabled)…')
    gateway = new OwnwareGateway({
      port: 0,
      profilesDir,
      dataDir: join(root, 'data'),
      dbPath: join(root, 'bench.db'),
      tls: false,
      disableAuth: true,
    })
    await gateway.start()
    const baseUrl = `http://127.0.0.1:${gateway.port}`
    console.log(`    gateway up at ${baseUrl} — measuring…`)
    const cRuns = await benchGateway(baseUrl)

    // Report
    console.log('\n───────────────────────────── RESULTS ─────────────────────────────')
    console.log(`(A) SQLite append (deterministic): p50=${us(a.p50)}/event  p99=${us(a.p99)}/event`)
    summarizeRuns('(B) RAW LOOM (in-process AsyncGenerator)', bRuns)
    summarizeRuns('(C) GATEWAY (POST /run + SSE over loopback)', cRuns)

    const b = bRuns.filter((r) => r.ok)
    const c = cRuns.filter((r) => r.ok)
    if (b.length && c.length) {
      const bT = stats(b.map((r) => r.ttft)).p50
      const cT = stats(c.map((r) => r.ttft)).p50
      const bG = stats(b.map((r) => r.interTextP50)).p50
      const cG = stats(c.map((r) => r.interTextP50)).p50
      console.log('\n──────────────────────────── VERDICT ──────────────────────────────')
      console.log(`  Time-to-first-text:  raw=${ms(bT)}  gateway=${ms(cT)}  → gateway adds ${ms(cT - bT)} (${((cT / bT - 1) * 100).toFixed(0)}%) of fixed setup`)
      console.log(`  Per-token cadence:   raw=${ms(bG)}  gateway=${ms(cG)}  → gateway adds ${ms(cG - bG)}/token`)
      console.log(`  SQLite append (A) accounts for ${us(a.p50)}/event of that per-token add.`)
      console.log('  (Both stream the same model; per-token deltas are small + noisy — TTFT is the cleaner signal.)')
    }
    console.log('────────────────────────────────────────────────────────────────────')
  } finally {
    if (gateway) await gateway.stop().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
}

// Gated behind RUN_LATENCY_BENCH=1 so it never runs in the normal suite
// (it makes real API calls + costs money). Invoke explicitly:
//   RUN_LATENCY_BENCH=1 ./node_modules/.bin/vitest run tests/perf/loom-vs-gateway-latency.test.ts
describe('perf: loom-direct vs gateway latency', () => {
  it.runIf(process.env['RUN_LATENCY_BENCH'] === '1')(
    'measures append cost, raw-Loom, and gateway',
    async () => {
      await main()
      expect(true).toBe(true)
    },
    240_000,
  )
})
