/**
 * `ownware schedule` — proactive runs from the command line ("it messages
 * you every morning"). Thin REST client of a RUNNING gateway: schedules
 * live in the gateway's DB and fire from its ScheduleRunner, so the CLI
 * talks to the process that owns them instead of opening the DB itself.
 *
 *   ownware schedule add --profile assistant --name morning \
 *     --prompt "summarize my inbox" --daily 08:30 --deliver slack:#general
 *   ownware schedule list | remove <id> | runs <id>
 */

import { resolveDataDir, readGatewayTokenFile } from './channel.js'

const DELIVER_CHANNELS = new Set(['slack', 'telegram', 'discord', 'whatsapp', 'sms'])

interface GatewayConn {
  readonly url: string
  readonly token: string | undefined
}

function usage(): string {
  return `ownware schedule — proactive runs on a cadence (requires a running gateway: \`ownware serve\`)

  ownware schedule add --profile <id> --name <name> --prompt "<text>"
                    (--daily HH:MM | --every <N>m|<N>h | --once <ISO-time>)
                    [--deliver <channel>:<target>]   push the result to a connected
                                                     channel (slack:#general,
                                                     telegram:<chatId>, …)
                    [--tz <IANA>]                    default: this machine's timezone
  ownware schedule list
  ownware schedule remove <id>
  ownware schedule runs <id>

  Common flags: --gateway <url> (default http://127.0.0.1:3011),
                --token <bearer> (default: <dataDir>/gateway-token when present)`
}

/** Pull --gateway/--token out of argv (mutates the array). */
function extractConn(argv: string[]): GatewayConn {
  let url = 'http://127.0.0.1:3011'
  let token: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--gateway') {
      url = argv[i + 1] ?? url
      argv.splice(i--, 2)
    } else if (argv[i] === '--token') {
      token = argv[i + 1]
      argv.splice(i--, 2)
    }
  }
  token ??= process.env.OWNWARE_GATEWAY_TOKEN ?? readGatewayTokenFile(resolveDataDir())
  return { url: url.replace(/\/+$/, ''), token }
}

async function call(
  conn: GatewayConn,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetch(`${conn.url}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(conn.token ? { Authorization: `Bearer ${conn.token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  } catch {
    throw new Error(
      `no gateway reachable at ${conn.url} — start one with \`ownware serve\` (or pass --gateway <url>)`,
    )
  }
  const text = await res.text()
  if (!res.ok) {
    let message = text
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string }
      message = parsed.message ?? parsed.error ?? text
    } catch {
      // non-JSON error body — use as-is
    }
    throw new Error(`gateway ${res.status}: ${message}`)
  }
  return JSON.parse(text) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Cadence flags → the wire shape
// ---------------------------------------------------------------------------

function parseCadence(flags: Map<string, string>): {
  cadenceKind: string
  cadenceExpr: string
  cadenceDisplay: string
} {
  const picked = ['--daily', '--every', '--once'].filter((f) => flags.has(f))
  if (picked.length !== 1) {
    throw new Error('pick exactly one cadence: --daily HH:MM | --every <N>m|<N>h | --once <ISO>')
  }
  if (flags.has('--daily')) {
    const time = flags.get('--daily')!
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) {
      throw new Error(`--daily wants HH:MM (24h), got "${time}"`)
    }
    return {
      cadenceKind: 'daily',
      cadenceExpr: JSON.stringify({ time }),
      cadenceDisplay: `daily at ${time}`,
    }
  }
  if (flags.has('--every')) {
    const raw = flags.get('--every')!
    const m = /^(\d+)\s*(m|min|h|hr)?$/.exec(raw)
    if (!m) throw new Error(`--every wants <N>m or <N>h, got "${raw}"`)
    const n = Number(m[1])
    const minutes = m[2]?.startsWith('h') ? n * 60 : n
    if (minutes <= 0) throw new Error('--every must be positive')
    return {
      cadenceKind: 'interval',
      cadenceExpr: String(minutes),
      cadenceDisplay: `every ${raw}`,
    }
  }
  const at = flags.get('--once')!
  if (!Number.isFinite(Date.parse(at))) {
    throw new Error(`--once wants an ISO time (e.g. 2026-07-04T09:00), got "${at}"`)
  }
  return { cadenceKind: 'once', cadenceExpr: at, cadenceDisplay: `once at ${at}` }
}

