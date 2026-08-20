/**
 * `ownware-cli` — S1 entry point.
 *
 *   ownware-cli                     chat with the default coding profile
 *   ownware-cli --profile ari       chat with another profile
 *   ownware-cli --resume            continue the last session in this cwd
 *   ownware-cli --base-url URL      attach to a running gateway instead
 *                                   of booting one in-process
 *
 * The bin name is `ownware-cli` until the public command name is decided.
 */

import { OwnwareClient } from '@ownware/client'
import { ensureGateway } from './gateway.js'
import { runRepl } from './repl.js'
import { SessionStore } from './session-store.js'
import { detectTheme } from './theme.js'
import { ensureWorkspace } from './workspace.js'

export { TranscriptRenderer, formatDuration } from './render.js'
export { detectStyle, ANSI_STYLE, PLAIN_STYLE, type Style } from './style.js'
export { ensureGateway, resolveProfilesDir, defaultDataDir } from './gateway.js'
export { SessionStore } from './session-store.js'
export { runRepl } from './repl.js'
export { streamRun, KEY_ESC, KEY_CTRL_C, type KeyChannel } from './stream-run.js'

interface CliFlags {
  profile?: string
  model?: string
  baseUrl?: string
  token?: string
  profilesDir?: string
  dataDir?: string
  resume: boolean
  debugEvents: boolean
  simple: boolean
  help: boolean
}

export function parseArgs(argv: readonly string[]): CliFlags {
  const flags: CliFlags = { resume: false, debugEvents: false, simple: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--profile':
      case '-p':
        flags.profile = argv[++i]
        break
      case '--model':
      case '-m':
        flags.model = argv[++i]
        break
      case '--base-url':
        flags.baseUrl = argv[++i]
        break
      case '--token':
        flags.token = argv[++i]
        break
      case '--profiles-dir':
        flags.profilesDir = argv[++i]
        break
      case '--data-dir':
        flags.dataDir = argv[++i]
        break
      case '--resume':
      case '-c':
        flags.resume = true
        break
      case '--debug-events':
        flags.debugEvents = true
        break
      case '--simple':
        flags.simple = true
        break
      case '--help':
      case '-h':
        flags.help = true
        break
      default:
        throw new Error(`Unknown option: ${arg} (see --help)`)
    }
  }
  return flags
}

/** Global flags that consume the next argv entry as their value. */
const VALUE_FLAGS = new Set([
  '--profile',
  '-p',
  '--model',
  '-m',
  '--base-url',
  '--token',
  '--profiles-dir',
  '--data-dir',
])
/** Global flags that stand alone. */
const BOOL_FLAGS = new Set(['--resume', '-c', '--debug-events', '--simple', '--help', '-h'])
const SUBCOMMANDS = new Set(['exec', 'attach'])
/**
 * Short forms mean different things to a subcommand than to the chat
 * loop (`-p` is `--profile` here, `--prompt` to `exec`), so a global is
 * always forwarded in its long form — never by passing the short one on.
 */
const LONG_FORM: Record<string, string> = { '-p': '--profile', '-m': '--model' }
/** Globals a subcommand cannot honour; forwarding them would be a lie. */
const CHAT_ONLY_FLAGS = new Set(['--resume', '-c', '--debug-events', '--simple'])

export interface SplitCommand {
  /** Global flags that appeared BEFORE the subcommand. */
  readonly globals: readonly string[]
  readonly command: string
  readonly rest: readonly string[]
}

/**
 * Find a subcommand that appears after global flags.
 *
 * `ownware-cli --data-dir /tmp/x exec -p "…"` is how every other CLI
 * works, and it used to die with `Unknown option: exec` — an error that
 * blames the subcommand for the ordering. Scanning past the globals
 * (stepping over the values they consume) makes the conventional form
 * work. Returns null when there is no subcommand, so the ordinary chat
 * path and the existing unknown-option error are untouched.
 */
export function splitSubcommand(argv: readonly string[]): SplitCommand | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (VALUE_FLAGS.has(arg)) {
      i++
      continue
    }
    if (BOOL_FLAGS.has(arg)) continue
    // An unknown flag, or a bare word that is not a subcommand: not our
    // business — let the normal parser report it in its own words.
    if (arg.startsWith('-') || !SUBCOMMANDS.has(arg)) return null
    return { globals: argv.slice(0, i), command: arg, rest: argv.slice(i + 1) }
  }
  return null
}

