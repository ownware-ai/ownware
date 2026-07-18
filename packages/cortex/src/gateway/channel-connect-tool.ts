/**
 * connect_channel (CC3) — the run-side front-end of the channel procedure
 * engine. ONE generic tool; per-channel plugins live in the procedure
 * registry behind it. The model only decides WHEN to start it and
 * narrates; every state change is coded.
 *
 * The tool FRONTS the durable channel job (board §7.2): it starts or
 * re-attaches, streams the job's work lines as ToolProgress, and — the
 * one-mechanism requirement — presents a parked consent gate through the
 * EXISTING tool pause (`ctx.requestPermission` → permission.request event
 * → HITL → POST resume/decision, already rendered by web, terminal, and
 * chat channels via Shuttle). No second approval surface exists.
 *
 * Abort vs decline (consent contract: a timeout/abandonment never equals
 * a decision): when `requestPermission` resolves false AND the session is
 * aborting, the gate stays PARKED — re-invoking the tool re-presents it.
 * Only a live-session false (an explicit "no") records a decline, which
 * ends the procedure with the state-unchanged receipt. If the chat ends
 * mid-procedure the durable job keeps running in the worker; the next
 * `connect_channel` call re-attaches.
 */

import { defineTool, type Tool, type ToolProgress, type ToolResult } from '@ownware/loom'
import type { LoadedProfile } from '../profile/loader.js'
import type {
  ConnectorToolProvider,
  ConnectorToolProviderResult,
} from '../connector/providers/types.js'
import type { ChannelJob, ChannelJobStore } from './channel-job-store.js'
import { ChannelJobConflictError } from './channel-job-store.js'
import type { ChannelProcedureRegistry } from './channel-procedures.js'

const POLL_MS = 250

export interface ChannelConnectToolDeps {
  readonly jobs: ChannelJobStore
  readonly procedures: ChannelProcedureRegistry
  /** Nudge the worker so a fresh/resumed job starts without the poll delay. */
  readonly wake: () => void
  readonly profileId: string
}

