/**
 * `ownware channel` command logic (SH1 part 3) — the paste/click layer over the
 * store. Handlers are pure (take a store, return data/text) so they're testable;
 * the bin (bin.ts) wires argv + a FileChannelStore to them.
 *
 * Usage:
 *   ownware channel add telegram --profile acme --token 123:abc [--line business]
 *   ownware channel add slack    --profile acme --bot-token xoxb-… --app-token xapp-…
 *   ownware channel list
 *   ownware channel remove telegram-acme
 *   ownware channel start [--gateway http://127.0.0.1:3011] [--token …]
 */

import { isChannelKind, validateChannelConfig, type ChannelConfig, type ChannelKind } from './config.js'
import type { ChannelStore } from './store.js'
import type { DmPolicy, LinePolicy } from '../gate.js'
import type { PairingStore } from '../pairing.js'

/** CLI flag → credential key, per channel. */
const FLAG_TO_CRED: Record<ChannelKind, Record<string, string>> = {
  telegram: { token: 'token' },
  slack: { 'bot-token': 'botToken', 'app-token': 'appToken' },
  discord: { token: 'token' },
  whatsapp: { 'access-token': 'accessToken', 'phone-number-id': 'phoneNumberId', 'app-secret': 'appSecret', 'verify-token': 'verifyToken' },
  sms: { 'account-sid': 'accountSid', 'auth-token': 'authToken', from: 'from' },
}

export interface AddChannelArgs {
  readonly channel: ChannelKind
  readonly profileId: string
  readonly id?: string
  readonly credentials: Record<string, string>
  readonly line?: LinePolicy
}

export async function channelAdd(store: ChannelStore, args: AddChannelArgs): Promise<{ id: string }> {
  const id = args.id ?? `${args.channel}-${args.profileId}`
  const config: ChannelConfig = {
    id,
    channel: args.channel,
    profileId: args.profileId,
    credentials: args.credentials,
    ...(args.line ? { line: args.line } : {}),
    enabled: true,
  }
  const err = validateChannelConfig(config)
  if (err) throw new Error(err)
  await store.put(config)
  return { id }
}

export async function channelList(store: ChannelStore): Promise<
  Array<{ id: string; channel: ChannelKind; profileId: string; enabled: boolean }>
> {
  return (await store.list()).map((c) => ({ id: c.id, channel: c.channel, profileId: c.profileId, enabled: c.enabled !== false }))
}

export async function channelRemove(store: ChannelStore, id: string): Promise<boolean> {
  if (!(await store.get(id))) return false
  await store.remove(id)
  return true
}

// ── argv parsing (small, dependency-free) ────────────────────────────────────

function parseFlags(argv: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = 'true'
      }
    } else {
      positionals.push(a)
    }
  }
  return { positionals, flags }
}

function buildLine(flags: Record<string, string>): LinePolicy | undefined {
  const line: { dm?: DmPolicy; group?: 'mention' | 'all' | 'off' } = {}
  const preset = flags['line'] // convenience: business → dm open, personal → dm pairing
  if (preset === 'business') line.dm = 'open'
  else if (preset === 'personal') line.dm = 'pairing'
  const dm = flags['dm']
  if (dm === 'open' || dm === 'pairing' || dm === 'allowlist') line.dm = dm
  const group = flags['group']
  if (group === 'mention' || group === 'all' || group === 'off') line.group = group
  return Object.keys(line).length > 0 ? line : undefined
}

export interface ChannelCliDeps {
  /**
   * Pairing store shared with the running channels (the file-backed
   * store — `approve` runs in a separate process from the runner).
   */
  readonly pairing?: PairingStore
}

/**
 * Dispatch a `channel` subcommand (add/list/remove/approve). Returns text
 * output. `start` is handled by the bin (it runs the long-lived
 * ChannelRunner).
 */
export async function runChannelCli(argv: string[], store: ChannelStore, deps: ChannelCliDeps = {}): Promise<string> {
  const [sub, ...rest] = argv
  const { positionals, flags } = parseFlags(rest)

  if (sub === 'add') {
    const channel = positionals[0]
    if (!channel || !isChannelKind(channel)) {
      throw new Error(`usage: ownware channel add <telegram|slack|discord|whatsapp|sms> --profile <id> [creds…]`)
    }
    const profileId = flags['profile']
    if (!profileId) throw new Error('add: --profile <id> is required')

    const credentials: Record<string, string> = {}
    for (const [flag, key] of Object.entries(FLAG_TO_CRED[channel])) {
      if (flags[flag]) credentials[key] = flags[flag]!
    }
    const line = buildLine(flags)
    const { id } = await channelAdd(store, {
      channel,
      profileId,
      ...(flags['id'] ? { id: flags['id'] } : {}),
      credentials,
      ...(line ? { line } : {}),
    })
    return `✓ added channel "${id}" (${channel} → ${profileId})`
  }

  if (sub === 'list') {
    const rows = await channelList(store)
    if (rows.length === 0) return '(no channels connected)'
    return rows.map((r) => `${r.enabled ? '●' : '○'} ${r.id.padEnd(24)} ${r.channel.padEnd(9)} → ${r.profileId}`).join('\n')
  }

  if (sub === 'remove') {
    const id = positionals[0]
    if (!id) throw new Error('usage: ownware channel remove <id>')
    return (await channelRemove(store, id)) ? `✓ removed channel "${id}"` : `channel "${id}" not found`
  }

  if (sub === 'approve') {
    // The counterpart of the gate's pairing message ("Ask the owner to
    // approve you: ownware channel approve <channel> <code>").
    const channel = positionals[0]
    const code = positionals[1]
    if (!channel || !code) throw new Error('usage: ownware channel approve <channel> <code>')
    if (!deps.pairing) throw new Error('approve: no pairing store configured')
    const result = await deps.pairing.approveCode(channel, code)
    if (result.locked) return '✗ approvals are locked out after too many failed codes — try again later'
    return result.approved
      ? `✓ approved ${result.userId} on ${channel}`
      : '✗ code not recognized — expired, already used, or mistyped'
  }

  throw new Error(`unknown subcommand: ${sub ?? '(none)'} — expected add | list | remove | approve | start`)
}