/**
 * Re-express globals for a subcommand. Throws — by name — on a flag the
 * subcommand genuinely cannot honour, rather than dropping it silently
 * and running something the customer did not ask for.
 */
export function forwardGlobals(globals: readonly string[], command: string): string[] {
  const out: string[] = []
  for (let i = 0; i < globals.length; i++) {
    const arg = globals[i]!
    if (CHAT_ONLY_FLAGS.has(arg)) {
      throw new Error(`${arg} applies to the chat loop, not to \`${command}\` (see --help)`)
    }
    if (VALUE_FLAGS.has(arg)) {
      out.push(LONG_FORM[arg] ?? arg, globals[++i] ?? '')
      continue
    }
    out.push(arg)
  }
  return out
}

const HELP = `ownware-cli — chat with your own agent in the terminal

Start here:
  cd your-project && ownware-cli        chat with the default agent
  no API key? run keyless on a local model:
      ollama pull llama3.2 && ownware-cli -m ollama:llama3.2

Everything runs on your machine: the CLI starts a gateway on loopback and
keeps state in ~/.ownware (override with --data-dir).

Usage: ownware-cli [options]
       ownware-cli attach <url> [options]   use a running gateway (local or remote)
       ownware-cli exec -p "…" [-o text|json|stream-json] [--profile id]
                     [--thread id]   headless one-shot for scripts/CI
                                     (approvals are auto-DENIED)

Options:
  -p, --profile <id>     profile to chat with (default: ownware-code, else first)
  -m, --model <id>       model override (e.g. ollama:llama3.2)
  -c, --resume           continue the last session in this directory
      --base-url <url>   attach to a running gateway instead of booting one
      --token <token>    bearer token for --base-url (or OWNWARE_GATEWAY_TOKEN)
      --profiles-dir <d> profiles directory for the in-process gateway
      --data-dir <d>     data directory (default ~/.ownware, OWNWARE_DATA_DIR)
      --debug-events     print unrendered wire events as dim lines
      --simple           force the plain fallback renderer (no TUI footer)
  -h, --help             show this help

Keys: esc / ctrl-c cancels the current run · y/n answer approval cards
Slash: /exit quits
`

/** Prefer the flagship coding profile, else the first profile the gateway has. */
export function pickDefaultProfile(profiles: ReadonlyArray<{ readonly id?: string; readonly name?: string }>): string | null {
  const ids = profiles
    .map((p) => p.id ?? p.name)
    .filter((id): id is string => typeof id === 'string' && id !== '')
  if (ids.includes('ownware-code')) return 'ownware-code'
  return ids[0] ?? null
}