export function createConnectChannelTool(deps: ChannelConnectToolDeps): Tool {
  return defineTool({
    name: 'connect_channel',
    description: [
      'Connect a messaging channel (e.g. whatsapp) to this agent, or resume a',
      'connection already in progress. Runs a coded, restart-safe procedure:',
      'it verifies the stored channel credentials with the provider, pauses',
      'for the owner\'s consent, registers the webhook, and records receipts.',
      'Connecting never makes the agent live — publishing is a separate,',
      'deliberate decision. Requires the channel to exist already (created',
      'with `ownware channel add`); pass its channelId.',
    ].join(' '),
    category: 'custom',
    isReadOnly: false,
    // A connect procedure legitimately outlives any per-tool timeout: it
    // waits on the owner's gate decision and on provider retries.
    disableTimeout: true,
    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: 'Channel kind to connect, e.g. "whatsapp"',
        },
        channelId: {
          type: 'string',
          description: 'The stored channel id (from `ownware channel list`). Optional when resuming.',
        },
        coexistence: {
          type: 'boolean',
          description: 'True when the number lives on the WhatsApp Business app (it keeps working; nothing moves).',
        },
      },
      required: ['channel'],
    },
    execute: async function* (
      input: Record<string, unknown>,
      ctx,
    ): AsyncGenerator<ToolProgress, ToolResult> {
      const channel = typeof input['channel'] === 'string' ? input['channel'] : ''
      const operation = `connect_${channel}`
      const procedure = deps.procedures.get(operation)
      if (!procedure) {
        return {
          content: `No connect procedure is available for "${channel}". Available: ${
            deps.procedures.size === 0 ? '(none — channel procedures are not enabled on this gateway)' : 'ask channel_status'
          }`,
          isError: true,
        }
      }

      let job = deps.jobs
        .listForProfile(deps.profileId)
        .find((j) => j.operation === operation && j.terminalAt === null) ?? null
      if (job) {
        yield { message: 'Resuming the connection already in progress' }
      } else {
        const channelId = typeof input['channelId'] === 'string' ? input['channelId'] : ''
        if (!channelId) {
          return {
            content: 'No connection is in progress and no channelId was given. ' +
              'Create the channel first (`ownware channel add`) and pass its id.',
            isError: true,
          }
        }
        try {
          job = deps.jobs.enqueue({
            profileId: deps.profileId,
            operation,
            channelKind: procedure.channelKind,
            channelId,
            params: {
              channelId,
              ...(input['coexistence'] === true ? { coexistence: true } : {}),
            },
            stepCount: procedure.steps.length,
          })
        } catch (error) {
          if (error instanceof ChannelJobConflictError) {
            job = deps.jobs.get(error.existingJobId)
          } else {
            throw error
          }
        }
        yield { message: 'Starting the connection' }
      }
      if (!job) return { content: 'Could not locate the connection job.', isError: true }
      deps.wake()

      let lastWorkLineSeq = 0
      for (;;) {
        const current = deps.jobs.get(job.jobId)
        if (!current) return { content: 'The connection job disappeared.', isError: true }

        // Stream new work lines as they land.
        for (const line of deps.jobs.workLines(job.jobId)) {
          if (line.seq <= lastWorkLineSeq) continue
          lastWorkLineSeq = line.seq
          yield { message: line.detail ? `${line.title} — ${line.detail}` : line.title }
        }

        if (current.terminalAt !== null) return summarize(deps.jobs, current)

        if (current.state === 'waiting_for_input' && current.gate) {
          const gate = current.gate
          const detail = [
            ...gate.included.map((l) => `✓ ${l}`),
            ...gate.excluded.map((l) => `— ${l}`),
            `If you decline: ${gate.onDecline}`,
          ].join('\n')
          const approved = await ctx.requestPermission(gate.title, detail)
          if (approved) {
            deps.jobs.respondToGate(job.jobId, {
              gateId: gate.id,
              action: 'approve',
              actor: 'owner',
            })
            deps.wake()
            continue
          }
          if (ctx.signal.aborted) {
            // Abandonment is not a decision: leave the gate parked.
            return {
              content: `Setup paused at "${gate.title}" — nothing was changed. ` +
                'Run connect_channel again to continue.',
              isError: false,
            }
          }
          deps.jobs.respondToGate(job.jobId, {
            gateId: gate.id,
            action: 'deny',
            actor: 'owner',
          })
          continue // the loop reports the terminal decline honestly
        }

        if (ctx.signal.aborted) {
          return {
            content: 'The chat ended but the connection keeps running in the background. ' +
              'Run connect_channel again to check on it.',
            isError: false,
          }
        }
        await sleep(POLL_MS, ctx.signal)
      }
    },
  })
}

function summarize(jobs: ChannelJobStore, job: ChannelJob): ToolResult {
  const receipts = jobs.receiptsForJob(job.jobId)
  const receiptLines = receipts.map((r) => `✓ ${r.title}`).join('\n')
  switch (job.state) {
    case 'succeeded':
      return {
        content: `Channel connected — and NOT live: nothing reaches a real customer until you publish; that stays its own decision.\n${receiptLines}`,
        isError: false,
        metadata: { jobId: job.jobId, outcomeCode: job.outcomeCode },
      }
    case 'cancelled':
      return {
        content: job.outcomeCode === 'gate_declined'
          ? `The connection was declined — nothing was changed.\n${receiptLines}`
          : `The connection was cancelled — nothing further was changed.\n${receiptLines}`,
        isError: false,
        metadata: { jobId: job.jobId, outcomeCode: job.outcomeCode },
      }
    default:
      return {
        content: `The connection failed (${job.outcomeCode ?? 'unknown'}). ` +
          'Nothing was published; already-completed steps are recorded in the receipts. ' +
          `Fix the cause and run connect_channel again.\n${receiptLines}`,
        isError: true,
        metadata: { jobId: job.jobId, outcomeCode: job.outcomeCode },
      }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Assembly-time provider: contributes `connect_channel` to every profile
 * once channel procedures are enabled on this gateway (registry non-empty
 * — read lazily so `enableChannelProcedures()` after boot still counts).
 */
export class ChannelConnectToolProvider implements ConnectorToolProvider {
  readonly source = 'channels'

  constructor(
    private readonly deps: Omit<ChannelConnectToolDeps, 'profileId'>,
  ) {}

  async getToolsForProfile(profile: LoadedProfile): Promise<ConnectorToolProviderResult> {
    if (this.deps.procedures.size === 0) return { tools: [], stubs: [] }
    return {
      tools: [createConnectChannelTool({
        ...this.deps,
        profileId: profile.config.name,
      })],
      stubs: [],
    }
  }
}
