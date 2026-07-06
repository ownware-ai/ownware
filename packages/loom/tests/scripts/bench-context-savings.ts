#!/usr/bin/env bun
/**
 * Wave 1 benchmark — measures byte savings + accuracy delta from the new
 * head+tail truncation and per-tool byte telemetry.
 *
 * Two scenarios:
 *
 *   A) Real Anthropic agent task at two cap settings (LARGE vs SMALL).
 *      Same task, same model, same prompt — only difference is the
 *      tool-result byte cap. Reports tokens consumed, raw vs to-model
 *      bytes, savings %, per-tool breakdown.
 *
 *   B) Deterministic accuracy demo: head-only vs head+tail truncation
 *      on a synthetic large output ending in a critical line. Shows
 *      that head-only loses the answer, head+tail preserves it. No
 *      model call required — pure byte comparison.
 *
 * Usage:
 *   set -a; source ../../.env; set +a
 *   bun run scripts/bench-context-savings.ts [--scenario=a|b|both] [--turns=N]
 *
 * Default: both scenarios, maxTurns=8, model=claude-haiku-4-5-20251001.
 */

import {
  Session,
  builtinTools,
  resolveProvider,
  createDefaultConfig,
  mergeConfig,
  ToolResultCache,
  type LoomEvent,
  type LoopResult,
} from '../src/index.js'
import { headTailTruncate } from '../src/messages/truncate.js'

// ────────────────────────────────────────────────────────────────────────
// Args + colors
// ────────────────────────────────────────────────────────────────────────

