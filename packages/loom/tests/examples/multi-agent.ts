#!/usr/bin/env npx tsx
/**
 * Multi-Agent Pipeline Example
 *
 * Three agents with different roles work in sequence:
 *   Researcher → Writer → Reviewer
 *
 * Shows agent isolation, result passing, and different configs per agent.
 *
 * Usage:
 *   npx tsx examples/multi-agent.ts "Analyze the authentication module"
 *   npx tsx examples/multi-agent.ts "Explain how the build system works"
 */

import { Loom, collectResult, filesystemTools, type RunResult } from '../src/index.js'

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', magenta: '\x1b[35m',
}

const topic = process.argv.slice(2).join(' ')
if (!topic) {
  console.log(`${C.bold}Multi-Agent Pipeline${C.reset}`)
  console.log(`Usage: npx tsx examples/multi-agent.ts "your topic"`)
  process.exit(1)
}

// Handle Ctrl+C
process.on('SIGINT', () => {
  console.log(`\n${C.dim}Aborted.${C.reset}`)
  process.exit(130)
})

console.log(`${C.bold}Multi-Agent Pipeline${C.reset}`)
console.log(`${C.dim}Topic: ${topic}${C.reset}`)
console.log(`${C.dim}Pipeline: Researcher → Writer → Reviewer${C.reset}\n`)

// ---------------------------------------------------------------------------
// Agent 1: Researcher — has filesystem tools, reads code
// ---------------------------------------------------------------------------

console.log(`${C.cyan}${C.bold}[1/3] Researcher${C.reset} ${C.dim}gathering information...${C.reset}`)

const research = await runAgent(
  'Researcher',
  'anthropic:claude-sonnet-4-20250514',
  'You are a senior software engineer doing a code review. ' +
  'Read relevant files, search for patterns, and produce a thorough analysis. ' +
  'Output ONLY your findings — no introduction or conclusion.',
  `Research this topic thoroughly: ${topic}`,
  filesystemTools,
)

console.log(`${C.green}  Done${C.reset} ${C.dim}(${research.usage.inputTokens} in / ${research.usage.outputTokens} out)${C.reset}\n`)

// ---------------------------------------------------------------------------
// Agent 2: Writer — no tools, writes from research
// ---------------------------------------------------------------------------

console.log(`${C.yellow}${C.bold}[2/3] Writer${C.reset} ${C.dim}drafting report...${C.reset}`)

const report = await runAgent(
  'Writer',
  'anthropic:claude-sonnet-4-20250514',
  'You are a technical writer. Transform research findings into a clear, well-structured report. ' +
  'Use headings, bullet points, and code examples where relevant. ' +
  'Write for a developer audience.',
  `Write a technical report based on these research findings:\n\n${research.text}`,
  [],
)

console.log(`${C.green}  Done${C.reset} ${C.dim}(${report.usage.inputTokens} in / ${report.usage.outputTokens} out)${C.reset}\n`)

// ---------------------------------------------------------------------------
// Agent 3: Reviewer — no tools, reviews the report
// ---------------------------------------------------------------------------

console.log(`${C.magenta}${C.bold}[3/3] Reviewer${C.reset} ${C.dim}reviewing report...${C.reset}`)

const review = await runAgent(
  'Reviewer',
  'anthropic:claude-sonnet-4-20250514',
  'You are a senior tech lead reviewing a report. ' +
  'Check for accuracy, completeness, and clarity. ' +
  'Output a brief review with: strengths, issues, and a final verdict (approve/revise).',
  `Review this technical report:\n\n${report.text}`,
  [],
)

console.log(`${C.green}  Done${C.reset} ${C.dim}(${review.usage.inputTokens} in / ${review.usage.outputTokens} out)${C.reset}\n`)

// ---------------------------------------------------------------------------
// Final output
// ---------------------------------------------------------------------------

console.log(`${C.bold}${'═'.repeat(60)}${C.reset}`)
console.log(`${C.bold}FINAL REPORT${C.reset}\n`)
console.log(report.text)
console.log(`\n${C.bold}${'─'.repeat(60)}${C.reset}`)
console.log(`${C.bold}REVIEW${C.reset}\n`)
console.log(review.text)

// Usage summary
const totalIn = research.usage.inputTokens + report.usage.inputTokens + review.usage.inputTokens
const totalOut = research.usage.outputTokens + report.usage.outputTokens + review.usage.outputTokens
console.log(`\n${C.dim}${'─'.repeat(60)}${C.reset}`)
console.log(`${C.dim}Total: ${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out | 3 agents | ${research.turnCount + report.turnCount + review.turnCount} total turns${C.reset}`)

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

import type { Tool } from '../src/tools/types.js'

async function runAgent(
  name: string,
  model: string,
  systemPrompt: string,
  prompt: string,
  tools: Tool[],
): Promise<RunResult> {
  const agent = Loom.create(model)
    .withSystemPrompt(systemPrompt)
    .withTools(tools)
    .withMaxTurns(15)
    .build()

  // Stream events — show tool calls but don't print text (we collect it)
  const gen = agent.run(prompt)
  let text = ''
  let result = await gen.next()

  while (!result.done) {
    const event = result.value
    if (event.type === 'text.delta') text += event.text
    if (event.type === 'tool.call.start') {
      process.stdout.write(`${C.dim}  [${event.toolName}] ${C.reset}`)
    }
    if (event.type === 'tool.call.end') {
      process.stdout.write(event.isError ? `${C.red}err${C.reset}\n` : `${C.green}ok${C.reset}\n`)
    }
    result = await gen.next()
  }

  return {
    text,
    usage: result.value.totalUsage,
    turnCount: result.value.turnCount,
    reason: result.value.reason,
  }
}
