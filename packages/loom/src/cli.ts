#!/usr/bin/env node
/**
 * Loom CLI Runner
 *
 * Run agents from the terminal:
 *   npx loom "What is 2+2?"
 *   npx loom --model openai:gpt-4o --tools "Read package.json"
 *   npx loom --json "Hello" | jq .
 */

import { Loom } from './index.js'
import { createBuiltinTools } from './tools/builtins/index.js'
import { pickDefaultModel, NO_PROVIDER_INSTRUCTION } from './provider/auto-pick.js'
import { ollamaInstallHint } from './provider/ollama.js'
import type { LoomEvent } from './core/events.js'

// ---------------------------------------------------------------------------
// ANSI colors (no chalk dependency)
// ---------------------------------------------------------------------------

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
}

// ---------------------------------------------------------------------------
// Arg parsing (manual — no external deps)
// ---------------------------------------------------------------------------

interface CliArgs {
  prompt: string
  model: string
  tools: boolean
  system: string
  mode: 'ask' | 'auto' | 'deny'
  maxTurns: number
  maxTokens: number
  verbose: boolean
  json: boolean
  help: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    prompt: '',
    // Empty = auto-pick at run time: first cloud key found in the env,
    // else a reachable local Ollama, else one actionable instruction.
    model: '',
    tools: false,
    system: '',
    mode: 'ask',
    maxTurns: 50,
    maxTokens: 16_384,
    verbose: false,
    json: false,
    help: false,
  }

  const positional: string[] = []
  let i = 0

  while (i < argv.length) {
    const arg = argv[i]!

    switch (arg) {
      case '--help':
      case '-h':
        args.help = true
        break
      case '--model':
      case '-m':
        args.model = argv[++i] ?? args.model
        break
      case '--tools':
      case '-t':
        args.tools = true
        break
      case '--system':
      case '-s':
        args.system = argv[++i] ?? ''
        break
      case '--mode':
        args.mode = (argv[++i] ?? 'ask') as CliArgs['mode']
        break
      case '--max-turns':
        args.maxTurns = parseInt(argv[++i] ?? '50', 10)
        break
      case '--max-tokens':
        args.maxTokens = parseInt(argv[++i] ?? '16384', 10)
        break
      case '--verbose':
      case '-v':
        args.verbose = true
        break
      case '--json':
        args.json = true
        break
      default:
        if (!arg.startsWith('-')) {
          positional.push(arg)
        }
    }
    i++
  }

  args.prompt = positional.join(' ')
  return args
}

function printHelp(): void {
  console.log(`
${c.bold}Loom${c.reset} — Agent runtime CLI

${c.bold}USAGE${c.reset}
  loom [options] <prompt>

${c.bold}ARGUMENTS${c.reset}
  <prompt>              The task or question (required)

${c.bold}OPTIONS${c.reset}
  -m, --model <model>   Model string (default: auto — first cloud key in env, else local Ollama)
  -t, --tools           Enable built-in tools (filesystem + shell)
  -s, --system <prompt> Custom system prompt
  --mode <mode>         Permission mode: ask (default), auto, deny
  --max-turns <n>       Maximum turns (default: 50)
  --max-tokens <n>      Max output tokens per turn (default: 16384)
  -v, --verbose         Show all events (sessions, turns, permissions)
  --json                Output events as JSON lines (for piping)
  -h, --help            Show this help

${c.bold}EXAMPLES${c.reset}
  loom "What is 2+2?"
  loom -m openai:gpt-4o "Explain quantum computing"
  loom --tools "Read package.json and explain this project"
  loom --mode auto --tools "Create a hello world app"
  loom --json "Hello" | jq '.type'
  loom -s "You are a poet" "Write a haiku about TypeScript"
`)
}

// ---------------------------------------------------------------------------
// Event rendering
// ---------------------------------------------------------------------------

