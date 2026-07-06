/**
 * D4/B1 verification — does a REAL `browser_screenshot` emit a non-empty
 * `tool.call.end.metadata.image` (+ format/url/title)?
 *
 * That metadata bag is exactly what the client's run store consumes over SSE:
 * `extractScreenshot(event.metadata)` → ToolCallChatItem.screenshot →
 * the Ownware browser renderer → the Desk BrowserView. The gateway forwards
 * loom events verbatim, so verifying the producer here verifies the bytes
 * the client-side consumer (unit-tested separately) will receive.
 *
 *   bunx tsx tests/examples/browser-screenshot-metadata-e2e.ts
 *
 * Prereq: OPENROUTER_API_KEY in repo-root .env, Chrome installed.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RunningChrome, LoomEvent } from '@ownware/loom'

function loadEnvFile(envPath: string): void {
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const key = t.slice(0, eq).trim()
    let val = t.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = val
  }
}

function makeProfile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-shot-e2e-'))
  const agentJson = {
    name: 'browser-shot-e2e',
    description: 'Forces a browser_screenshot to verify metadata.image',
    model: 'openrouter:anthropic/claude-haiku-4.5',
    maxTurns: 6,
    tools: { preset: 'full', deny: ['shell_execute', 'edit_file', 'write_file', 'delete_file'] },
    browser: { headless: true, readyTimeoutMs: 20_000 },
    context: { datetime: true, os: false, cwd: false, project: false, git: false },
    security: { level: 'permissive', zones: { maxAutoZone: 'network' } },
    systemPrompt: [
      'You are a one-shot browser agent with browser_* tools wired to a real Chrome.',
      'Do EXACTLY one thing: call browser_screenshot to capture the current page',
      '(the default blank page is fine — do NOT navigate anywhere). Then reply',
      '"done". Keep it short.',
    ].join('\n'),
  }
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(agentJson, null, 2))
  return dir
}

function log(m: string): void {
  process.stdout.write(`${m}\n`)
}

async function main(): Promise<void> {
  // This file lives at packages/cortex/tests/examples/ → repo root is 4 up.
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..')
  loadEnvFile(path.join(repoRoot, '.env'))
  if (!process.env.OPENROUTER_API_KEY) {
    process.stderr.write('[e2e] OPENROUTER_API_KEY not set in .env\n')
    process.exit(2)
  }

  const { Session, createDeferredChromeLauncher } = await import('@ownware/loom')
  const { loadProfile } = await import('../../src/profile/loader.js')
  const { assembleAgent } = await import('../../src/profile/assembler.js')

  const profileDir = makeProfile()
  const profile = await loadProfile(profileDir)

  let launcher: ReturnType<typeof createDeferredChromeLauncher> | null = null
  let runningChrome: RunningChrome | null = null
  let shotEvent: Extract<LoomEvent, { type: 'tool.call.end' }> | null = null

  try {
    const assembled = await assembleAgent(profile)
    launcher = createDeferredChromeLauncher({
      launchOptions: {
        headless: true,
        readyTimeoutMs: profile.config.browser.readyTimeoutMs,
      },
      onLaunched: (r) => {
        runningChrome = r
        log(`[e2e] chrome up pid=${r.pid}`)
      },
    })
    const sessionConfig = Object.assign({}, assembled.config, {
      browserCdpUrlProvider: () => launcher!.getCdpUrl(),
    })
    const session = new Session({
      config: sessionConfig,
      provider: assembled.provider,
      tools: assembled.tools,
      checkpoint: assembled.checkpointStore,
      requestApproval: async () => true,
    })

    const events = session.submitMessage('Take a screenshot of the current page.')
    let r = await events.next()
    while (!r.done) {
      const evt = r.value
      if (evt.type === 'tool.call.start') log(`  → ${evt.toolName}`)
      if (evt.type === 'tool.call.end') {
        log(`  ← ${evt.toolName} ${evt.isError ? '[error]' : 'ok'} metaKeys=${Object.keys(evt.metadata ?? {}).join(',')}`)
        if (evt.isError) log(`     err: ${String(evt.result).slice(0, 240)}`)
        if (evt.toolName === 'browser_screenshot') shotEvent = evt
      }
      r = await events.next()
    }

    // ── Assertions on the exact payload the client's run store consumes ──
    log('--------------------------------------------------------------')
    if (shotEvent == null) {
      throw new Error('FAIL: no browser_screenshot tool.call.end event was emitted')
    }
    const meta = shotEvent.metadata ?? {}
    const image = meta.image
    const format = meta.format
    const okImage = typeof image === 'string' && image.length > 100
    const okFormat = format === 'png' || format === 'jpeg'
    log(`[assert] metadata.image: ${typeof image} len=${typeof image === 'string' ? image.length : 'n/a'} → ${okImage ? 'PASS' : 'FAIL'}`)
    log(`[assert] metadata.format: ${String(format)} → ${okFormat ? 'PASS' : 'FAIL'}`)
    log(`[assert] metadata.url: ${String(meta.url)}`)
    log(`[assert] metadata.title: ${String(meta.title)}`)
    if (typeof image === 'string') log(`[assert] image head: ${image.slice(0, 32)}…`)
    if (!okImage || !okFormat) {
      throw new Error('FAIL: screenshot metadata did not carry a usable image/format')
    }
    log('[e2e] ✅ PASS — browser_screenshot emits metadata.image+format (client consumer will render it)')
  } finally {
    if (launcher) await launcher.stop(10_000)
    void runningChrome
    try {
      fs.rmSync(profileDir, { recursive: true, force: true })
    } catch {
      // non-fatal cleanup
    }
  }
}

main().catch((err) => {
  process.stderr.write(`[e2e] UNCAUGHT: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exit(1)
})