function parseDeliver(raw: string): { channel: string; target: string } {
  const idx = raw.indexOf(':')
  const channel = idx > 0 ? raw.slice(0, idx) : ''
  const target = idx > 0 ? raw.slice(idx + 1) : ''
  if (!DELIVER_CHANNELS.has(channel) || target.length === 0) {
    throw new Error(
      `--deliver wants <channel>:<target> with channel one of ${[...DELIVER_CHANNELS].join('|')}, got "${raw}"`,
    )
  }
  return { channel, target }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function addSchedule(conn: GatewayConn, argv: string[]): Promise<void> {
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) throw new Error(`schedule add: unexpected argument "${a}"`)
    const v = argv[++i]
    if (v === undefined) throw new Error(`schedule add: ${a} needs a value`)
    flags.set(a, v)
  }
  const profileId = flags.get('--profile')
  const name = flags.get('--name')
  const prompt = flags.get('--prompt')
  if (!profileId || !name || !prompt) {
    throw new Error('schedule add needs --profile, --name and --prompt\n\n' + usage())
  }

  const cadence = parseCadence(flags)
  const timezone = flags.get('--tz') ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const deliver = flags.has('--deliver') ? parseDeliver(flags.get('--deliver')!) : undefined

  const out = await call(conn, 'POST', '/api/v1/schedules', {
    profileId,
    name,
    prompt,
    ...cadence,
    timezone,
    ...(deliver ? { deliver } : {}),
  })
  const schedule = out.schedule as {
    id: string
    nextRunAt: number | null
    cadenceDisplay: string
  }
  console.log(`Created ${schedule.id} — ${cadence.cadenceDisplay} (${timezone})`)
  if (schedule.nextRunAt != null) {
    console.log(`  next run: ${new Date(schedule.nextRunAt).toLocaleString()}`)
  }
  if (deliver) console.log(`  delivers to: ${deliver.channel}:${deliver.target}`)
}

async function listSchedules(conn: GatewayConn): Promise<void> {
  const out = await call(conn, 'GET', '/api/v1/schedules')
  const schedules = out.schedules as Array<{
    id: string
    name: string
    profileId: string
    cadenceDisplay: string
    state: string
    nextRunAt: number | null
    deliver: { channel: string; target: string } | null
  }>
  if (schedules.length === 0) {
    console.log('No schedules. Create one with `ownware schedule add …`.')
    return
  }
  for (const s of schedules) {
    const next = s.nextRunAt != null ? new Date(s.nextRunAt).toLocaleString() : '—'
    const deliver = s.deliver != null ? `  → ${s.deliver.channel}:${s.deliver.target}` : ''
    console.log(`${s.id}  [${s.state}]  ${s.name} (${s.profileId}) — ${s.cadenceDisplay}, next: ${next}${deliver}`)
  }
}

async function removeSchedule(conn: GatewayConn, id: string | undefined): Promise<void> {
  if (!id) throw new Error('schedule remove needs an id (see `ownware schedule list`)')
  await call(conn, 'DELETE', `/api/v1/schedules/${encodeURIComponent(id)}`)
  console.log(`Removed ${id}`)
}

async function listRuns(conn: GatewayConn, id: string | undefined): Promise<void> {
  if (!id) throw new Error('schedule runs needs an id (see `ownware schedule list`)')
  const out = await call(conn, 'GET', `/api/v1/schedules/${encodeURIComponent(id)}/runs`)
  const runs = out.runs as Array<{
    id: string
    runStatus: string
    scheduledFor: number
    deliveryStatus: string
    errorMessage: string | null
  }>
  if (runs.length === 0) {
    console.log('No runs yet.')
    return
  }
  for (const r of runs) {
    const when = new Date(r.scheduledFor).toLocaleString()
    const err = r.errorMessage != null ? ` — ${r.errorMessage}` : ''
    console.log(`${when}  ${r.runStatus}  (delivery: ${r.deliveryStatus})${err}`)
  }
}

export async function scheduleCommand(argv: string[]): Promise<void> {
  const rest = [...argv]
  const conn = extractConn(rest)
  const sub = rest.shift()

  try {
    switch (sub) {
      case 'add':
        await addSchedule(conn, rest)
        return
      case 'list':
      case 'ls':
        await listSchedules(conn)
        return
      case 'remove':
      case 'rm':
        await removeSchedule(conn, rest[0])
        return
      case 'runs':
        await listRuns(conn, rest[0])
        return
      default:
        console.log(usage())
        if (sub !== undefined && sub !== 'help' && sub !== '--help' && sub !== '-h') {
          process.exitCode = 1
        }
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