const args = new Map<string, string>()
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  if (m) args.set(m[1]!, m[2] ?? 'true')
}
const SCENARIO = args.get('scenario') ?? 'both'
const MAX_TURNS = Number(args.get('turns') ?? '8')
const MODEL = args.get('model') ?? 'anthropic:claude-haiku-4-5-20251001'

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', magenta: '\x1b[35m',
}

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`

// ────────────────────────────────────────────────────────────────────────
// Telemetry collector — aggregates byte stats from the event stream
// ────────────────────────────────────────────────────────────────────────

interface ToolStats {
  count: number
  bytesRaw: number
  bytesToModel: number
  truncatedCount: number
  cacheHitCount: number
  bytesSavedFromCache: number
  totalDurationMs: number
}

class BenchCollector {
  readonly tools = new Map<string, ToolStats>()

  ingest(event: LoomEvent): void {
    if (event.type !== 'tool.call.end') return
    let s = this.tools.get(event.toolName)
    if (!s) {
      s = { count: 0, bytesRaw: 0, bytesToModel: 0, truncatedCount: 0, cacheHitCount: 0, bytesSavedFromCache: 0, totalDurationMs: 0 }
      this.tools.set(event.toolName, s)
    }
    s.count += 1
    s.bytesRaw += event.outputBytesRaw ?? 0
    s.bytesToModel += event.outputBytesToModel ?? 0
    if (event.truncated) s.truncatedCount += 1
    if (event.cacheHit) {
      s.cacheHitCount += 1
      s.bytesSavedFromCache += event.outputBytesToModel ?? 0
    }
    s.totalDurationMs += event.durationMs
  }

  totals() {
    let raw = 0, toModel = 0, truncated = 0, calls = 0, cacheHits = 0, cacheBytes = 0
    for (const s of this.tools.values()) {
      raw += s.bytesRaw
      toModel += s.bytesToModel
      truncated += s.truncatedCount
      calls += s.count
      cacheHits += s.cacheHitCount
      cacheBytes += s.bytesSavedFromCache
    }
    return { raw, toModel, saved: raw - toModel, calls, truncated, cacheHits, cacheBytes }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Scenario A — real Anthropic agent at two cap settings
// ────────────────────────────────────────────────────────────────────────

interface RunOutcome {
  label: string
  capBytes: number
  collector: BenchCollector
  result: LoopResult
  finalText: string
  wallMs: number
}

interface RunOptions {
  capBytes?: number
  /** Disable the result cache by passing one with maxEntries: 0. Default: cache enabled. */
  disableCache?: boolean
  /** Compaction strategy override. */
  compactionStrategy?: 'summarize' | 'truncate' | 'sliding_window' | 'hierarchical' | 'snapshot'
  /** Trigger compaction at this many messages. Default: never. */
  compactAtMessages?: number
}

async function runOnce(label: string, opts: RunOptions, task: string): Promise<RunOutcome> {
  const collector = new BenchCollector()
  const { provider } = resolveProvider(MODEL)
  const capBytes = opts.capBytes ?? 200_000
  const baseConfig = createDefaultConfig(MODEL)
  const config = mergeConfig(baseConfig, {
    model: MODEL,
    systemPrompt:
      'You are a code analyst. Use the provided tools to investigate. ' +
      'When you have enough info, give a 1-2 sentence answer and stop.',
    maxTurns: MAX_TURNS,
    maxTokens: 1024,
    toolExecution: { maxResultSize: capBytes },
    ...(opts.compactionStrategy
      ? {
          compaction: {
            ...baseConfig.compaction,
            strategy: opts.compactionStrategy,
            ...(opts.compactAtMessages != null
              ? { trigger: { type: 'messages' as const, threshold: opts.compactAtMessages } }
              : {}),
          },
        }
      : {}),
  })
  const session = new Session({
    config,
    provider,
    tools: builtinTools,
    // Bench is fully autonomous — no HITL, no prompts. permissionMode='auto'
    // is now wired through the loop (was previously a silent no-op).
    permissionMode: 'auto',
    ...(opts.disableCache ? { toolResultCache: new ToolResultCache({ maxEntries: 0 }) } : {}),
  })

  const start = Date.now()
  let finalText = ''
  const errors: string[] = []
  const gen = session.submitMessage(task)
  let next = await gen.next()
  while (!next.done) {
    const ev = next.value
    collector.ingest(ev)
    if (ev.type === 'text.delta') finalText += ev.text
    if (ev.type === 'error') errors.push(`${ev.code ?? 'err'}: ${ev.message}`)
    next = await gen.next()
  }
  const wallMs = Date.now() - start
  const result = next.value as LoopResult
  if (errors.length > 0) {
    console.log(`  ${C.red}errors during run:${C.reset}`)
    for (const e of errors) console.log(`    ${C.red}${e}${C.reset}`)
  }
  return { label, capBytes, collector, result, finalText, wallMs }
}

// Convenience for scenario A which still uses the simpler two-arg form.
async function runOnceLegacy(label: string, capBytes: number, task: string): Promise<RunOutcome> {
  return runOnce(label, { capBytes }, task)
}

function printOutcome(o: RunOutcome): void {
  const t = o.collector.totals()
  console.log(`\n${C.bold}${o.label}${C.reset} ${C.dim}(cap = ${fmtBytes(o.capBytes)})${C.reset}`)
  console.log(`  ${C.dim}wall:${C.reset} ${o.wallMs}ms   ${C.dim}turns:${C.reset} ${o.result.turnCount}   ${C.dim}reason:${C.reset} ${o.result.reason}`)
  console.log(`  ${C.dim}tokens:${C.reset} in=${o.result.totalUsage.inputTokens.toLocaleString()}  out=${o.result.totalUsage.outputTokens.toLocaleString()}  cacheRead=${o.result.totalUsage.cacheReadTokens.toLocaleString()}  cacheCreate=${o.result.totalUsage.cacheCreationTokens.toLocaleString()}`)
  if (o.result.totalUsage.costUsd) {
    console.log(`  ${C.dim}cost:${C.reset} $${o.result.totalUsage.costUsd.toFixed(5)}`)
  }
  console.log(`  ${C.dim}tool calls:${C.reset} ${t.calls}   ${C.dim}truncated:${C.reset} ${t.truncated}`)
  console.log(`  ${C.dim}tool bytes RAW:${C.reset}      ${fmtBytes(t.raw).padStart(10)}`)
  console.log(`  ${C.dim}tool bytes TO MODEL:${C.reset} ${fmtBytes(t.toModel).padStart(10)}`)
  if (t.raw > 0) {
    const ratio = t.saved / t.raw
    const color = ratio > 0.5 ? C.green : ratio > 0.1 ? C.yellow : C.dim
    console.log(`  ${C.dim}bytes saved:${C.reset}         ${color}${fmtBytes(t.saved).padStart(10)}${C.reset}  ${color}(${pct(ratio)} of raw)${C.reset}`)
  }
  if (t.cacheHits > 0) {
    console.log(`  ${C.dim}cache hits:${C.reset}          ${C.green}${String(t.cacheHits).padStart(10)}${C.reset}  ${C.green}(saved ${fmtBytes(t.cacheBytes)} from re-execution)${C.reset}`)
  }
  if (o.collector.tools.size > 0) {
    console.log(`  ${C.dim}per-tool:${C.reset}`)
    for (const [name, s] of [...o.collector.tools.entries()].sort((a, b) => b[1].bytesRaw - a[1].bytesRaw)) {
      const trunc = s.truncatedCount > 0 ? `${C.yellow}[${s.truncatedCount} truncated]${C.reset}` : ''
      console.log(`    ${name.padEnd(20)} ${String(s.count).padStart(3)} call(s)   raw=${fmtBytes(s.bytesRaw).padStart(9)}   model=${fmtBytes(s.bytesToModel).padStart(9)}   ${trunc}`)
    }
  }
  console.log(`  ${C.dim}final answer:${C.reset} ${C.cyan}${o.finalText.trim().slice(0, 240)}${o.finalText.length > 240 ? '…' : ''}${C.reset}`)
}

async function scenarioA(): Promise<void> {
  console.log(`\n${C.bold}${C.magenta}═══ SCENARIO A — Real Anthropic agent, two cap settings ═══${C.reset}`)
  console.log(`${C.dim}Same task, same model, same prompt. Only the tool-result byte cap differs.${C.reset}`)
  console.log(`${C.dim}Model: ${MODEL}   Max turns: ${MAX_TURNS}${C.reset}`)

  const task =
    'Read the file `src/core/loop.ts` and the file `src/messages/truncate.ts`. ' +
    'In one sentence, describe how `truncate.ts` is used by `loop.ts`.'

  const baseline = await runOnceLegacy(`A1: BASELINE (large cap, little/no truncation)`, 200_000, task)
  printOutcome(baseline)

  const aggressive = await runOnceLegacy(`A2: AGGRESSIVE CAP (forces head+tail truncation)`, 4_000, task)
  printOutcome(aggressive)

  // Comparison
  const tB = baseline.collector.totals()
  const tA = aggressive.collector.totals()
  console.log(`\n${C.bold}━━ DELTA (A2 vs A1) ━━${C.reset}`)
  const tokenDelta = aggressive.result.totalUsage.inputTokens - baseline.result.totalUsage.inputTokens
  const tokenPct = baseline.result.totalUsage.inputTokens > 0
    ? tokenDelta / baseline.result.totalUsage.inputTokens
    : 0
  console.log(`  bytes raw produced:    ${fmtBytes(tA.raw)} vs ${fmtBytes(tB.raw)}   ${C.dim}(roughly equal — same task)${C.reset}`)
  console.log(`  bytes delivered:       ${fmtBytes(tA.toModel)} vs ${fmtBytes(tB.toModel)}   ${C.green}(saved ${fmtBytes(tB.toModel - tA.toModel)})${C.reset}`)
  console.log(`  input tokens:          ${aggressive.result.totalUsage.inputTokens.toLocaleString()} vs ${baseline.result.totalUsage.inputTokens.toLocaleString()}   ${tokenDelta < 0 ? C.green : C.yellow}(${tokenDelta > 0 ? '+' : ''}${tokenDelta.toLocaleString()}, ${pct(tokenPct)})${C.reset}`)
  if (baseline.result.totalUsage.costUsd && aggressive.result.totalUsage.costUsd) {
    const costDelta = aggressive.result.totalUsage.costUsd - baseline.result.totalUsage.costUsd
    console.log(`  cost:                  $${aggressive.result.totalUsage.costUsd.toFixed(5)} vs $${baseline.result.totalUsage.costUsd.toFixed(5)}   ${costDelta < 0 ? C.green : C.yellow}(${costDelta >= 0 ? '+' : ''}$${costDelta.toFixed(5)})${C.reset}`)
  }
  console.log(`  agent still answered:  ${aggressive.finalText.trim().length > 20 ? C.green + 'YES' : C.red + 'NO'}${C.reset}`)
}

// ────────────────────────────────────────────────────────────────────────
// Scenario B — deterministic head-only vs head+tail accuracy demo
// ────────────────────────────────────────────────────────────────────────

function headOnlyTruncate(str: string, maxBytes: number): string {
  // The OLD behavior — what loom did before this PR. Pure byte slice +
  // marker, no tail preservation. Recreated here for direct comparison.
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str
  const marker = '\n\n[Output truncated]'
  const cap = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'))
  return str.slice(0, cap) + marker
}

function scenarioB(): void {
  console.log(`\n${C.bold}${C.magenta}═══ SCENARIO B — Head-only vs Head+Tail (deterministic) ═══${C.reset}`)
  console.log(`${C.dim}Tool output ends with a critical instruction. Shows whether the${C.reset}`)
  console.log(`${C.dim}truncation strategy preserves the actionable tail.${C.reset}`)

  const setup = Array.from({ length: 600 }, (_, i) => `[setup line ${i}] initializing component, no errors yet…`).join('\n')
  const errorTail = [
    '',
    'FATAL: connection refused (ECONNREFUSED 127.0.0.1:5432)',
    'Stack trace:',
    '  at Database.connect (db.ts:42)',
    '  at Bootstrap.run (boot.ts:11)',
    'Exit code: 1',
    '',
    '>>> ANSWER MARKER: the canary string is "DELTA-7742-OMEGA" <<<',
  ].join('\n')
  const fullOutput = setup + '\n' + errorTail

  const cap = 1500
  const headOnly = headOnlyTruncate(fullOutput, cap)
  const headTail = headTailTruncate(fullOutput, cap)

  const containsAnswer = (s: string) => s.includes('DELTA-7742-OMEGA')
  const containsError = (s: string) => s.includes('ECONNREFUSED') || s.includes('FATAL: connection')

  console.log(`\n  ${C.bold}Input:${C.reset} ${fmtBytes(Buffer.byteLength(fullOutput, 'utf8'))} of output ending in a canary line + stack trace`)
  console.log(`  ${C.bold}Cap:${C.reset}   ${cap} bytes`)

  console.log(`\n  ${C.bold}HEAD-ONLY (old behavior):${C.reset}`)
  console.log(`    output bytes: ${Buffer.byteLength(headOnly, 'utf8')}`)
  console.log(`    contains canary answer: ${containsAnswer(headOnly) ? C.green + 'YES' : C.red + 'NO'}${C.reset}`)
  console.log(`    contains error/stack:   ${containsError(headOnly) ? C.green + 'YES' : C.red + 'NO'}${C.reset}`)
  console.log(`    last 80 chars: ${C.dim}${JSON.stringify(headOnly.slice(-80))}${C.reset}`)

  console.log(`\n  ${C.bold}HEAD+TAIL (new behavior):${C.reset}`)
  console.log(`    output bytes: ${Buffer.byteLength(headTail, 'utf8')}`)
  console.log(`    contains canary answer: ${containsAnswer(headTail) ? C.green + 'YES' : C.red + 'NO'}${C.reset}`)
  console.log(`    contains error/stack:   ${containsError(headTail) ? C.green + 'YES' : C.red + 'NO'}${C.reset}`)
  console.log(`    last 80 chars: ${C.dim}${JSON.stringify(headTail.slice(-80))}${C.reset}`)

  console.log(`\n  ${C.bold}━━ Result ━━${C.reset}`)
  if (containsAnswer(headTail) && !containsAnswer(headOnly)) {
    console.log(`  ${C.green}✓ head+tail preserves the actionable tail; head-only loses it.${C.reset}`)
    console.log(`  ${C.green}  → for any task that depends on stack traces, exit codes, or${C.reset}`)
    console.log(`  ${C.green}    final answers in long output, this is a direct accuracy win.${C.reset}`)
  } else {
    console.log(`  ${C.yellow}Result inconclusive — both strategies preserved (or lost) the tail.${C.reset}`)
  }
}

// ────────────────────────────────────────────────────────────────────────
// Scenario C — cache hits (re-reading the same files)
// ────────────────────────────────────────────────────────────────────────

async function scenarioC(): Promise<void> {
  console.log(`\n${C.bold}${C.magenta}═══ SCENARIO C — Tool result cache (real Anthropic) ═══${C.reset}`)
  console.log(`${C.dim}Same task: read 3 files, then re-read them. With cache,${C.reset}`)
  console.log(`${C.dim}second reads are O(1) cache lookups; without, they re-execute.${C.reset}`)

  const task =
    'Read these 3 files in order: src/messages/truncate.ts, src/tools/result-cache.ts, src/messages/types.ts. ' +
    'Then read all 3 again in the same order. Then say "done" in one word.'

  const noCache = await runOnce(`C1: CACHE DISABLED`, { capBytes: 200_000, disableCache: true }, task)
  printOutcome(noCache)

  const withCache = await runOnce(`C2: CACHE ENABLED (default)`, { capBytes: 200_000 }, task)
  printOutcome(withCache)

  const tNo = noCache.collector.totals()
  const tYes = withCache.collector.totals()
  console.log(`\n${C.bold}━━ DELTA (C2 vs C1) ━━${C.reset}`)
  console.log(`  cache hits:               ${tYes.cacheHits} vs ${tNo.cacheHits}`)
  console.log(`  bytes saved by cache:     ${C.green}${fmtBytes(tYes.cacheBytes)}${C.reset} vs ${fmtBytes(tNo.cacheBytes)}`)
  console.log(`  total tool wall time:     ${[...withCache.collector.tools.values()].reduce((s, x) => s + x.totalDurationMs, 0)}ms vs ${[...noCache.collector.tools.values()].reduce((s, x) => s + x.totalDurationMs, 0)}ms`)
  if (noCache.result.totalUsage.costUsd && withCache.result.totalUsage.costUsd) {
    const costDelta = withCache.result.totalUsage.costUsd - noCache.result.totalUsage.costUsd
    console.log(`  cost:                     $${withCache.result.totalUsage.costUsd.toFixed(5)} vs $${noCache.result.totalUsage.costUsd.toFixed(5)}   ${costDelta < 0 ? C.green : C.yellow}(${costDelta >= 0 ? '+' : ''}$${costDelta.toFixed(5)})${C.reset}`)
  }
  console.log(`  agent answered correctly: ${withCache.finalText.toLowerCase().includes('done') ? C.green + 'YES' : C.yellow + 'PARTIAL'}${C.reset}`)
}

// ────────────────────────────────────────────────────────────────────────
// Scenario D — snapshot vs summarize compaction
// ────────────────────────────────────────────────────────────────────────

async function scenarioD(): Promise<void> {
  console.log(`\n${C.bold}${C.magenta}═══ SCENARIO D — Compaction strategy (snapshot vs summarize) ═══${C.reset}`)
  console.log(`${C.dim}Task that builds enough message history to trigger compaction.${C.reset}`)
  console.log(`${C.dim}Snapshot is deterministic + free (no LLM call); summarize uses tokens.${C.reset}`)

  const task =
    'Read 4 files: src/messages/truncate.ts, src/tools/result-cache.ts, src/compaction/snapshot.ts, src/messages/types.ts. ' +
    'For each, say one sentence about what it does. Then in a final sentence summarize all 4.'

  const sum = await runOnce(
    `D1: COMPACTION = summarize`,
    { capBytes: 8_000, compactionStrategy: 'summarize', compactAtMessages: 6 },
    task,
  )
  printOutcome(sum)

  const snap = await runOnce(
    `D2: COMPACTION = snapshot (no LLM call)`,
    { capBytes: 8_000, compactionStrategy: 'snapshot', compactAtMessages: 6 },
    task,
  )
  printOutcome(snap)

  console.log(`\n${C.bold}━━ DELTA (D2 vs D1) ━━${C.reset}`)
  console.log(`  wall:                  ${snap.wallMs}ms vs ${sum.wallMs}ms   ${snap.wallMs < sum.wallMs ? C.green : C.yellow}(${snap.wallMs - sum.wallMs >= 0 ? '+' : ''}${snap.wallMs - sum.wallMs}ms)${C.reset}`)
  console.log(`  total cacheCreate:     ${snap.result.totalUsage.cacheCreationTokens.toLocaleString()} vs ${sum.result.totalUsage.cacheCreationTokens.toLocaleString()}`)
  if (sum.result.totalUsage.costUsd && snap.result.totalUsage.costUsd) {
    const costDelta = snap.result.totalUsage.costUsd - sum.result.totalUsage.costUsd
    console.log(`  cost:                  $${snap.result.totalUsage.costUsd.toFixed(5)} vs $${sum.result.totalUsage.costUsd.toFixed(5)}   ${costDelta < 0 ? C.green : C.yellow}(${costDelta >= 0 ? '+' : ''}$${costDelta.toFixed(5)})${C.reset}`)
  }
  console.log(`  both answered:         summarize=${sum.finalText.length > 30 ? C.green + 'YES' : C.red + 'NO'}${C.reset}  snapshot=${snap.finalText.length > 30 ? C.green + 'YES' : C.red + 'NO'}${C.reset}`)
}

// ────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────

async function main() {
  const needsApi = ['a', 'c', 'd', 'both', 'wave2'].includes(SCENARIO)
  if (!process.env.ANTHROPIC_API_KEY && needsApi) {
    console.error(`${C.red}ANTHROPIC_API_KEY is not set.${C.reset}`)
    console.error(`Run with: ${C.dim}set -a; source ../../.env; set +a; bun run scripts/bench-context-savings.ts${C.reset}`)
    process.exit(1)
  }

  if (SCENARIO === 'a' || SCENARIO === 'both') await scenarioA()
  if (SCENARIO === 'b' || SCENARIO === 'both') scenarioB()
  if (SCENARIO === 'c' || SCENARIO === 'wave2') await scenarioC()
  if (SCENARIO === 'd' || SCENARIO === 'wave2') await scenarioD()

  console.log(`\n${C.dim}Done.${C.reset}\n`)
}

main().catch((err) => {
  console.error(`${C.red}Bench failed:${C.reset}`, err)
  process.exit(1)
})
