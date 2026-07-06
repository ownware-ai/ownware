/**
 * `ownware channel` — bridge to the shuttle channel CLI, so the command the
 * docs (and the pairing message) advertise actually works on the main
 * `ownware` bin:
 *
 *   ownware channel add slack --profile assistant --bot-token … --app-token …
 *   ownware channel list | remove <id> | approve <channel> <code> | start
 *
 * Channels live in `@ownware/shuttle` — a *client* of the gateway, not part
 * of the kernel — so this is a soft link: the module is imported at
 * runtime IF installed (always true in the monorepo / the umbrella
 * install), and a clear install hint is printed when it isn't. Cortex
 * declares no dependency on shuttle; the layering (engine ← kernel ←
 * clients) stays intact.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

/** The bits of `@ownware/shuttle/channels` this bridge drives. */
export interface ShuttleChannelsModule {
  FileChannelStore: new (opts: { dir: string; secret?: string }) => unknown
  FilePairingStore: new (opts: { file: string }) => unknown
  ChannelRunner: new (
    store: unknown,
    opts: { gatewayUrl?: string; gatewayToken?: string; pairing?: unknown },
  ) => {
    start(): Promise<string[]>
    stop(): void
    deliver(kind: string, target: string, text: string): Promise<boolean>
  }
  runChannelCli(argv: string[], store: unknown, deps?: { pairing?: unknown }): Promise<string>
}

export async function loadShuttleChannels(): Promise<ShuttleChannelsModule | null> {
  // Non-literal specifier: TypeScript must not try to resolve shuttle's
  // types (cortex builds before shuttle), and bundlers must not inline it.
  const specifier = '@ownware/shuttle/channels'
  try {
    return (await import(specifier)) as ShuttleChannelsModule
  } catch {
    return null
  }
}

/** Shared store construction — the CLI verbs and `ownware serve`'s in-process
 *  runner must read the SAME on-disk channel + pairing state. */
export function buildChannelStores(
  mod: ShuttleChannelsModule,
  dataDir: string,
): { store: unknown; pairing: unknown } {
  const dir = process.env.OWNWARE_CHANNELS_DIR ?? join(dataDir, 'channels')
  const secret = process.env.OWNWARE_CHANNEL_SECRET
  const store = new mod.FileChannelStore({ dir, ...(secret ? { secret } : {}) })
  const pairing = new mod.FilePairingStore({ file: join(dir, 'pairing.json') })
  return { store, pairing }
}

export function resolveDataDir(): string {
  return process.env.OWNWARE_DATA_DIR ?? join(homedir(), '.ownware')
}

/** The gateway's persisted bearer token (`<dataDir>/gateway-token`, slice 4)
 *  — the product path when auth is on. Flags/env stay as overrides. */
export function readGatewayTokenFile(dataDir: string): string | undefined {
  try {
    const t = readFileSync(join(dataDir, 'gateway-token'), 'utf8').trim()
    return t.length > 0 ? t : undefined
  } catch {
    return undefined // no token file — loopback default needs none
  }
}

export async function channelCommand(argv: string[]): Promise<void> {
  const mod = await loadShuttleChannels()
  if (!mod) {
    console.error('Channels need @ownware/shuttle, which is not installed.')
    console.error('  bun add @ownware/shuttle   (or: npm i @ownware/shuttle)')
    process.exit(1)
  }

  const dataDir = resolveDataDir()
  const { store, pairing } = buildChannelStores(mod, dataDir)

  if (argv[0] === 'start') {
    let gatewayUrl: string | undefined
    let gatewayToken: string | undefined
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '--gateway') gatewayUrl = argv[++i]
      else if (argv[i] === '--token') gatewayToken = argv[++i]
    }
    gatewayToken ??= process.env.OWNWARE_GATEWAY_TOKEN ?? readGatewayTokenFile(dataDir)
    const runner = new mod.ChannelRunner(store, {
      ...(gatewayUrl ? { gatewayUrl } : {}),
      ...(gatewayToken ? { gatewayToken } : {}),
      pairing,
    })
    const started = await runner.start()
    console.log(
      `[ownware] channels started: ${started.length ? started.join(', ') : '(none self-driving; webhook channels mount separately)'}`,
    )
    process.on('SIGINT', () => {
      runner.stop()
      process.exit(0)
    })
    return
  }

  console.log(await mod.runChannelCli(argv, store, { pairing }))
}
