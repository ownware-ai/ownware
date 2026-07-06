/**
 * End-to-end demo for web_search through the full Cortex path.
 *
 *   bunx tsx examples/web-search-agent-e2e.ts
 *   bunx tsx examples/web-search-agent-e2e.ts --prompt "search for the latest release of bun"
 *
 * Exercises: profile load → assembleAgent WITH WebSearchService →
 * WebSearchToolProvider resolves → configOverlay injects
 * `webSearchStrategy` → Loom's web_search tool runs the strategy → real
 * HTTP to DuckDuckGo → real parsed results → agent consumes them.
 *
 * The DuckDuckGo HTML parser was the failure point surfaced by the
 * "0 results" issue — this script confirms the fix end-to-end against
 * the live endpoint.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LoomEvent } from '@ownware/loom'

const argv = process.argv.slice(2)
const promptIdx = argv.indexOf('--prompt')
const prompt =
  promptIdx >= 0 && argv[promptIdx + 1]
    ? argv[promptIdx + 1]!
    : 'Use the web_search tool to find the official Bun runtime homepage. Return a one-line summary with the URL.'

function loadEnvFile(envPath: string): void {
  if (!fs.existsSync(envPath)) return
  const raw = fs.readFileSync(envPath, 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = val
  }
}

function makeThrowawayProfile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-search-e2e-profile-'))
  const agentJson = {
    name: 'search-e2e',
    description: 'Single-purpose profile for the web_search DDG e2e',
    model: 'anthropic:claude-sonnet-4-20250514',
    maxTurns: 4,
    tools: {
      // "full" pulls in web_search. Deny browser + destructive tools
      // to keep the demo focused.
      preset: 'full',
      deny: [
        'shell_execute', 'edit_file', 'write_file', 'delete_file',
        'browser_navigate', 'browser_click', 'browser_type',
        'browser_screenshot', 'browser_snapshot', 'browser_evaluate',
        'browser_tab_list', 'browser_tab_open', 'browser_tab_close',
        'browser_console', 'browser_hover', 'browser_select',
        'browser_press_key', 'browser_drag', 'browser_fill_form',
        'browser_wait', 'browser_scroll',
      ],
    },
    browser: {
      autoLaunch: false,  // explicit — this demo is about web_search, not browser
    },
    context: { datetime: true, cwd: false, os: false, git: false, project: false },
    security: {
      level: 'permissive',
      zones: { maxAutoZone: 'network' },
    },
    systemPrompt:
      'You are a short-answer search assistant. Call web_search once, then respond with a single sentence that quotes the top result\'s URL.',
  }
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(agentJson, null, 2))
  return dir
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..')
  loadEnvFile(path.join(repoRoot, '.env'))

  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write('[e2e] ANTHROPIC_API_KEY not set.\n')
    process.exit(2)
  }

  // Dynamic imports: Loom's provider clients validate API keys at module
  // load, so we must load `.env` first.
  const { Session } = await import('@ownware/loom')
  const { loadProfile } = await import('../../src/profile/loader.js')
  const { assembleAgent } = await import('../../src/profile/assembler.js')
  const { WebSearchService } = await import('../../src/connector/web-search/service.js')

  log(`[e2e] prompt: ${prompt}`)
  const profileDir = makeThrowawayProfile()
  log(`[e2e] profile at ${profileDir}`)

  try {
    const profile = await loadProfile(profileDir)

    // The gateway passes a process-shared WebSearchService; the service
    // needs a `settings` store with `getSetting`/`setSetting`. Since this
    // demo does not persist anything, we stub those to always return
    // "no user choice" so the resolver falls back to the DDG default.
    const settingsStub = {
      getSetting: (_key: string) => undefined,
      setSetting: (_key: string, _value: string) => ({ key: _key, value: _value }),
    }
    const webSearchService = new WebSearchService({ settings: settingsStub })

    const assembled = await assembleAgent(profile, { webSearchService })
    log(`[e2e] assembled ${assembled.tools.length} tools`)
    const hasWebSearch = assembled.tools.some(t => t.name === 'web_search')
    log(`[e2e] web_search present: ${hasWebSearch}`)
    // Surface the injected strategy so a broken wiring is obvious.
    const strategyBinding =
      (assembled.config as unknown as { webSearchStrategy?: { strategy: { name: string } } })
        .webSearchStrategy
    log(`[e2e] strategy: ${strategyBinding?.strategy.name ?? '(none — would stub)'}`)

    const session = new Session({
      config: assembled.config,
      provider: assembled.provider,
      tools: assembled.tools,
      checkpoint: assembled.checkpointStore,
      requestApproval: async () => true,
    })

    let assistantText = ''
    let turns = 0
    const events = session.submitMessage(prompt)
    let result = await events.next()
    while (!result.done) {
      const evt = result.value
      describeEvent(evt)
      if (evt.type === 'text.delta') assistantText += evt.text
      if (evt.type === 'turn.end') turns += 1
      result = await events.next()
    }

    log('--------------------------------------------------------------')
    log(`[e2e] turns: ${turns}`)
    log(`[e2e] final answer: ${assistantText.trim() || '(none)'}`)
  } catch (err) {
    process.stderr.write(
      `[e2e] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    )
    process.exitCode = 1
  } finally {
    try { fs.rmSync(profileDir, { recursive: true, force: true }) } catch {}
  }
}

function describeEvent(evt: LoomEvent): void {
  switch (evt.type) {
    case 'turn.start':
      log(`[turn.start] turn=${evt.turnIndex}`)
      break
    case 'tool.call.start': {
      const input = JSON.stringify(evt.input)
      const snippet = input.length > 180 ? input.slice(0, 180) + '…' : input
      log(`  → tool.call.start  ${evt.toolName}  ${snippet}`)
      break
    }
    case 'tool.call.end': {
      const out = typeof evt.result === 'string' ? evt.result : JSON.stringify(evt.result)
      const snippet = out.length > 400 ? out.slice(0, 400) + '…' : out
      log(`  ← tool.call.end    ${evt.toolName}  ${evt.isError ? '[error]' : 'ok'}  ${snippet}`)
      break
    }
    case 'turn.end':
      log(
        `[turn.end]   tokens in=${evt.usage.inputTokens} out=${evt.usage.outputTokens} cost=$${evt.usage.costUsd.toFixed(4)}`,
      )
      break
    case 'error':
      log(`[error] ${evt.message}`)
      break
    default:
      break
  }
}

function log(msg: string): void {
  process.stdout.write(`${msg}\n`)
}

main().catch(err => {
  process.stderr.write(
    `[e2e] UNCAUGHT: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  )
  process.exit(1)
})
