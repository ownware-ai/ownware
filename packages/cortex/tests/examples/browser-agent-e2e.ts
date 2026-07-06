/**
 * End-to-end demo for the slice-2 browser wiring.
 *
 *   bunx tsx examples/browser-agent-e2e.ts
 *   bunx tsx examples/browser-agent-e2e.ts --headless
 *   bunx tsx examples/browser-agent-e2e.ts --prompt "navigate to https://example.com and tell me the exact h1 text"
 *
 * Wires:
 *   profile (browser.autoLaunch: true)
 *     → assembleAgent
 *     → launchChrome() returns a RunningChrome
 *     → Session config gets `browserCdpUrl` via Object.assign
 *     → Loom's browser_* tools connect to the launched Chrome
 *
 * The script acts as the "gateway" for a single session: it calls the
 * same launcher Cortex uses, stashes the handle on the session, and
 * kills it in a finally block. A real run flows through the gateway's
 * run handler and `GatewayState.setChromeLaunch` / shutdown paths.
 *
 * Prereq:
 *   - ANTHROPIC_API_KEY in `.env` at the repo root (loaded manually here).
 *   - Google Chrome, Brave, Edge, or Chromium installed.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// Loom's index.ts instantiates provider clients at import time — those
// clients validate API keys eagerly. We must load `.env` BEFORE the
// first `@ownware/loom` import fires, so the Loom modules + the Cortex
// modules that transitively import Loom are imported dynamically inside
// `main()` after `loadEnvFile()` has populated `process.env`.
import type { RunningChrome, LoomEvent } from '@ownware/loom'

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const headless = argv.includes('--headless')
const promptIdx = argv.indexOf('--prompt')
const prompt =
  promptIdx >= 0 && argv[promptIdx + 1]
    ? argv[promptIdx + 1]!
    : 'Use the browser to navigate to https://example.com, then tell me the exact text of the page\'s h1 element. Use browser_snapshot after navigating so you can read the accessibility tree.'

// ---------------------------------------------------------------------------
// .env loader (intentionally tiny — keeps Loom's zero-deps policy)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Throwaway profile on disk (minimal, browser-enabled)
// ---------------------------------------------------------------------------

function makeThrowawayProfile(opts: { headless: boolean }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-e2e-profile-'))
  const agentJson = {
    name: 'browser-e2e',
    description: 'Single-purpose profile for the slice-2 browser e2e demo',
    model: 'anthropic:claude-sonnet-4-20250514',
    maxTurns: 6,
    tools: {
      // `full` gives us the browser tools and a few others for flexibility.
      preset: 'full',
      // Keep shell / filesystem out of the picture — this demo is about
      // the browser path, and unrelated tool access would just add noise.
      deny: ['shell_execute', 'edit_file', 'write_file', 'delete_file'],
    },
    // NOTE: no `autoLaunch` — the default is `"auto"`, which launches
    // Chrome iff the assembled tool set contains any browser_* tool.
    // `tools.preset: "full"` above includes them, so this demo inherits
    // browser access for free, same as every other profile.
    browser: {
      headless: opts.headless,
      readyTimeoutMs: 20_000,
    },
    context: {
      datetime: true,
      os: false,
      cwd: false,
      project: false,
      git: false,
    },
    security: {
      level: 'permissive',
      // Zones are the enforced permission knob. browser_* tools
      // classify at zone `network`, so raising maxAutoZone to `network`
      // auto-approves them for this demo. `permissionMode: 'auto'`
      // looks right but isn't wired yet — see assembler.unsupported.ts.
      zones: { maxAutoZone: 'network' },
    },
    systemPrompt: [
      'You are a tiny browser agent running inside a one-shot demo.',
      'You have browser_* tools already wired to a real Chrome.',
      'Use browser_navigate to go to a URL, then browser_snapshot to read the page.',
      'Respond with the specific text the user asked for. Keep answers short.',
    ].join('\n'),
  }
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(agentJson, null, 2))
  return dir
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Load keys from repo-root .env — mirrors how dev workflow picks them up.
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..')
  loadEnvFile(path.join(repoRoot, '.env'))

  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write(
      '[e2e] ANTHROPIC_API_KEY not set. Put it in .env at the repo root.\n',
    )
    process.exit(2)
  }

  // Dynamic imports — see the note at the top of the file. Loom's
  // provider clients validate API keys at construction, and that
  // construction happens the moment `@ownware/loom` is loaded.
  const { Session, HumanInTheLoop, createDeferredChromeLauncher } =
    await import('@ownware/loom')
  const { loadProfile } = await import('../src/profile/loader.js')
  const { assembleAgent } = await import('../src/profile/assembler.js')

  log(`[e2e] headless=${headless}`)
  log(`[e2e] prompt: ${prompt}`)

  // 1. Build a throwaway profile on disk with browser.autoLaunch: true.
  const profileDir = makeThrowawayProfile({ headless })
  log(`[e2e] profile at ${profileDir}`)
  const profile = await loadProfile(profileDir)

  // 2. Assemble the agent. Tools + system prompt + provider come out.
  let runtimeRunning: RunningChrome | null = null
  let launcher: ReturnType<typeof createDeferredChromeLauncher> | null = null
  try {
    const assembled = await assembleAgent(profile)
    log(`[e2e] assembled ${assembled.tools.length} tools`)
    const browserTools = assembled.tools.filter(t => t.name.startsWith('browser_'))
    log(`[e2e] browser_* tools: ${browserTools.map(t => t.name).join(', ')}`)

    // 3. Decide whether to REGISTER a deferred launcher, using the SAME
    //    logic the gateway's run handler uses. `autoLaunch: "auto"` (the
    //    default) looks at the assembled tool set. Registration does NOT
    //    spawn Chrome — the launcher spawns on the first browser tool
    //    call. This mirrors production: prompts like "hi" do not open
    //    a Chrome window.
    const wantsBrowser =
      profile.config.browser.autoLaunch === true ||
      (profile.config.browser.autoLaunch === 'auto' &&
        assembled.tools.some(t => t.name.startsWith('browser_')))
    log(
      `[e2e] browser.autoLaunch=${JSON.stringify(profile.config.browser.autoLaunch)} → ${wantsBrowser ? 'registered (will spawn on first browser_* call)' : 'not registered'}`,
    )

    let browserCdpUrlProvider: (() => Promise<string>) | undefined
    if (wantsBrowser) {
      launcher = createDeferredChromeLauncher({
        launchOptions: {
          headless: profile.config.browser.headless,
          noSandbox: profile.config.browser.noSandbox,
          extraArgs: profile.config.browser.extraArgs,
          readyTimeoutMs: profile.config.browser.readyTimeoutMs,
          ...(profile.config.browser.port !== undefined
            ? { port: profile.config.browser.port }
            : {}),
          ...(profile.config.browser.userDataDir !== undefined
            ? { userDataDir: profile.config.browser.userDataDir }
            : {}),
        },
        onLaunched: r => {
          runtimeRunning = r
          log(`[e2e] 🚀 chrome launched on first browser tool: pid=${r.pid} cdp=${r.cdpUrl}`)
        },
      })
      browserCdpUrlProvider = () => launcher!.getCdpUrl()
    }

    // 4. Build the Session. `browserCdpUrlProvider` is the async hook
    //    Loom's browser_* tools invoke on first use. Same pattern run.ts
    //    uses in production.
    const sessionConfig = Object.assign(
      {},
      assembled.config,
      browserCdpUrlProvider ? { browserCdpUrlProvider } : {},
    )
    const hitl = new HumanInTheLoop({ timeoutMs: 60_000 })
    const session = new Session({
      config: sessionConfig,
      provider: assembled.provider,
      tools: assembled.tools,
      checkpoint: assembled.checkpointStore,
      // `permissive` + maxAutoZone=network covers the common browser_*
      // calls, but combination-trigger rules (e.g. "browser + external")
      // can still escalate a single call into the ask path. This demo
      // auto-approves — we are exercising the launch + CDP wiring, not
      // the permission UX.
      requestApproval: async () => true,
    })
    void hitl

    // 5. Drive one turn and surface everything useful for humans.
    const events = session.submitMessage(prompt)
    let assistantText = ''
    let turnCount = 0
    let result = await events.next()
    while (!result.done) {
      const evt = result.value
      describeEvent(evt)
      if (evt.type === 'text.delta') assistantText += evt.text
      if (evt.type === 'turn.end') turnCount += 1
      result = await events.next()
    }
    log('--------------------------------------------------------------')
    log(`[e2e] turns: ${turnCount}`)
    log(`[e2e] final answer: ${assistantText.trim() || '(none)'}`)
    log(
      `[e2e] chrome was launched during this run: ${launcher?.isLaunched() ?? false}`,
    )
  } catch (err) {
    process.stderr.write(
      `[e2e] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    )
    process.exitCode = 1
  } finally {
    // Mirrors GatewayState.shutdownChromeLauncherForThread — safe to
    // call whether or not Chrome ever spawned. launcher.stop() is a
    // no-op if the first browser_* call never fired.
    if (launcher) {
      log(`[e2e] stopping launcher (chrome was ${launcher.isLaunched() ? 'running' : 'never launched'})`)
      await launcher.stop(10_000)
    }
    void runtimeRunning
    // Best-effort: remove the throwaway profile directory we wrote.
    try {
      fs.rmSync(profileDir, { recursive: true, force: true })
    } catch {
      // non-fatal
    }
  }
}

// ---------------------------------------------------------------------------
// Event printing
// ---------------------------------------------------------------------------

function describeEvent(evt: LoomEvent): void {
  switch (evt.type) {
    case 'turn.start':
      log(`[turn.start] turn=${evt.turnIndex}`)
      break
    case 'tool.call.start': {
      const input = JSON.stringify(evt.input)
      const snippet = input.length > 140 ? input.slice(0, 140) + '…' : input
      log(`  → tool.call.start  ${evt.toolName}  ${snippet}`)
      break
    }
    case 'tool.call.end': {
      const out = typeof evt.result === 'string' ? evt.result : JSON.stringify(evt.result)
      const snippet = out.length > 200 ? out.slice(0, 200) + '…' : out
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
    case 'security.block':
      log(`[security.block] ${evt.toolName}: ${evt.reason}`)
      break
    default:
      // Ignore delta noise — too verbose for a demo log.
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
