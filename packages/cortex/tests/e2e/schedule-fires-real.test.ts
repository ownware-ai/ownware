/**
 * E2E: a due schedule fires a REAL single-agent run through the real
 * gateway (real Haiku call via OpenRouter) and records it honestly.
 *
 * Gated behind RUN_SCHEDULE_E2E=1 (makes a real API call, ~$0.01) so it
 * never runs in the normal suite. Run:
 *   RUN_SCHEDULE_E2E=1 ./node_modules/.bin/vitest run tests/e2e/schedule-fires-real.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OpenRouterProvider, registerProvider } from '@ownware/loom'
import { OwnwareGateway } from '../../src/gateway/server.js'

const KEY =
  process.env.OPENROUTER_API_KEY && !process.env.OPENROUTER_API_KEY.includes('OWNWARE_TEST_DUMMY')
    ? process.env.OPENROUTER_API_KEY
    : undefined
const RUN = process.env.RUN_SCHEDULE_E2E === '1'

describe.runIf(RUN && Boolean(KEY))('e2e: schedule fires a real run', () => {
  it('a due schedule dispatches a real Haiku run and records it succeeded', async () => {
    registerProvider(new OpenRouterProvider({ apiKey: KEY! }))
    const root = mkdtempSync(join(tmpdir(), 'sched-e2e-'))
    const profilesDir = join(root, 'profiles')
    const benchDir = join(profilesDir, 'sched-bench')
    mkdirSync(benchDir, { recursive: true })
    writeFileSync(
      join(benchDir, 'agent.json'),
      JSON.stringify({
        name: 'sched-bench',
        model: 'openrouter:haiku-4.5',
        tools: { preset: 'none' },
        context: { git: false, os: false, cwd: false, datetime: false, project: false },
      }),
    )
    writeFileSync(join(benchDir, 'SOUL.md'), '# Bench\nReply in one short sentence.')

    const gateway = new OwnwareGateway({
      port: 0,
      profilesDir,
      dataDir: join(root, 'data'),
      dbPath: join(root, 'sched.db'),
      tls: false,
      disableAuth: true,
    })
    await gateway.start()
    const baseUrl = `http://127.0.0.1:${gateway.port}`
    try {
      const s = gateway.schedules.create({
        profileId: 'sched-bench',
        name: 'e2e once',
        prompt: 'Say hello in exactly three words.',
        cadenceKind: 'once',
        cadenceExpr: String(Date.now()),
        cadenceDisplay: 'Once',
        timezone: 'UTC',
        nextRunAt: Date.now(),
      })

      // Fire the due schedule now, then wait for the real run to finish.
      await gateway.tickSchedulesOnce()
      await gateway.drainSchedules()

      const runs = gateway.schedules.listRuns(s.id)
      expect(runs.length).toBe(1)
      expect(runs[0]!.runStatus).toBe('succeeded')
      expect(runs[0]!.threadId).toBeTruthy()
      expect(runs[0]!.finishedAt).toBeGreaterThan(0)

      // A one-off → completed, cursor nulled (never fires again).
      const after = gateway.schedules.get(s.id)!
      expect(after.state).toBe('completed')
      expect(after.nextRunAt).toBeNull()

      // Prove a REAL model call produced output: hydrate the thread and
      // confirm there's an assistant turn with text.
      const hy = (await (
        await fetch(`${baseUrl}/api/v1/threads/${runs[0]!.threadId}/hydrate`)
      ).json()) as { messages: Array<{ role: string; parts?: Array<{ kind: string; text?: string }> }> }
      const assistant = hy.messages.find((m) => m.role === 'assistant')
      expect(assistant).toBeTruthy()
      const text = (assistant?.parts ?? [])
        .filter((p) => p.kind === 'text')
        .map((p) => p.text ?? '')
        .join('')
      expect(text.trim().length).toBeGreaterThan(0)
      console.log(`[schedule-e2e] real run produced: "${text.trim().slice(0, 80)}"`)

      // Prove the run-now HTTP endpoint also dispatches a real run, without
      // touching the schedule's cursor (a manual extra run).
      const created = (await (
        await fetch(`${baseUrl}/api/v1/schedules`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            profileId: 'sched-bench',
            name: 'run-now',
            prompt: 'Reply with the single word ok.',
            cadenceKind: 'interval',
            cadenceExpr: '60',
            cadenceDisplay: 'Every 60 minutes',
            timezone: 'UTC',
          }),
        })
      ).json()) as { schedule: { id: string } }
      const rn = await fetch(`${baseUrl}/api/v1/schedules/${created.schedule.id}/run-now`, {
        method: 'POST',
      })
      expect(rn.status).toBe(202)
      await gateway.drainSchedules()
      const rnRuns = gateway.schedules.listRuns(created.schedule.id)
      expect(rnRuns.length).toBe(1)
      expect(rnRuns[0]!.runStatus).toBe('succeeded')
      expect(rnRuns[0]!.threadId).toBeTruthy()
      // run-now must NOT advance the cursor (no nextRunAt was set on create).
      expect(gateway.schedules.get(created.schedule.id)!.nextRunAt).toBeNull()
    } finally {
      await gateway.stop().catch(() => {})
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
