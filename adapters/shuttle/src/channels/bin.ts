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
import { FilePairingStore } from '../pairing.js'

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
    // eslint-disable-next-line no-console
    console.log(`[ownware] channels started: ${started.length ? started.join(', ') : '(none self-driving; webhook channels mount separately)'}`)
    process.on('SIGINT', () => {
      runner.stop()
      process.exit(0)
    })
    return
  }

  const out = await runChannelCli(argv, store, { pairing })
  // eslint-disable-next-line no-console
  console.log(out)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
