#!/usr/bin/env npx tsx
/**
 * Interactive Chat REPL
 *
 * Multi-turn conversation with streaming responses.
 * Optionally enable tools for an agent-style chat.
 *
 * Usage:
 *   npx tsx examples/chat.ts
 *   npx tsx examples/chat.ts --model openai:gpt-4o --tools
 */

import * as readline from 'node:readline/promises'
import { Loom, builtinTools, type LoomEvent } from '../src/index.js'
import { Session, createSession } from '../src/core/session.js'
import { resolveProvider } from '../src/provider/registry.js'
import { createDefaultConfig, mergeConfig } from '../src/core/config.js'
import type { Tool } from '../src/tools/types.js'

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
}

// Parse args
let model = 'anthropic:claude-sonnet-4-20250514'
let useTools = false
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]!
  if (arg === '--model' || arg === '-m') model = process.argv[++i] ?? model
  else if (arg === '--tools' || arg === '-t') useTools = true
}

const tools: Tool[] = useTools ? builtinTools : []
const { provider } = resolveProvider(model)
const config = mergeConfig(createDefaultConfig(model), {
  systemPrompt: 'You are a helpful assistant.' + (useTools ? ' You have filesystem and shell tools.' : ''),
  maxTurns: 20,
})
const session = new Session({ config, provider, tools })

// REPL
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

console.log(`${C.bold}Loom Chat${C.reset} ${C.dim}(${model})${C.reset}`)
if (useTools) console.log(`${C.dim}Tools enabled: ${tools.map(t => t.name).join(', ')}${C.reset}`)
console.log(`${C.dim}Type /quit to exit, /clear to reset, /usage to see totals\n${C.reset}`)

let totalIn = 0
let totalOut = 0
let totalTurns = 0

while (true) {
  const input = await rl.question(`${C.green}You:${C.reset} `)

  if (!input.trim()) continue
  if (input.trim() === '/quit') break
  if (input.trim() === '/clear') {
    console.log(`${C.dim}Session cleared.${C.reset}\n`)
    // Create fresh session
    const newConfig = mergeConfig(createDefaultConfig(model), {
      systemPrompt: config.systemPrompt,
      maxTurns: 20,
    })
    Object.assign(session, new Session({ config: newConfig, provider, tools }))
    totalIn = 0; totalOut = 0; totalTurns = 0
    continue
  }
  if (input.trim() === '/usage') {
    console.log(`${C.dim}Total: ${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out | Turns: ${totalTurns}${C.reset}\n`)
    continue
  }
  if (input.trim() === '/tools') {
    if (tools.length === 0) {
      console.log(`${C.dim}No tools enabled. Use --tools flag.${C.reset}\n`)
    } else {
      for (const t of tools) {
        console.log(`  ${C.cyan}${t.name}${C.reset} — ${t.description.slice(0, 60)}`)
      }
      console.log()
    }
    continue
  }

  process.stdout.write(`\n${C.cyan}Assistant:${C.reset} `)

  const gen = session.submitMessage(input)
  let result = await gen.next()

  while (!result.done) {
    const event: LoomEvent = result.value
    if (event.type === 'text.delta') {
      process.stdout.write(event.text)
    } else if (event.type === 'tool.call.start') {
      process.stdout.write(`\n${C.dim}[${event.toolName}]${C.reset} `)
    } else if (event.type === 'tool.call.end') {
      process.stdout.write(event.isError ? `${C.red}error${C.reset} ` : `${C.green}done${C.reset} `)
    } else if (event.type === 'error') {
      process.stdout.write(`\n${C.red}Error: ${event.message}${C.reset}`)
    }
    result = await gen.next()
  }

  const loopResult = result.value
  totalIn += loopResult.totalUsage.inputTokens
  totalOut += loopResult.totalUsage.outputTokens
  totalTurns += loopResult.turnCount

  console.log(`\n${C.dim}[Turn ${totalTurns} | ${loopResult.totalUsage.inputTokens} in, ${loopResult.totalUsage.outputTokens} out]${C.reset}\n`)
}

rl.close()
console.log(`\n${C.dim}Total: ${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out | Turns: ${totalTurns}${C.reset}`)
