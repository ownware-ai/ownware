/**
 * A journey is one customer doing one real thing, start to finish.
 *
 * The runner's job is threefold:
 *
 *  1. **Isolate.** Repo guardrail #4 — a journey must never touch the
 *     real `~/.ownware`. Every journey gets a temp dataDir passed BOTH
 *     as `--data-dir` and `OWNWARE_DATA_DIR`, and a dead
 *     `OWNWARE_GATEWAY_PORT` so `probeLocalGateway` can never latch onto
 *     the owner's actually-running gateway and drive their real data.
 *     The round also stamps the real db's mtime before and after as a
 *     sentinel — belt as well as braces, because "we passed the flag" is
 *     structural validity, not proof nothing was written.
 *
 *  2. **Capture.** Every frame the journey marks, the final screen, the
 *     raw byte stream, timings, exit code. These artifacts are the
 *     evidence a later judge pass reads — the journey itself makes no
 *     claim about whether the experience was GOOD.
 *
 *  3. **Check, honestly.** `ctx.check()` records a named observation and
 *     never throws, so one failed expectation does not hide the six
 *     after it. A journey that crashes is recorded as `crashed` with
 *     whatever screen it died on — never silently skipped.
 */

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PtyRun, PtyTimeout, type PtyOptions } from './pty.ts'
import { Screen, type ScreenSnapshot } from './screen.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const E2E_ROOT = join(HERE, '..')
export const ARTIFACT_ROOT = join(E2E_ROOT, 'artifacts')
const CLI_BIN = join(E2E_ROOT, '..', 'bin', 'ownware-cli.js')

/** A port nothing listens on, so the local-gateway probe always misses. */
const DEAD_PROBE_PORT = '39999'

export type Requirement = 'ollama-chat' | 'ollama-tools' | 'openrouter'

export interface Check {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

export interface JourneyContext {
  /** Scratch project the customer is "in". */
  readonly workdir: string
  /** Isolated data dir — the CLI's ~/.ownware stand-in. */
  readonly dataDir: string
  /** Launch the real binary under a pty. Data-dir isolation is enforced here. */
  start(args: readonly string[], opts?: StartOptions): PtyRun
  /**
   * Run a shell line inside the pty, with `$OWNWARE` bound to the real
   * binary invocation. The only way to prove the NON-tty path (`| cat`,
   * `> file`) while still watching it from a terminal.
   */
  startShell(script: string, opts?: StartOptions): PtyRun
  /** Record what the customer would be looking at right now. */
  frame(label: string, pty: PtyRun): ScreenSnapshot
  /** A named observation. Never throws — the journey always finishes. */
  check(name: string, ok: boolean, detail?: string): void
  /** Free-text context for the judge (why this step, what to look at). */
  note(text: string): void
}

export interface StartOptions {
  readonly cols?: number
  readonly rows?: number
  readonly env?: Readonly<Record<string, string>>
  /** Run under bun (the OpenTUI shell path) instead of node. */
  readonly runtime?: 'node' | 'bun'
}

export interface Journey {
  readonly id: string
  /** What the customer is doing, in their words. */
  readonly title: string
  /** Who they are and what they are expecting to happen. */
  readonly customer: string
  /** What would make this a bad experience — the judge's brief. */
  readonly badLooksLike: string
  readonly requires?: readonly Requirement[]
  readonly timeoutMs?: number
  run(ctx: JourneyContext): Promise<void>
}

export interface JourneyResult {
  readonly id: string
  readonly title: string
  readonly customer: string
  readonly badLooksLike: string
  readonly status: 'ran' | 'crashed' | 'skipped'
  readonly skipReason?: string
  readonly durationMs: number
  readonly checks: readonly Check[]
  readonly notes: readonly string[]
  readonly frames: readonly ScreenSnapshot[]
  readonly error?: string
}

async function probe(url: string, timeoutMs = 1500): Promise<Response | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok ? res : null
  } catch {
    return null
  }
}

/** What can actually run on this machine right now — checked, not assumed. */
export async function detectCapabilities(): Promise<Set<Requirement>> {
  const caps = new Set<Requirement>()
  const tags = await probe('http://127.0.0.1:11434/api/tags')
  if (tags !== null) {
    const body = (await tags.json()) as { models?: Array<{ name?: string }> }
    const names = (body.models ?? []).map((m) => m.name ?? '')
    if (names.some((n) => n.startsWith('llama3.2'))) caps.add('ollama-chat')
    if (names.some((n) => /^(qwen2\.5-coder|qwen3|llama3\.1)/.test(n))) caps.add('ollama-tools')
  }
  if ((process.env['OPENROUTER_API_KEY'] ?? '') !== '') caps.add('openrouter')
  return caps
}

class Ctx implements JourneyContext {
  readonly checks: Check[] = []
  readonly notes: string[] = []
  readonly frames: ScreenSnapshot[] = []
  readonly ptys: PtyRun[] = []

  readonly workdir: string
  readonly dataDir: string
  private readonly artifactDir: string

  constructor(workdir: string, dataDir: string, artifactDir: string) {
    this.workdir = workdir
    this.dataDir = dataDir
    this.artifactDir = artifactDir
  }