export async function main(argv: readonly string[]): Promise<void> {
  // Subcommands may follow global flags — `--data-dir X exec …` is the
  // conventional shape and must work, not just `exec` at argv[0].
  const split = splitSubcommand(argv)
  if (split !== null) {
    // `--help` before a subcommand asks about the CLI, not the subcommand.
    if (split.globals.includes('--help') || split.globals.includes('-h')) {
      process.stdout.write(HELP)
      return
    }
    if (split.command === 'attach') {
      // `ownware-cli attach <url>` is sugar for --base-url.
      const url = split.rest[0]
      if (url === undefined || url === '' || url.startsWith('-')) {
        process.stderr.write('usage: ownware-cli attach <url> [options]\n')
        process.exitCode = 1
        return
      }
      // The URL named by `attach` is the explicit one — it comes after
      // the globals so it wins over any earlier `--base-url`.
      argv = [...split.globals, '--base-url', url, ...split.rest.slice(1)]
    } else {
      let forwarded: string[]
      try {
        forwarded = forwardGlobals(split.globals, split.command)
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
        process.exitCode = 1
        return
      }
      const { parseExecArgs, runExec } = await import('./exec.js')
      const code = await runExec(parseExecArgs([...forwarded, ...split.rest]))
      process.exit(code)
    }
  }

  const flags = parseArgs(argv)
  if (flags.help) {
    process.stdout.write(HELP)
    return
  }

  const style = detectTheme()
  const cwd = process.cwd()
  const gateway = await ensureGateway({
    ...(flags.baseUrl !== undefined ? { baseUrl: flags.baseUrl } : {}),
    ...(flags.token !== undefined ? { token: flags.token } : {}),
    ...(flags.profilesDir !== undefined ? { profilesDir: flags.profilesDir } : {}),
    ...(flags.dataDir !== undefined ? { dataDir: flags.dataDir } : {}),
    cwd,
  })

  const client = new OwnwareClient({
    baseUrl: gateway.baseUrl,
    ...(gateway.token !== undefined ? { token: gateway.token } : {}),
  })

  try {
    let profileId = flags.profile
    if (profileId === undefined) {
      const profiles = await client.profiles().catch((err: unknown) => {
        const status = (err as { status?: number }).status
        if (status === 401 || status === 403) {
          throw new Error(
            `the gateway at ${gateway.baseUrl} requires a token — pass --token, set OWNWARE_GATEWAY_TOKEN, or run from the machine that owns ${gateway.dataDir}/gateway-token`,
          )
        }
        throw err
      })
      const picked = pickDefaultProfile(profiles)
      if (picked === null) {
        process.stderr.write(
          'No profiles found. Create one: profiles/<id>/agent.json with {"name":"<id>"}\n',
        )
        process.exitCode = 1
        return
      }
      profileId = picked
    }

    // The banner: version from the gateway, model from the profile
    // summary (flag override wins). Both best-effort — a banner must
    // never block the prompt.
    const headers: Record<string, string> = {}
    if (gateway.token !== undefined) headers['Authorization'] = `Bearer ${gateway.token}`
    const version = await fetch(`${gateway.baseUrl}/api/v1/app/version`, { headers })
      .then(async (res) => (res.ok ? ((await res.json()) as { version?: string }) : null))
      .then((body) => body?.version ?? null)
      .catch(() => null)
    const profileModel = await client
      .profiles()
      .then(
        (all) =>
          all
            .filter((p) => (p.id ?? p.name) === profileId)
            .map((p) => (typeof p['model'] === 'string' ? p['model'] : null))[0] ?? null,
      )
      .catch(() => null)

    const workspaceId = await ensureWorkspace(gateway.baseUrl, gateway.token, cwd)

    const banner = {
      version,
      profileId,
      model: flags.model ?? profileModel,
      cwd,
      baseUrl: gateway.baseUrl,
      owned: gateway.owned,
      logFile: gateway.logFile,
    }

    const replOptions = {
      client,
      profileId,
      ...(flags.model !== undefined ? { model: flags.model } : {}),
      style,
      sessionStore: new SessionStore(gateway.dataDir),
      cwd,
      resume: flags.resume,
      banner,
      ...(workspaceId !== null ? { workspaceId } : {}),
      debugEvents: flags.debugEvents,
    }

    // The OpenTUI split-footer shell needs Bun (Zig core over Bun FFI)
    // and a real TTY. Anything else — Node, pipes, --simple — gets the
    // plain fallback renderer. The import stays dynamic so Node never
    // loads the FFI module.
    const canTui =
      !flags.simple &&
      typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' &&
      process.stdout.isTTY === true &&
      process.stdin.isTTY === true

    if (canTui) {
      const { runTuiShell } = await import('./tui/shell.js')
      await runTuiShell(replOptions)
      // OpenTUI's FFI runtime keeps the event loop alive after
      // destroy(); exit explicitly once the gateway is down.
      await gateway.close()
      process.exit(0)
    } else {
      await runRepl(replOptions)
    }
  } finally {
    await gateway.close()
  }

  // The chat is over and the gateway is down, but the process can still
  // be held open by the HTTP client's own keep-alive sockets and timers
  // (undici pools them; a cancelled run reliably leaves a pair behind).
  // Measured: gateway.close() completed in 7ms and the process then sat
  // on `TCPSocketWrap`/`Timeout` handles until it was killed — the CLI
  // appeared hung after cancelling a run (FINDINGS F9).
  //
  // Exiting explicitly is what the TUI branch above already does for the
  // same class of reason. `process.exitCode` is preserved so a genuine
  // failure still reports failure — this ends the process, it does not
  // declare success.
  process.exit(process.exitCode ?? 0)
}
