/**
 * Live-test runner for the self-driving shuttles (Telegram / Slack / Discord).
 * These dial OUT, so no public webhook URL is needed — just tokens + a running
 * gateway. Build the package first (`bun run build`), then:
 *
 *   OWNWARE_GATEWAY_URL=http://127.0.0.1:3011 \
 *   OWNWARE_PROFILE=ownware-research \
 *   CHANNEL=telegram TELEGRAM_BOT_TOKEN=123:abc \
 *   node examples/run-channel.mjs
 *
 * See examples/README.md for the per-channel tokens and the gateway note
 * (run the gateway with OWNWARE_GATEWAY_TLS=0 for a plain-HTTP local test).
 */

import { HttpGatewayClient } from '../dist/index.js'
import { TelegramShuttle } from '../dist/telegram/index.js'
import { SlackShuttle } from '../dist/slack/index.js'
import { DiscordShuttle } from '../dist/discord/index.js'

function env(key) {
  const v = process.env[key]
  if (!v) {
    console.error(`✗ Missing required env var: ${key}`)
    process.exit(1)
  }
  return v
}

const gatewayUrl = process.env.OWNWARE_GATEWAY_URL ?? 'http://127.0.0.1:3011'
const profileId = process.env.OWNWARE_PROFILE ?? 'ownware-research'
const channel = process.env.CHANNEL

const gateway = new HttpGatewayClient({
  baseUrl: gatewayUrl,
  ...(process.env.OWNWARE_GATEWAY_TOKEN ? { token: process.env.OWNWARE_GATEWAY_TOKEN } : {}),
})

async function main() {
  console.log(`[shuttle] channel=${channel} · profile="${profileId}" · gateway=${gatewayUrl}`)
  let shuttle
  switch (channel) {
    case 'telegram':
      shuttle = new TelegramShuttle({ token: env('TELEGRAM_BOT_TOKEN'), profileId, gateway })
      break
    case 'slack':
      shuttle = new SlackShuttle({
        botToken: env('SLACK_BOT_TOKEN'),
        appToken: env('SLACK_APP_TOKEN'),
        profileId,
        gateway,
      })
      break
    case 'discord':
      shuttle = new DiscordShuttle({ token: env('DISCORD_BOT_TOKEN'), profileId, gateway })
      break
    default:
      console.error('✗ Set CHANNEL=telegram | slack | discord')
      console.error('  (WhatsApp/SMS are webhook-based — they need an HTTP endpoint; see README.md)')
      process.exit(1)
  }
  await shuttle.start()
  console.log('[shuttle] connected. Message your bot — Ctrl-C to stop.')
  process.on('SIGINT', () => {
    shuttle.stop()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error('[shuttle] failed to start:', err)
  process.exit(1)
})