function renderEvent(event: LoomEvent, args: CliArgs): void {
  if (args.json) {
    process.stdout.write(JSON.stringify(event) + '\n')
    return
  }

  switch (event.type) {
    case 'session.start':
      if (args.verbose) {
        console.log(`${c.dim}[session] Started (model: ${event.model})${c.reset}`)
      }
      break

    case 'turn.start':
      if (args.verbose) {
        console.log(`${c.dim}[turn ${event.turnIndex}] Started${c.reset}`)
      }
      break

    case 'text.delta':
      process.stdout.write(event.text)
      break

    case 'text.complete':
      // Newline after streaming text
      break

    case 'tool.call.start':
      console.log(`\n${c.cyan}[tool]${c.reset} ${event.toolName}(${abbreviateInput(event.input)})`)
      break

    case 'tool.call.end':
      if (event.isError) {
        console.log(`${c.red}[error]${c.reset} ${event.toolName}: ${abbreviate(event.result, 200)}`)
      } else {
        console.log(`${c.green}[done]${c.reset} ${event.toolName} ${c.dim}(${event.durationMs}ms)${c.reset}`)
      }
      break

    case 'tool.call.progress':
      if (args.verbose) {
        console.log(`${c.dim}[progress]${c.reset} ${event.progress}`)
      }
      break

    case 'compaction.start':
      if (args.verbose) {
        console.log(`${c.yellow}[compaction]${c.reset} ${event.strategy} (${event.preTokenCount} tokens)`)
      }
      break

    case 'compaction.end':
      if (args.verbose) {
        console.log(`${c.yellow}[compaction]${c.reset} ${event.preTokenCount} → ${event.postTokenCount} tokens`)
      }
      break

    case 'recovery':
      if (args.verbose) {
        console.log(`${c.yellow}[recovery]${c.reset} ${event.reason}: ${event.detail}`)
      }
      break

    case 'permission.request':
      if (args.verbose) {
        console.log(`${c.magenta}[permission]${c.reset} Requesting: ${event.toolName}`)
      }
      break

    case 'permission.response':
      if (args.verbose) {
        console.log(`${c.magenta}[permission]${c.reset} ${event.granted ? 'Approved' : 'Denied'}`)
      }
      break

    case 'security.block':
      console.log(`${c.red}[security]${c.reset} Blocked: ${event.reason}`)
      break

    case 'turn.end':
      if (args.verbose) {
        console.log(`${c.dim}[turn ${event.turnIndex}] Ended (${event.stopReason}, ${event.usage.outputTokens} output tokens)${c.reset}`)
      }
      break

    case 'error':
      console.error(`${c.red}[error]${c.reset} ${event.code}: ${event.message}`)
      // Connection failures against a local model almost always mean the
      // Ollama server isn't up — say so instead of leaving a bare error.
      if (args.model.startsWith('ollama:') && /connection/i.test(event.message)) {
        console.error(
          `${c.yellow}[hint]${c.reset} Ollama isn't running (or isn't installed). Start it with 'ollama serve' — or ${ollamaInstallHint()} — then retry.`,
        )
      }
      break
  }
}

function abbreviateInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input)
  if (entries.length === 0) return ''
  return entries
    .slice(0, 3)
    .map(([k, v]) => {
      const val = typeof v === 'string' ? `"${abbreviate(v, 40)}"` : JSON.stringify(v)
      return `${k}: ${val}`
    })
    .join(', ')
}

function abbreviate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '...'
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    printHelp()
    process.exit(0)
  }

  if (!args.prompt) {
    console.error(`${c.red}Error:${c.reset} No prompt provided. Use --help for usage.`)
    process.exit(1)
  }

  // No --model? Auto-pick from the environment: first cloud key found,
  // else a reachable local Ollama, else one actionable instruction.
  if (!args.model) {
    const picked = await pickDefaultModel()
    if (!picked) {
      console.error(`${c.red}Error:${c.reset} ${NO_PROVIDER_INSTRUCTION}`)
      process.exit(1)
    }
    args.model = picked
    if (!args.json) {
      console.log(`${c.dim}[model] ${args.model} (auto-selected)${c.reset}`)
    }
  }

  // Run
  const startTime = Date.now()
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let turnCount = 0

  try {
    // Build agent
    const tools = args.tools ? createBuiltinTools() : []
    const agent = new Loom({
      model: args.model,
      systemPrompt: args.system || undefined,
      tools,
      config: {
        maxTurns: args.maxTurns,
        maxTokens: args.maxTokens,
      },
    })

    // Handle Ctrl+C
    process.on('SIGINT', () => {
      agent.abort()
      if (!args.json) {
        console.log(`\n${c.dim}Aborted.${c.reset}`)
      }
      process.exit(130)
    })
    const gen = agent.run(args.prompt)
    let result = await gen.next()

    while (!result.done) {
      renderEvent(result.value, args)
      result = await gen.next()
    }

    // Final stats from LoopResult
    const loopResult = result.value
    totalInputTokens = loopResult.totalUsage.inputTokens
    totalOutputTokens = loopResult.totalUsage.outputTokens
    turnCount = loopResult.turnCount

    // Print usage footer (unless JSON mode)
    if (!args.json) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      const cost = loopResult.totalUsage.costUsd
      console.log(`\n${c.dim}Tokens: ${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out | Cost: $${cost.toFixed(4)} | Turns: ${turnCount} | Time: ${elapsed}s${c.reset}`)
    }
  } catch (error) {
    if (!args.json) {
      console.error(`\n${c.red}Fatal:${c.reset} ${error instanceof Error ? error.message : String(error)}`)
    } else {
      console.error(JSON.stringify({ type: 'fatal', message: String(error) }))
    }
    process.exit(1)
  }
}

main()
