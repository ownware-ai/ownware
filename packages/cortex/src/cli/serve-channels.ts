/**
 * One-process channels (Slice 7): `ownware serve` boots shuttle's
 * ChannelRunner in-process against its own gateway, so "the agent answers
 * in Slack" is ONE deployment, not two terminals.
 *
 * The architecture is unchanged — the runner still drives the gateway
 * over the HTTP wire contract on localhost (shuttle stays a *client*);
 * only the deployment collapses. Shuttle remains a runtime-optional
 * dependency: absent module → channels are skipped, the gateway is
 * unaffected.
 *
 * This wiring is also the schedule-delivery host (Slice 8): once the
 * runner is up, it registers itself as the gateway's delivery sink, so a
 * schedule with `deliver: { channel, target }` pushes its result out
 * through the same running channel.
 */

import type { OwnwareGateway } from '../gateway/server.js'
import {
  loadShuttleChannels,
  buildChannelStores,
  webhookEnvOptions,
  type ShuttleChannelsModule,
} from './channel.js'

export interface InProcessChannels {
  readonly started: string[]
  /** Webhook host mount info — null when no webhook channel exists (or old shuttle). */
  readonly webhooks: { readonly port: number; readonly paths: string[] } | null
  stop(): void
}

export interface BootChannelsOptions {
  readonly gateway: OwnwareGateway
  /** Base URL the in-process runner talks to — plain-HTTP loopback. */
  readonly gatewayUrl: string
  readonly dataDir: string
  /** Injectable module loader (tests). Default: the real optional import. */
  readonly loader?: () => Promise<ShuttleChannelsModule | null>
}

/**
 * Start every stored channel in-process and register the schedule-delivery
 * sink. Returns null when @ownware/shuttle isn't installed (channels simply
 * don't exist in this deployment — the CLI verbs print the install hint).
 */
export async function bootChannels(opts: BootChannelsOptions): Promise<InProcessChannels | null> {
  const mod = await (opts.loader ?? loadShuttleChannels)()
  if (!mod) return null

  const { store, pairing } = buildChannelStores(mod, opts.dataDir)
  const runner = new mod.ChannelRunner(store, {
    gatewayUrl: opts.gatewayUrl,
    // In-process: the gateway's own token. On loopback auth is off and the
    // header is harmless; on an authed bind it is exactly what's needed.
    gatewayToken: opts.gateway.token,
    pairing,
  })
  const started = await runner.start()

  // Webhook channels (whatsapp/sms) mount on the webhook host (CC0). The
  // host reads the same store and listens only when at least one enabled
  // webhook channel exists — no webhook channels, no extra port. Loopback
  // bind by default: a tunnel/reverse proxy provides the public HTTPS side.
  let webhookHost: { stop(): Promise<void> } | null = null
  let webhooks: InProcessChannels['webhooks'] = null
  if (mod.ChannelWebhookHost) {
    const { port, host, publicBaseUrl } = webhookEnvOptions()
    const instance = new mod.ChannelWebhookHost(store, {
      gatewayUrl: opts.gatewayUrl,
      gatewayToken: opts.gateway.token,
      pairing,
      ...(publicBaseUrl ? { publicBaseUrl } : {}),
    })
    const mounted = await instance.start({
      ...(port !== undefined ? { port } : {}),
      ...(host !== undefined ? { host } : {}),
    })
    webhookHost = instance
    if (mounted.port != null) webhooks = { port: mounted.port, paths: mounted.paths }
  }

  // Channel connect procedures (CC3): the BYO credential resolver reads
  // the SAME shuttle channel store the runner uses — the seam that keeps
  // the credential-location decision (board §9.2) reversible. Resolved
  // values are secrets and stay inside procedure step code.
  const channelStore = store as {
    get(id: string): Promise<{ credentials?: Record<string, string> } | undefined>
  }
  try {
    opts.gateway.enableChannelProcedures({
      resolve: async (channelId) => (await channelStore.get(channelId))?.credentials ?? null,
    })
  } catch (err) {
    // Older gateway builds without channel procedures: channels still run.
    console.error(
      `  channel procedures: not enabled — ${err instanceof Error ? err.message : err}`,
    )
  }

  // Slice 8: schedule results push out through the running channels. A
  // requested delivery with no matching channel is an ERROR (the runner
  // records it honestly as failed-to-deliver), never a silent drop.
  opts.gateway.setScheduleDeliverySink(async (d) => {
    const ok = await runner.deliver(d.channel, d.target, d.text)
    if (!ok) {
      throw new Error(
        `no running '${d.channel}' channel in this process — connect one with \`ownware channel add ${d.channel} …\` and restart serve`,
      )
    }
  })

  return {
    started,
    webhooks,
    stop: (): void => {
      opts.gateway.setScheduleDeliverySink(null)
      runner.stop()
      if (webhookHost) void webhookHost.stop()
    },
  }
}
