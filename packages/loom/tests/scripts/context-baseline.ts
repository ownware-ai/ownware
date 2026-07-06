/**
 * Context Baseline — what does an empty session cost?
 *
 * Measures the system-prompt + tools footprint a profile pays BEFORE
 * any messages are exchanged. Useful as the loom-side audit of "what
 * are we shipping in the prompt" — pairs with `Session.getContextUsage()`.
 *
 * Run:
 *   bun run scripts/context-baseline.ts
 *
 * No API key required — uses the local chars/4 estimator.
 */

import { PromptBuilder } from '../src/prompt/builder.js'
import {
  createSystemFragment,
  createSecurityPolicyFragment,
  createCompactionFragment,
  createThinkingFrequencyFragment,
} from '../src/prompt/fragments/system.js'
import {
  createSafetyFragment,
  createEngineeringDisciplineFragment,
} from '../src/prompt/fragments/behavior.js'
import { createOutputFragment } from '../src/prompt/fragments/output.js'
import { createToolUsageFragment } from '../src/prompt/fragments/tools.js'
import { createContextFragment } from '../src/prompt/fragments/context.js'
import { createIdentityFragment } from '../src/prompt/fragments/identity.js'

import { builtinTools } from '../src/tools/builtins/index.js'
import { measureContextUsage } from '../src/context/usage.js'

import type { Tool } from '../src/tools/types.js'

const MODEL = 'openrouter:kimi-k2.5'

const SAMPLE_SOUL = `You are a focused general-purpose assistant. Reply briefly. Treat <system-reminder>
tags as harness instructions and act on them. Match work to the user's request:
when they ask you to read code, read it; when they ask for analysis, analyse;
when ambiguous, ask one clarifying question before acting.`

function buildBaselinePrompt(tools: Tool[]): string {
  const builder = new PromptBuilder()
    .addFragment(createIdentityFragment(SAMPLE_SOUL))
    .addFragment(createSystemFragment())
    .addFragment(createSecurityPolicyFragment())
    .addFragment(createSafetyFragment())
    .addFragment(createEngineeringDisciplineFragment())
    .addFragment(createOutputFragment())
    .addFragment(createThinkingFrequencyFragment())
    .addFragment(createCompactionFragment())
    .addFragment(createToolUsageFragment(tools))
    .addFragment(createContextFragment({
      date: '2026-05-06',
      platform: 'darwin',
      cwd: '/work/repo',
      gitBranch: 'main',
    }))
  return builder.build().text
}

function fmt(n: number): string {
  return n.toLocaleString()
}

function pct(used: number, total: number): string {
  if (total <= 0) return '0.0%'
  return `${((used / total) * 100).toFixed(1)}%`
}

function bar(used: number, total: number, width = 40): string {
  const filled = Math.round((Math.min(used, total) / total) * width)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

async function main(): Promise<void> {
  // The "everything we ship" tool list — every builtin loom registers.
  const tools = builtinTools

  const systemPrompt = buildBaselinePrompt(tools)

  const usage = await measureContextUsage({
    model: MODEL,
    systemPrompt,
    messages: [],
    tools,
  })

  // ---- header ----
  console.log('')
  console.log(`  /context (Ownware baseline — empty session)`)
  console.log(`  ┌${'─'.repeat(70)}┐`)
  console.log(`  │ Model:    ${MODEL.padEnd(58)}│`)
  console.log(`  │ Window:   ${fmt(usage.contextWindow).padEnd(58)}│`)
  console.log(`  │ Used:     ${(`${fmt(usage.used)} (${pct(usage.used, usage.contextWindow)})`).padEnd(58)}│`)
  console.log(`  │ Free:     ${(`${fmt(usage.free)} (${pct(usage.free, usage.contextWindow)})`).padEnd(58)}│`)
  console.log(`  │ Method:   ${usage.method.padEnd(58)}│`)
  console.log(`  └${'─'.repeat(70)}┘`)
  console.log('')
  console.log(`  ${bar(usage.used, usage.contextWindow, 40)}  ${pct(usage.used, usage.contextWindow)}`)
  console.log('')

  // ---- breakdown ----
  console.log('  Estimated usage by category:')
  const rows: Array<[string, number]> = [
    ['System prompt', usage.breakdown.systemPrompt],
    ['System tools',  usage.breakdown.tools],
    ['Memory files',  usage.breakdown.memory],
    ['Skills',        usage.breakdown.skills],
    ['Messages',      usage.breakdown.messages],
    ['Free space',    usage.free],
  ]
  for (const [label, n] of rows) {
    const pad = label.padEnd(15)
    const num = fmt(n).padStart(8)
    const p = pct(n, usage.contextWindow).padStart(6)
    console.log(`    ${pad} ${num} tokens  ${p}`)
  }

  console.log('')

  // ---- how many tools, how big each? ----
  console.log(`  Tools shipped: ${tools.length}`)
  const sizes = tools
    .map(t => ({ name: t.name, tokens: estimate(t) }))
    .sort((a, b) => b.tokens - a.tokens)
  console.log(`  Top 10 by token cost:`)
  for (const { name, tokens } of sizes.slice(0, 10)) {
    console.log(`    - ${name.padEnd(25)} ${fmt(tokens).padStart(6)} tokens`)
  }
  console.log(`  Tail: ${sizes.length - 10} more tools share ${fmt(sizes.slice(10).reduce((a, b) => a + b.tokens, 0))} tokens.`)
  console.log('')
}

function estimate(tool: Tool): number {
  const wire = `${tool.name}\n${tool.description}\n${JSON.stringify(tool.inputSchema)}`
  return Math.max(1, Math.ceil(wire.length / 4))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
