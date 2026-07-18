/**
 * `ownware serve` — run the gateway as a verb. The CLI twin of the
 * custom-client serve.mjs: boot `OwnwareGateway` over ./profiles, print how
 * to talk to it, stay up until Ctrl-C.
 *
 * Defaults tuned for first contact on loopback: plain HTTP (curl-able
 * with no -k), auth off — the gateway's own local-first posture. A
 * non-loopback --host flips both: TLS on and auth REQUIRED (there is no
 * safe unauthenticated LAN bind).
 */

import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { ollamaInstallHint } from '@ownware/loom'
import { OwnwareGateway } from '../gateway/server.js'
import { gatewayTokenPath } from '../gateway/token-store.js'
import { pickRunnableDefaultModel } from '../gateway/catalog/models/index.js'

export interface ServeFlags {
  port?: number
  host?: string
  profilesDir?: string
  dataDir?: string
  tls?: boolean
  /** Boot stored channels in-process (default true). `--no-channels` opts out. */
  channels?: boolean
}

export function parseServeFlags(argv: string[]): ServeFlags {
  const flags: ServeFlags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case '--port':
      case '-p': {
        const n = Number(argv[++i])
        if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`serve: invalid --port "${argv[i]}"`)
        flags.port = n
        break
      }
      case '--host':
        flags.host = argv[++i]
        if (!flags.host) throw new Error('serve: --host needs a value')
        break
      case '--profiles':
        flags.profilesDir = resolve(argv[++i] ?? '.')
        break
      case '--data-dir':
        flags.dataDir = resolve(argv[++i] ?? '.')
        break
      case '--tls':
        flags.tls = true
        break
      case '--no-tls':
        flags.tls = false
        break
      case '--no-channels':
        flags.channels = false
        break
      default:
        throw new Error(`serve: unknown flag "${arg}"`)
    }
  }
  return flags
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

export async function serveCommand(argv: string[]): Promise<void> {
  const flags = parseServeFlags(argv)

  const profilesDir = flags.profilesDir ?? resolve(process.cwd(), 'profiles')
  if (!existsSync(profilesDir)) {
    console.error(`No profiles directory at ${profilesDir}`)
    console.error('Run `ownware init` to create a starter agent, or pass --profiles <dir>.')
    process.exit(1)
  }

  const host = flags.host ?? process.env.OWNWARE_HOST ?? '127.0.0.1'
  const loopback = LOOPBACK_HOSTS.has(host)

  if (!loopback && flags.tls === false) {
    console.error('serve: refusing --no-tls on a non-loopback host — exposed traffic must be encrypted.')
    process.exit(1)
  }

  const gateway = new OwnwareGateway({
    profilesDir,
    host,
    ...(flags.port !== undefined ? { port: flags.port } : {}),
    ...(flags.dataDir !== undefined ? { dataDir: flags.dataDir } : {}),
    // Loopback first contact: plain HTTP unless the user opts in.
    // Non-loopback: TLS always (a --no-tls flag is refused below).
    tls: loopback ? (flags.tls ?? false) : true,
    // Non-loopback binds REQUIRE auth. The gateway's own bind-safety
    // invariant enforces this too — passing it explicitly keeps serve's
    // intent readable.
    ...(loopback ? {} : { disableAuth: false }),
  })

  await gateway.start()

  const scheme = (loopback ? (flags.tls ?? false) : true) ? 'https' : 'http'
  const url = `${scheme}://${loopback ? 'localhost' : host}:${gateway.port}`
  const model = await pickRunnableDefaultModel()
  const exampleProfile = firstProfileId(profilesDir) ?? 'assistant'

  // One-process channels (Slice 7) + schedule delivery host (Slice 8).
  // Only on the plain-HTTP loopback default: the in-process runner talks
  // to the gateway over fetch, which (correctly) refuses the gateway's
  // self-signed TLS cert — with TLS on, run `ownware channel start` against
  // a trusted URL instead.
  let channels: import('./serve-channels.js').InProcessChannels | null = null
  if (flags.channels !== false) {
    if (scheme === 'http') {
      const { bootChannels } = await import('./serve-channels.js')
      const dataDir =
        flags.dataDir ?? process.env.OWNWARE_DATA_DIR ?? join(homedir(), '.ownware')
      try {
        channels = await bootChannels({
          gateway,
          gatewayUrl: `http://127.0.0.1:${gateway.port}`,
          dataDir,
        })
      } catch (err) {
        // Channels must never take the gateway down with them.
        console.error(
          `  Channels: failed to start — ${err instanceof Error ? err.message : err}`,
        )
      }
      process.on('SIGINT', () => channels?.stop())
      process.on('SIGTERM', () => channels?.stop())
    } else {
      console.log('  Channels: skipped (TLS bind) — run `ownware channel start --gateway <url>` separately.')
    }
  }

  console.log()
  console.log(`  Your agent is live: ${url}`)
  console.log()
  if (model != null) {
    console.log(`  Model:  ${model}${model.startsWith('ollama:') ? '  (keyless, local)' : ''}`)
  } else {
    console.log('  Model:  none available yet — add a key with `ownware key add <provider>`,')
    console.log(`          or run keyless: ${ollamaInstallHint()}`)
  }
  if (channels != null && channels.started.length > 0) {
    console.log(`  Channels: ${channels.started.join(', ')}  (in-process — answering + schedule delivery)`)
  }
  if (channels?.webhooks != null) {
    const bind = process.env.OWNWARE_WEBHOOK_HOST ?? '127.0.0.1'
    console.log(`  Webhooks: ${bind}:${channels.webhooks.port} — put a public HTTPS tunnel or reverse proxy in front`)
    for (const p of channels.webhooks.paths) console.log(`    ${p}`)
  }
  if (!loopback) {
    const tokenFile = gatewayTokenPath(gateway.dataDir)
    console.log()
    console.log('  Auth is ON (non-loopback bind). Clients need:')
    console.log('    Authorization: Bearer <token>')
    console.log(`  Read the token from ${tokenFile} (0600); never paste it into shared logs.`)
  }
  console.log()
  console.log(`  Try it:  curl${scheme === 'https' ? ' -k' : ''} -X POST ${url}/api/v1/run \\`)
  if (!loopback) console.log('             -H "Authorization: Bearer <token>" \\')
  console.log("             -H 'Content-Type: application/json' \\")
  console.log(`             -d '{"profileId":"${exampleProfile}","prompt":"hello"}'`)
  console.log()
  console.log('  Ctrl-C to stop.')
  console.log()
  // The listening server keeps the event loop alive; the gateway's own
  // SIGINT/SIGTERM handlers stop it cleanly.
}

/** First profile subdirectory with an agent.json — the curl example's id. */
function firstProfileId(profilesDir: string): string | null {
  try {
    for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(profilesDir, entry.name, 'agent.json'))) {
        return entry.name
      }
    }
  } catch {
    // unreadable dir — the gateway will surface its own error
  }
  return null
}
