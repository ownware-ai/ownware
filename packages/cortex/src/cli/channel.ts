/**
 * `ownware channel` — bridge to the shuttle channel CLI, so the command the
 * docs (and the pairing message) advertise actually works on the main
 * `ownware` bin:
 *
 *   ownware channel add slack --profile assistant --bot-token … --app-token …
 *   ownware channel list | remove <id> | approve <channel> <code> | handoff | delivery | start
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
  FileWhatsAppDeliveryStore?: new (opts: { dir: string; secret?: string }) => unknown
  ChannelRunner: new (
    store: unknown,
    opts: { gatewayUrl?: string; gatewayToken?: string; pairing?: unknown },
  ) => {
    start(): Promise<string[]>
    stop(): void
    deliver(kind: string, target: string, text: string): Promise<boolean>
  }
  /** Webhook channel host (whatsapp/sms) — absent on older shuttle versions. */
  ChannelWebhookHost?: new (
    store: unknown,
    opts: {
      gatewayUrl?: string
      gatewayToken?: string
      pairing?: unknown
      publicBaseUrl?: string
      whatsappDelivery?: unknown
    },
  ) => {
    start(opts?: { port?: number; host?: string }): Promise<{ port: number | null; paths: string[] }>
    stop(): Promise<void>
  }
  runChannelCli(
    argv: string[],
    store: unknown,
    deps?: { pairing?: unknown; whatsappDelivery?: unknown },
  ): Promise<string>
}

/** Webhook-host listen/exposure settings from the environment. */
export function webhookEnvOptions(): {
  port?: number
  host?: string
  publicBaseUrl?: string
} {
  const port = process.env.OWNWARE_WEBHOOK_PORT
  const host = process.env.OWNWARE_WEBHOOK_HOST
  const publicBaseUrl = process.env.OWNWARE_WEBHOOK_PUBLIC_URL
  return {
    ...(port ? { port: Number(port) } : {}),
    ...(host ? { host } : {}),
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
  }
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
): { store: unknown; pairing: unknown; whatsappDelivery?: unknown } {
  const dir = process.env.OWNWARE_CHANNELS_DIR ?? join(dataDir, 'channels')
  const secret = process.env.OWNWARE_CHANNEL_SECRET
  const store = new mod.FileChannelStore({ dir, ...(secret ? { secret } : {}) })
  const pairing = new mod.FilePairingStore({ file: join(dir, 'pairing.json') })
  const whatsappDelivery = mod.FileWhatsAppDeliveryStore
    ? new mod.FileWhatsAppDeliveryStore({ dir, ...(secret ? { secret } : {}) })
    : undefined
  return { store, pairing, ...(whatsappDelivery ? { whatsappDelivery } : {}) }
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
  const { store, pairing, whatsappDelivery } = buildChannelStores(mod, dataDir)

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

    // Webhook channels (whatsapp/sms) mount on the webhook host — listens
    // only when at least one enabled webhook channel exists.
    let webhooks: { stop(): Promise<void> } | null = null
    if (mod.ChannelWebhookHost) {
      const { port, host, publicBaseUrl } = webhookEnvOptions()
      const hostInstance = new mod.ChannelWebhookHost(store, {
        ...(gatewayUrl ? { gatewayUrl } : {}),
        ...(gatewayToken ? { gatewayToken } : {}),
        pairing,
        ...(publicBaseUrl ? { publicBaseUrl } : {}),
      })
      const mounted = await hostInstance.start({
        ...(port !== undefined ? { port } : {}),
        ...(host !== undefined ? { host } : {}),
      })
      webhooks = hostInstance
      if (mounted.port != null) {
        console.log(
          `[ownware] webhooks listening on ${host ?? '127.0.0.1'}:${mounted.port} — put a public HTTPS tunnel or reverse proxy in front:\n${mounted.paths.map((p) => `  ${p}`).join('\n')}`,
        )
      }
    }

    console.log(
      `[ownware] channels started: ${started.length ? started.join(', ') : '(none self-driving)'}`,
    )
    process.on('SIGINT', () => {
      runner.stop()
      if (webhooks) void webhooks.stop().finally(() => process.exit(0))
      else process.exit(0)
    })
    return
  }

  console.log(await mod.runChannelCli(argv, store, {
    pairing,
    ...(whatsappDelivery ? { whatsappDelivery } : {}),
  }))
}