  private env(opts: StartOptions): Record<string, string> {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      // Isolation (guardrail #4) — both the flag and the env var.
      OWNWARE_DATA_DIR: this.dataDir,
      // Never let the probe find the owner's real running gateway.
      OWNWARE_GATEWAY_PORT: DEAD_PROBE_PORT,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...opts.env,
    }
    delete env['OWNWARE_BASE_URL']
    return env
  }

  start(args: readonly string[], opts: StartOptions = {}): PtyRun {
    const runtime = opts.runtime ?? 'node'
    const options: PtyOptions = {
      command: runtime === 'bun' ? 'bun' : process.execPath,
      args: [CLI_BIN, '--data-dir', this.dataDir, ...args],
      cwd: this.workdir,
      env: this.env(opts),
      ...(opts.cols !== undefined ? { cols: opts.cols } : {}),
      ...(opts.rows !== undefined ? { rows: opts.rows } : {}),
    }
    const pty = PtyRun.start(options)
    this.ptys.push(pty)
    return pty
  }

  startShell(script: string, opts: StartOptions = {}): PtyRun {
    const runtime = opts.runtime ?? 'node'
    const bin = runtime === 'bun' ? 'bun' : process.execPath
    const options: PtyOptions = {
      command: '/bin/sh',
      args: ['-c', script],
      cwd: this.workdir,
      env: {
        ...this.env(opts),
        // Bare invocation. Flags are the journey's business: the CLI
        // rejects global flags placed before a subcommand, so the
        // harness must not silently prepend any.
        OWNWARE: `${bin} ${CLI_BIN}`,
      },
      ...(opts.cols !== undefined ? { cols: opts.cols } : {}),
      ...(opts.rows !== undefined ? { rows: opts.rows } : {}),
    }
    const pty = PtyRun.start(options)
    this.ptys.push(pty)
    return pty
  }

  frame(label: string, pty: PtyRun): ScreenSnapshot {
    const snap = pty.snapshot(label)
    this.frames.push(snap)
    const n = String(this.frames.length).padStart(2, '0')
    writeFileSync(join(this.artifactDir, 'frames', `${n}-${slug(label)}.txt`), Screen.render(snap))
    return snap
  }

  check(name: string, ok: boolean, detail = ''): void {
    this.checks.push({ name, ok, detail })
  }

  note(text: string): void {
    this.notes.push(text)
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'frame'
}

export async function runJourney(
  journey: Journey,
  caps: ReadonlySet<Requirement>,
): Promise<JourneyResult> {
  const artifactDir = join(ARTIFACT_ROOT, journey.id)
  rmSync(artifactDir, { recursive: true, force: true })
  mkdirSync(join(artifactDir, 'frames'), { recursive: true })

  const base = {
    id: journey.id,
    title: journey.title,
    customer: journey.customer,
    badLooksLike: journey.badLooksLike,
  }

  const missing = (journey.requires ?? []).filter((r) => !caps.has(r))
  if (missing.length > 0) {
    const result: JourneyResult = {
      ...base,
      status: 'skipped',
      skipReason: `needs ${missing.join(', ')}`,
      durationMs: 0,
      checks: [],
      notes: [],
      frames: [],
    }
    writeFileSync(join(artifactDir, 'report.json'), JSON.stringify(result, null, 2))
    return result
  }

  const root = mkdtempSync(join(tmpdir(), `ownware-journey-${journey.id}-`))
  const workdir = join(root, 'project')
  const dataDir = join(root, 'data')
  mkdirSync(workdir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })

  const ctx = new Ctx(workdir, dataDir, artifactDir)
  const started = Date.now()
  let error: string | undefined
  let status: JourneyResult['status'] = 'ran'

  try {
    await withTimeout(journey.run(ctx), journey.timeoutMs ?? 180_000, journey.id)
  } catch (err) {
    status = 'crashed'
    error = err instanceof Error ? err.message : String(err)
    if (err instanceof PtyTimeout) {
      // The screen it died on IS the finding — keep it.
      ctx.frames.push(err.screen)
      writeFileSync(
        join(artifactDir, 'frames', `${String(ctx.frames.length).padStart(2, '0')}-timeout.txt`),
        Screen.render(err.screen),
      )
    }
  } finally {
    for (const pty of ctx.ptys) {
      pty.kill('SIGKILL')
      writeFileSync(join(artifactDir, 'raw.txt'), pty.rawBytes())
    }
  }

  const result: JourneyResult = {
    ...base,
    status,
    durationMs: Date.now() - started,
    checks: ctx.checks,
    notes: ctx.notes,
    frames: ctx.frames,
    ...(error !== undefined ? { error } : {}),
  }
  writeFileSync(join(artifactDir, 'report.json'), JSON.stringify(result, null, 2))
  rmSync(root, { recursive: true, force: true })
  return result
}

async function withTimeout<T>(p: Promise<T>, ms: number, id: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`journey ${id} exceeded ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Guardrail-#4 sentinel. Structural isolation (temp dirs, flags) is a
 * claim; this observes the effect at the place it would happen.
 */
export function realDataDirStamp(): string {
  const db = join(homedir(), '.ownware', 'ownware.db')
  try {
    const s = statSync(db)
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return 'absent'
  }
}
