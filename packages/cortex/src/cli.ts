#!/usr/bin/env node
/**
 * Ownware CLI
 *
 * Get an agent live:
 *   ownware init                              — drop a starter profile in ./profiles
 *   ownware serve                             — serve ./profiles as an HTTP+SSE gateway
 *   ownware key add anthropic                 — save a provider key (encrypted vault)
 *   ownware channel add slack …               — connect a messaging channel
 *
 * Run agent profiles from the terminal:
 *   ownware profiles                          — list all profiles
 *   ownware run sentinel "Review example.com" — run a profile (no gateway needed)
 *   ownware run coder --workspace ./my-app "Fix the bug"
 *
 * The verb modules (cli/*.ts) are imported lazily per command so the
 * light commands stay instant.
 */

import { resolve } from 'node:path'
import { Session, AgentSpawner, mergeConfig } from '@ownware/loom'
import type { LoomEvent } from '@ownware/loom'
import { ProfileRegistry } from './profile/registry.js'
import { assembleAgent } from './profile/assembler.js'
import { hookBindingOptionsFromEnv } from './profile/hooks.js'
import { findProfilesDir } from './cli/profiles-dir.js'
import { CORTEX_VERSION } from './version.js'

// ---------------------------------------------------------------------------
// ANSI colors (zero deps)
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
  blue: '\x1b[34m',
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  command: 'run' | 'profiles' | 'profile' | 'help' | 'version' | 'init' | 'serve' | 'key' | 'channel' | 'schedule'
  profile: string
  prompt: string
  workspace: string
  verbose: boolean
  json: boolean
  /** Raw argv after the verb — the verb modules do their own parsing. */
  rest: string[]
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: 'help',
    profile: '',
    prompt: '',
    workspace: process.cwd(),
    verbose: false,
    json: false,
    rest: [],
  }

  if (argv.length === 0) return args

  const cmd = argv[0]!
  if (cmd === 'profiles' || cmd === 'list') {
    args.command = 'profiles'
    return args
  }
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    args.command = 'help'
    return args
  }
  if (cmd === 'version' || cmd === '--version' || cmd === '-V') {
    args.command = 'version'
    return args
  }
  // Verbs with their own arg handling. Checked BEFORE the shorthand so
  // `ownware serve` can never be misread as "run the profile named serve".
  if (
    cmd === 'init' ||
    cmd === 'serve' ||
    cmd === 'key' ||
    cmd === 'channel' ||
    cmd === 'schedule' ||
    cmd === 'profile'
  ) {
    args.command = cmd
    args.rest = argv.slice(1)
    return args
  }
  if (cmd === 'run') {
    args.command = 'run'
    const rest = argv.slice(1)
    const positional: string[] = []
    let i = 0

    while (i < rest.length) {
      const arg = rest[i]!
      switch (arg) {
        case '--workspace':
        case '-w':
          args.workspace = resolve(rest[++i] ?? '.')
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

    args.profile = positional[0] ?? ''
    args.prompt = positional.slice(1).join(' ')
    return args
  }

  // Shorthand: ownware sentinel "prompt" (no "run" subcommand)
  args.command = 'run'
  args.profile = cmd
  const rest = argv.slice(1)
  const positional: string[] = []
  let i = 0

  while (i < rest.length) {
    const arg = rest[i]!
    switch (arg) {
      case '--workspace':
      case '-w':
        args.workspace = resolve(rest[++i] ?? '.')
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

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
${c.bold}Ownware${c.reset} — build your own agent, run it yourself, reach it everywhere

${c.bold}BUILD & RUN AN AGENT${c.reset}
  ownware profile new <name> [--model <m>] [--open]   Create ./profiles/<name>
  ownware profile list                                List your profiles
  ownware profile show <name>                         Inspect one
  ownware profile set  <name> --model <m>             Edit its config
  ownware profile open <name>                         Open its folder
  ownware profile remove <name>                       Delete it
  ownware init                                        Shorthand: profile new assistant
  ownware run <profile> [options] "<prompt>"          Talk to it — no gateway needed
  ownware <profile> "<prompt>"                        Shorthand for run

${c.bold}SERVE & REACH IT EVERYWHERE${c.reset}
  ownware serve [--port N] [--host H]                 Serve ./profiles as an HTTP+SSE gateway
                                                   (boots stored channels; --no-channels opts out)
  ownware key add <provider> [value]                  Save a provider API key (encrypted vault)
  ownware key list | remove <provider>
  ownware channel add <kind> --profile <id> …         Connect Slack/Telegram/Discord/WhatsApp/SMS
  ownware channel list | remove | approve | start
  ownware schedule add --profile <id> …               Proactive runs ("messages you every morning")
  ownware schedule list | remove <id> | runs <id>

${c.bold}OPTIONS (run)${c.reset}
  -w, --workspace <path>   Working directory for the agent (default: cwd)
  -v, --verbose            Show all events (turns, permissions, compaction)
  --json                   Output events as JSON lines
  -h, --help               Show this help
  -V, --version            Print the ownware version

${c.bold}EXAMPLES${c.reset}
  ownware profile new sales --open        # create a profile + open the folder
  ownware run sales "draft a follow-up to Acme"
  ownware key add anthropic
  ownware channel add slack --profile sales --bot-token xoxb-… --app-token xapp-…
  ownware serve
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

    case 'agent.spawn':
      console.log(`${c.magenta}[agent]${c.reset} Spawned: ${event.agentId} ${c.dim}(profile: ${event.profileName})${c.reset}`)
      break

    case 'agent.complete':
      console.log(`${c.magenta}[agent]${c.reset} Completed: ${event.agentId} ${c.dim}(${event.durationMs}ms)${c.reset}`)
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

    case 'permission.request':
      if (args.verbose) {
        console.log(`${c.magenta}[permission]${c.reset} Requesting: ${event.toolName}`)
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
// Commands
// ---------------------------------------------------------------------------

async function runProfile(args: CliArgs): Promise<void> {
  if (!args.profile) {
    console.error(`${c.red}Error:${c.reset} No profile specified. Use "ownware profiles" to see available profiles.`)
    process.exit(1)
  }

  if (!args.prompt) {
    console.error(`${c.red}Error:${c.reset} No prompt provided.`)
    console.error(`Usage: ownware run ${args.profile} "Your prompt here"`)
    process.exit(1)
  }

  const profilesDir = findProfilesDir()
  const registry = new ProfileRegistry()
  await registry.discover(profilesDir)

  if (!registry.has(args.profile)) {
    console.error(`${c.red}Error:${c.reset} Profile "${args.profile}" not found.`)
    console.error(`Available: ${registry.list().map(p => p.name).join(', ')}`)
    process.exit(1)
  }

  const profile = await registry.get(args.profile)
  // Hook policy from env (OWNWARE_ALLOW_COMMAND_HOOKS / allowlist) — same
  // opt-ins as the gateway, so a profile behaves identically under
  // `ownware run` and `ownware serve`. No redactValues here: the terminal run
  // path has no thread credential runtime wired.
  const assembled = await assembleAgent(profile, { hooks: hookBindingOptionsFromEnv() })

  if (!args.json) {
    console.log(`\n${c.bold}Ownware${c.reset} ${c.dim}·${c.reset} ${c.cyan}${profile.config.name}${c.reset} ${c.dim}· ${profile.config.model}${c.reset}`)
    if (profile.config.description) {
      console.log(`${c.dim}${profile.config.description}${c.reset}`)
    }
    console.log()
  }

  // Merge workspace into config
  const baseConfig = args.workspace !== process.cwd()
    ? mergeConfig(assembled.config, { workspacePath: args.workspace })
    : assembled.config

  // Wire sub-agent spawner
  const spawner = new AgentSpawner({
    provider: assembled.provider,
    tools: assembled.tools,
    config: baseConfig,
  })

  const subagentDefs = profile.config.subagents.reduce<Record<string, {
    model?: string; tools?: string[]; systemPrompt?: string
  }>>((acc, sa) => {
    acc[sa.name] = {
      model: sa.model,
      tools: sa.tools?.allow?.length ? sa.tools.allow : undefined,
      systemPrompt: sa.systemPrompt,
    }
    return acc
  }, {})

  const sessionConfig = Object.assign({}, baseConfig, {
    agentSpawner: spawner,
    subagentDefs,
  })

  const session = new Session({
    config: sessionConfig,
    provider: assembled.provider,
    tools: assembled.tools,
    checkpoint: assembled.checkpointStore,
    // Profile-declared lifecycle hooks — both fields ship together so
    // hook outcomes stay model-visible (see AssembledAgent contract).
    ...(assembled.hookRuntime ? { hooks: assembled.hookRuntime } : {}),
    ...(assembled.reminderInjector ? { reminders: assembled.reminderInjector } : {}),
  })

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    session.abort()
    if (!args.json) {
      console.log(`\n${c.dim}Aborted.${c.reset}`)
    }
    process.exit(130)
  })

  const startTime = Date.now()

  try {
    const gen = session.submitMessage(args.prompt)
    let result = await gen.next()

    while (!result.done) {
      renderEvent(result.value as LoomEvent, args)
      result = await gen.next()
    }

    // Print footer
    if (!args.json) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(`\n${c.dim}Time: ${elapsed}s${c.reset}`)
    }
  } catch (error) {
    if (!args.json) {
      console.error(`\n${c.red}Fatal:${c.reset} ${error instanceof Error ? error.message : String(error)}`)
    } else {
      console.error(JSON.stringify({ type: 'fatal', message: String(error) }))
    }
    process.exit(1)
  } finally {
    // Clean up MCP connections
    if (assembled.mcpManager) {
      await assembled.mcpManager.shutdown()
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  switch (args.command) {
    case 'help':
      printHelp()
      break
    case 'version':
      console.log(`ownware ${CORTEX_VERSION}`)
      break
    case 'profiles': {
      // `ownware profiles` is an alias of `ownware profile list`.
      const { profileCommand } = await import('./cli/profile.js')
      await profileCommand(['list'])
      break
    }
    case 'profile': {
      const { profileCommand } = await import('./cli/profile.js')
      await profileCommand(args.rest)
      break
    }
    case 'run':
      await runProfile(args)
      break
    case 'init': {
      const { initCommand } = await import('./cli/init.js')
      initCommand(args.rest)
      break
    }
    case 'serve': {
      const { serveCommand } = await import('./cli/serve.js')
      await serveCommand(args.rest)
      break
    }
    case 'key': {
      const { keyCommand } = await import('./cli/key.js')
      await keyCommand(args.rest)
      break
    }
    case 'channel': {
      const { channelCommand } = await import('./cli/channel.js')
      await channelCommand(args.rest)
      break
    }
    case 'schedule': {
      const { scheduleCommand } = await import('./cli/schedule.js')
      await scheduleCommand(args.rest)
      break
    }
  }
}

main().catch((err) => {
  console.error(`${c.red}Error:${c.reset} ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
