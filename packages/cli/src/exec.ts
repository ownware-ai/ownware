/**
 * `ownware-cli exec` — the headless face. One prompt in,
 * machine-readable output out, exit code honest:
 *
 *   exec -p "…" --output-format text         streamed plain text (default)
 *   exec -p "…" --output-format json         one JSON object at the end
 *   exec -p "…" --output-format stream-json  NDJSON — each line is one raw
 *                                            gateway event payload, 1:1
 *                                            with the AsyncAPI channel
 *
 * Headless means nobody can answer an approval card: a
 * `permission.request` is DENIED immediately and noted on stderr — the
 * agent hears "no" and adapts, the pipeline never hangs. Exit 0 on a
 * completed reply, 1 on error/interruption.
 */

import { OwnwareClient, interpretSseEvent } from '@ownware/client'
import { ensureGateway } from './gateway.js'
import { ensureWorkspace } from './workspace.js'
import { pickDefaultProfile } from './index.js'

export interface ExecFlags {
  prompt?: string
  outputFormat: 'text' | 'json' | 'stream-json'
  profile?: string
  model?: string
  threadId?: string
  baseUrl?: string
  token?: string
  profilesDir?: string
  dataDir?: string
}

export function parseExecArgs(argv: readonly string[]): ExecFlags {
  const flags: ExecFlags = { outputFormat: 'text' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '-p':
      case '--prompt':
        flags.prompt = argv[++i]
        break
      case '-o':
      case '--output-format': {
        const value = argv[++i]
        if (value !== 'text' && value !== 'json' && value !== 'stream-json') {
          throw new Error(`--output-format must be text | json | stream-json, got "${value}"`)
        }
        flags.outputFormat = value
        break
      }
      case '--profile':
        flags.profile = argv[++i]
        break
      case '-m':
      case '--model':
        flags.model = argv[++i]
        break
      case '--thread':
        flags.threadId = argv[++i]
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
      default:
        throw new Error(`Unknown exec option: ${arg}`)
    }
  }
  if (flags.prompt === undefined || flags.prompt === '') {
    throw new Error('exec needs a prompt: ownware-cli exec -p "…"')
  }
  return flags
}

export interface ExecIO {
  readonly out: (chunk: string) => void
  readonly err: (chunk: string) => void
}

/** Run one headless prompt. Returns the process exit code. */
export async function runExec(
  flags: ExecFlags,
  io: ExecIO = {
    out: (c) => process.stdout.write(c),
    err: (c) => process.stderr.write(c),
  },
): Promise<number> {
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
      const picked = pickDefaultProfile(await client.profiles())
      if (picked === null) {
        io.err('No profiles found.\n')
        return 1
      }
      profileId = picked
    }
    // Continuing a thread means living in ITS workspace — registering a
    // new one for the cwd would mismatch and fork a fresh session.
    const workspaceId =
      flags.threadId !== undefined
        ? null
        : await ensureWorkspace(gateway.baseUrl, gateway.token, cwd)

    const started = await client.run({
      profileId,
      prompt: flags.prompt!,
      ...(flags.threadId !== undefined ? { threadId: flags.threadId } : {}),
      ...(flags.model !== undefined ? { model: flags.model } : {}),
      ...(workspaceId !== null ? { workspaceId } : {}),
    })
    return await streamExec(client, {
      runId: started.runId ?? null,
      threadId: started.threadId,
      format: flags.outputFormat,
      profileId,
      model: started.model ?? flags.model ?? null,
      io,
    })
  } catch (err) {
    io.err(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  } finally {
    await gateway.close()
  }
}

export interface StreamExecParams {
  readonly runId: string | null
  readonly threadId: string
  readonly format: 'text' | 'json' | 'stream-json'
  readonly profileId: string
  readonly model: string | null
  readonly io: ExecIO
}

/**
 * The headless stream loop — one run's events to machine output.
 * Exported so the NDJSON↔AsyncAPI contract is provable against a
 * deterministic scripted run without a model.
 */
export async function streamExec(
  client: OwnwareClient,
  params: StreamExecParams,
): Promise<number> {
  const { io } = params
  const streamId = params.runId ?? params.threadId
  let text = ''
  let failed: string | null = null
  let lastSeq = 0
  for await (const ev of client.events(streamId, {})) {
    if (params.format === 'stream-json') {
      io.out(JSON.stringify(ev.data) + '\n')
    }
    const interpreted = interpretSseEvent(ev.type, ev.data, lastSeq)
    lastSeq = interpreted.seq
    const one = interpreted.event
    if (one !== undefined) {
      if (one.type === 'delta') {
        text += one.text
        if (params.format === 'text') io.out(one.text)
      } else if (one.type === 'permission') {
        // Headless: deny immediately, never hang the pipeline.
        io.err(`permission.request for ${one.toolName} — denied (headless)\n`)
        try {
          if (params.runId !== null && one.operationHash !== undefined) {
            await client.decidePermission(params.runId, one.requestId, {
              decision: 'deny',
              operationHash: one.operationHash,
            })
          } else {
            await client.resume(params.threadId, {
              action: 'deny',
              requestId: one.requestId,
            })
          }
        } catch (err) {
          io.err(`could not deny: ${err instanceof Error ? err.message : String(err)}\n`)
        }
      } else if (one.type === 'error') {
        failed = one.message
      }
    }
    if (interpreted.stop) break
  }

  if (params.format === 'text' && text !== '' && !text.endsWith('\n')) io.out('\n')
  if (params.format === 'json') {
    io.out(
      JSON.stringify({
        threadId: params.threadId,
        runId: params.runId,
        profileId: params.profileId,
        model: params.model,
        status: failed === null ? 'completed' : 'error',
        ...(failed !== null ? { error: failed } : {}),
        text,
      }) + '\n',
    )
  }
  if (failed !== null) {
    if (params.format === 'text') io.err(`error: ${failed}\n`)
    return 1
  }
  return 0
}
