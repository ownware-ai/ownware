#!/usr/bin/env npx tsx
/**
 * Coding Agent Example
 *
 * A complete coding agent with filesystem and shell tools.
 * Reads files, edits code, runs commands — with permission prompts.
 *
 * Usage:
 *   npx tsx examples/coding-agent.ts "Add error handling to src/utils.ts"
 *   npx tsx examples/coding-agent.ts "Write tests for the User model"
 */

import { Loom, builtinTools, type LoomEvent } from '../../src/index.js'

// ANSI colors
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
}

const task = process.argv.slice(2).join(' ')
if (!task) {
  console.log(`${C.bold}Coding Agent${C.reset}`)
  console.log(`Usage: npx tsx examples/coding-agent.ts "your task"`)
  process.exit(1)
}

const agent = Loom.create('anthropic:claude-sonnet-4-20250514')
  .withSystemPrompt(
    'You are an expert software engineer. You have access to filesystem and shell tools. ' +
    'Read files before editing. Run tests after changes. Be precise and minimal.',
  )
  .withTools(builtinTools)
  .withMaxTurns(30)
  .build()

// Handle Ctrl+C
process.on('SIGINT', () => {
  agent.abort()
  console.log(`\n${C.dim}Aborted.${C.reset}`)
  process.exit(130)
})

console.log(`${C.bold}Coding Agent${C.reset} ${C.dim}(anthropic:claude-sonnet-4-20250514)${C.reset}`)
console.log(`${C.dim}Task: ${task}${C.reset}\n`)

const gen = agent.run(task)
let result = await gen.next()

while (!result.done) {
  const event: LoomEvent = result.value

  switch (event.type) {
    case 'text.delta':
      process.stdout.write(event.text)
      break
    case 'tool.call.start':
      console.log(`\n${C.cyan}[${event.toolName}]${C.reset} ${abbreviate(JSON.stringify(event.input), 80)}`)
      break
    case 'tool.call.end':
      if (event.isError) {
        console.log(`${C.red}  error:${C.reset} ${abbreviate(event.result, 120)}`)
      } else {
        console.log(`${C.green}  done${C.reset} ${C.dim}(${event.durationMs}ms)${C.reset}`)
      }
      break
    case 'error':
      console.error(`\n${C.red}Error: ${event.message}${C.reset}`)
      break
  }

  result = await gen.next()
}

const loopResult = result.value
console.log(`\n${C.dim}─────────────────────────────────────────${C.reset}`)
console.log(`${C.dim}Tokens: ${loopResult.totalUsage.inputTokens.toLocaleString()} in / ${loopResult.totalUsage.outputTokens.toLocaleString()} out | Turns: ${loopResult.turnCount} | Reason: ${loopResult.reason}${C.reset}`)

function abbreviate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '...'
}
