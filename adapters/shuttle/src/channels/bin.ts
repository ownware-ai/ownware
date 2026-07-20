#!/usr/bin/env node
/**
 * `ownware-channel` bin — the executable for the channel CLI (SH1 part 3).
 * Wires argv + the on-disk encrypted store to the handlers, and runs the
 * long-lived `start` command (the ChannelRunner).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { FileChannelStore } from './store.js'
import { runChannelCli } from './cli.js'
import { ChannelRunner } from './runner.js'
import { ChannelWebhookHost } from './webhook-host.js'
import { FilePairingStore } from '../pairing.js'
import { FileWhatsAppDeliveryStore } from '../whatsapp/delivery-store.js'

/** The gateway's persisted bearer token (`<dataDir>/gateway-token`, slice 4)
 *  — the product path when auth is on. `--token` / env stay as overrides. */
function readGatewayTokenFile(dataDir: string): string | undefined {
  try {
    const t = readFileSync(join(dataDir, 'gateway-token'), 'utf8').trim()
    return t.length > 0 ? t : undefined
  } catch {
    return undefined // no token file — loopback default needs none
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const dataDir = process.env['OWNWARE_DATA_DIR'] ?? join(homedir(), '.ownware')
  const dir = process.env['OWNWARE_CHANNELS_DIR'] ?? join(dataDir, 'channels')
  const secret = process.env['OWNWARE_CHANNEL_SECRET']
  const store = new FileChannelStore({ dir, ...(secret ? { secret } : {}) })
  // One pairing file shared by the runner (mints codes) and `approve`
  // (redeems them from a separate, short-lived process).
  const pairing = new FilePairingStore({ file: join(dir, 'pairing.json') })
  const whatsappDelivery = new FileWhatsAppDeliveryStore({ dir, ...(secret ? { secret } : {}) })

  if (argv[0] === 'start') {
    let gatewayUrl: string | undefined
    let gatewayToken: string | undefined
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '--gateway') gatewayUrl = argv[++i]
      else if (argv[i] === '--token') gatewayToken = argv[++i]
    }
    gatewayToken ??= process.env['OWNWARE_GATEWAY_TOKEN'] ?? readGatewayTokenFile(dataDir)
    const runner = new ChannelRunner(store, {
      ...(gatewayUrl ? { gatewayUrl } : {}),
      ...(gatewayToken ? { gatewayToken } : {}),
      pairing,
    })
    const started = await runner.start()

    // Webhook channels (whatsapp/sms): mount them on the webhook host. The
    // host listens only when at least one enabled webhook channel exists.
    const publicBaseUrl = process.env['OWNWARE_WEBHOOK_PUBLIC_URL']
    const webhooks = new ChannelWebhookHost(store, {
      ...(gatewayUrl ? { gatewayUrl } : {}),
      ...(gatewayToken ? { gatewayToken } : {}),
      pairing,
      whatsappDelivery,
      ...(publicBaseUrl ? { publicBaseUrl } : {}),
    })
    const webhookPort = process.env['OWNWARE_WEBHOOK_PORT']
    const webhookHost = process.env['OWNWARE_WEBHOOK_HOST']
    const mounted = await webhooks.start({
      ...(webhookPort ? { port: Number(webhookPort) } : {}),
      ...(webhookHost ? { host: webhookHost } : {}),
    })

    // eslint-disable-next-line no-console
    console.log(`[ownware] channels started: ${started.length ? started.join(', ') : '(none self-driving)'}`)
    if (mounted.port != null) {
      // eslint-disable-next-line no-console
      console.log(
        `[ownware] webhooks listening on ${webhookHost ?? '127.0.0.1'}:${mounted.port} — put a public HTTPS tunnel or reverse proxy in front:\n${mounted.paths.map((p) => `  ${p}`).join('\n')}`,
      )
    }
    process.on('SIGINT', () => {
      runner.stop()
      void webhooks.stop().finally(() => process.exit(0))
    })
    return
  }

  const out = await runChannelCli(argv, store, { pairing, whatsappDelivery })
  // eslint-disable-next-line no-console
  console.log(out)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
