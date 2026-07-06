/**
 * E2E: an agent TEAM run, end to end, against a real LLM.
 *
 * Drives the full S1 walking skeleton through the real gateway HTTP
 * surface (Principle 18 — the same data path the client will use):
 *
 *   POST /api/v1/teams                 (build the team)
 *   POST /api/v1/teams/:id/runs        (bind run → thread, park conductor session)
 *   POST /api/v1/run                   (user → Conductor: the goal)
 *   ... kernel: crystallize → board_write → serial member dispatch →
 *       complete_task → dep clears → second member → board dry →
 *       conductor wake → finish_run ...
 *   GET  /api/v1/threads/:tid/team-board   (assert board rows at the end)
 *
 * Scenario 2 (restart mid-run): boot a gateway manually, stop it while
 * a member is mid-task, boot a fresh gateway over the same dataDir —
 * the run must resume from disk and finish (HANDOVER-1 scenario list).
 *
 * Skipped without OPENROUTER_API_KEY. Cost ≈ a few cents per run
 * (haiku-4.5 for conductor + members).
 *
 * Run: OPENROUTER_API_KEY=sk-or-... npx vitest run tests/e2e/team-run.test.ts
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { OpenRouterProvider, registerProvider } from '@ownware/loom'
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTestGateway } from '../framework/harness/gateway.js'
import { ApiClient } from '../framework/harness/api-client.js'
import { OwnwareGateway } from '../../src/gateway/server.js'
import type { BoardView } from '../../src/team/schema.js'

const openrouterKey =
  process.env.OPENROUTER_API_KEY && !process.env.OPENROUTER_API_KEY.includes('OWNWARE_TEST_DUMMY')
    ? process.env.OPENROUTER_API_KEY
    : undefined

function skipIfNoKey(): boolean {
  if (!openrouterKey) {
    console.log('⏭ Skipping team-run e2e: OPENROUTER_API_KEY not set')
    return true
  }
  return false
}

beforeAll(() => {
  if (openrouterKey) {
    registerProvider(new OpenRouterProvider({ apiKey: openrouterKey }))
  }
})

const MODEL = 'openrouter:haiku-4.5'

const MEMBER_SOUL =
  'You are a careful, fast worker. Do exactly what your task brief says using your tools — ' +
  'no extra files, no extra commentary. When the done-criteria are met, call complete_task immediately.'

const MEMBER_TOOLS = {
  preset: 'coding',
  // Files only: no shell, no credentials, no plan scaffolding — keeps
  // the member's action space small and the test deterministic.
  deny: ['shell_execute', 'request_credential', 'plan_draft', 'plan_submit'],
}

const GOAL_PROMPT =
  'Create two text files in the workspace. ' +
  'ana must create fruits.txt containing exactly three fruit names, one per line. ' +
  'ben must create colors.txt containing exactly three color names, one per line. ' +
  "Process note (for task structure only, NOT a done-criterion): make ben's task depend on ana's task so it runs second. " +
  'The done-criteria are just the two files and their contents. ' +
  'The scope is fully clear: do NOT ask me any questions. Write the goal to the board and file both tasks now.'

interface RunCreated {
  readonly runId: string
  readonly threadId: string
  readonly conductorProfileId: string
}

async function pollBoard(
  client: ApiClient,
  threadId: string,
  until: (board: BoardView) => boolean,
  timeoutMs: number,
  intervalMs = 1_000,
): Promise<BoardView> {
  const deadline = Date.now() + timeoutMs
  let last: BoardView | null = null
  while (Date.now() < deadline) {
    const res = await client.get<BoardView>(`/api/v1/threads/${threadId}/team-board`)
    if (res.status === 200) {
      last = res.body
      if (until(res.body)) return res.body
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(
    `Board never reached the expected state within ${timeoutMs}ms. Last board: ${JSON.stringify(last, null, 2)}`,
  )
}

describe('e2e: team run through the gateway with a real LLM', () => {
  it(
    'happy path: goal in → crystallize → serial members → finish_run → receipt out',
    async () => {
      if (skipIfNoKey()) return

      const gw = await createTestGateway({
        profiles: [
          { name: 'writer-a', model: MODEL, soulMd: MEMBER_SOUL, tools: MEMBER_TOOLS },
          { name: 'writer-b', model: MODEL, soulMd: MEMBER_SOUL, tools: MEMBER_TOOLS },
        ],
      })
      try {
        // Workspace the members will write into.
        const wsPath = join(gw.tmpDir, 'ws')
        await mkdir(wsPath, { recursive: true })
        const wsRes = await gw.client.post<{ id: string }>('/api/v1/workspaces', { path: wsPath })
        expect(wsRes.status).toBeLessThan(300)
        const workspaceId = wsRes.body.id

        // Build the team.
        const teamRes = await gw.client.post<{ id: string }>('/api/v1/teams', {
          name: 'design-eng',
          displayName: 'Design Eng',
          charter: 'A two-person file-writing crew. Split work cleanly, hand off via the board.',
          conductorName: 'Juno',
          conductorModel: MODEL,
          members: [
            { slug: 'ana', profileId: 'writer-a', role: 'Writer A' },
            { slug: 'ben', profileId: 'writer-b', role: 'Writer B' },
          ],
        })
        expect(teamRes.status).toBe(201)

        // Start a run — binds a thread and parks the conductor session.
        const runRes = await gw.client.post<RunCreated>(`/api/v1/teams/${teamRes.body.id}/runs`, {
          workspaceId,
        })
        expect(runRes.status).toBe(201)
        const { threadId, conductorProfileId } = runRes.body

        // The user's goal goes through the NORMAL run endpoint — the
        // conductor session is reused from gateway state (D16).
        const goRes = await gw.client.post<{ threadId: string }>('/api/v1/run', {
          threadId,
          profileId: conductorProfileId,
          prompt: GOAL_PROMPT,
        })
        expect(goRes.status).toBe(200)

        // The whole run is autonomous from here. Wait for the receipt.
        const board = await pollBoard(gw.client, threadId, (b) => b.run.status !== 'active', 300_000)

        // ── Assertions: the board tells the whole story ──────────────
        expect(board.run.status).toBe('done')
        expect(board.run.receipt).not.toBeNull()
        expect(board.run.receipt!.summary.length).toBeGreaterThan(0)
        expect(board.run.costUsd).toBeGreaterThan(0)

        const goal = board.tasks.find((t) => t.kind === 'goal')
        expect(goal).toBeDefined()
        expect(goal!.status).toBe('done')

        const work = board.tasks.filter((t) => t.kind === 'work')
        expect(work.length).toBeGreaterThanOrEqual(2)
        const doneWork = work.filter((t) => t.status === 'done')
        expect(doneWork.length).toBeGreaterThanOrEqual(2)
        for (const t of doneWork) {
          expect(t.result).not.toBeNull()
          expect(t.owner === 'ana' || t.owner === 'ben').toBe(true)
        }
        // Dependency actually recorded: at least one done work task
        // waits on another.
        expect(work.some((t) => t.dependsOn.length > 0)).toBe(true)

        // S3: done is a verdict — the kernel ran a fresh-eyes verify
        // round and it passed before finish_run was accepted.
        const verifies = board.tasks.filter((t) => t.kind === 'verify')
        expect(verifies.length).toBeGreaterThanOrEqual(1)
        expect(verifies[verifies.length - 1]!.status).toBe('done')
        expect(verifies[verifies.length - 1]!.result).toMatch(/PASS/i)

        // The real artifacts exist — not just rows claiming they do.
        const fruits = await readFile(join(wsPath, 'fruits.txt'), 'utf-8')
        const colors = await readFile(join(wsPath, 'colors.txt'), 'utf-8')
        expect(fruits.trim().split('\n').length).toBe(3)
        expect(colors.trim().split('\n').length).toBe(3)
      } finally {
        await gw.stop()
      }
    },
    600_000,
  )

  it(
    'S2 parallel: two independent tasks run concurrently and both finish',
    async () => {
      if (skipIfNoKey()) return

      const gw = await createTestGateway({
        profiles: [
          { name: 'writer-a', model: MODEL, soulMd: MEMBER_SOUL, tools: MEMBER_TOOLS },
          { name: 'writer-b', model: MODEL, soulMd: MEMBER_SOUL, tools: MEMBER_TOOLS },
        ],
      })
      try {
        const wsPath = join(gw.tmpDir, 'ws')
        await mkdir(wsPath, { recursive: true })
        const wsRes = await gw.client.post<{ id: string }>('/api/v1/workspaces', { path: wsPath })
        const teamRes = await gw.client.post<{ id: string }>('/api/v1/teams', {
          name: 'parallel-crew',
          displayName: 'Parallel Crew',
          conductorName: 'Juno',
          conductorModel: MODEL,
          members: [
            { slug: 'ana', profileId: 'writer-a', role: 'Writer A' },
            { slug: 'ben', profileId: 'writer-b', role: 'Writer B' },
          ],
        })
        const runRes = await gw.client.post<RunCreated>(`/api/v1/teams/${teamRes.body.id}/runs`, {
          workspaceId: wsRes.body.id,
        })
        const { threadId, conductorProfileId } = runRes.body

        await gw.client.post('/api/v1/run', {
          threadId,
          profileId: conductorProfileId,
          prompt:
            'Create two text files in the workspace: ana creates fruits.txt with exactly three fruit names ' +
            '(one per line), ben creates colors.txt with exactly three color names (one per line). ' +
            'These tasks are fully INDEPENDENT — file them with NO dependencies between them so they run in parallel. ' +
            'The scope is fully clear: do NOT ask me any questions.',
        })

        // Sample the board while it runs — we must SEE two tasks active
        // at once to call it parallel.
        let maxSimultaneouslyActive = 0
        const board = await pollBoard(
          gw.client,
          threadId,
          (b) => {
            const active = b.tasks.filter((t) => t.kind === 'work' && t.status === 'active').length
            if (active > maxSimultaneouslyActive) maxSimultaneouslyActive = active
            return b.run.status !== 'active'
          },
          300_000,
          200,
        )

        expect(board.run.status).toBe('done')
        expect(maxSimultaneouslyActive).toBeGreaterThanOrEqual(2)
        const doneWork = board.tasks.filter((t) => t.kind === 'work' && t.status === 'done')
        expect(doneWork.length).toBeGreaterThanOrEqual(2)
        await access(join(wsPath, 'fruits.txt'))
        await access(join(wsPath, 'colors.txt'))
      } finally {
        await gw.stop()
      }
    },
    600_000,
  )

  it(
    'S2 member death: abort a working member mid-task — the task fails, the Conductor re-assigns, the run finishes',
    async () => {
      if (skipIfNoKey()) return

      const gw = await createTestGateway({
        profiles: [{ name: 'writer-a', model: MODEL, soulMd: MEMBER_SOUL, tools: MEMBER_TOOLS }],
      })
      try {
        const wsPath = join(gw.tmpDir, 'ws')
        await mkdir(wsPath, { recursive: true })
        const wsRes = await gw.client.post<{ id: string }>('/api/v1/workspaces', { path: wsPath })
        const teamRes = await gw.client.post<{ id: string }>('/api/v1/teams', {
          name: 'phoenix-crew',
          displayName: 'Phoenix Crew',
          conductorName: 'Juno',
          conductorModel: MODEL,
          members: [{ slug: 'ana', profileId: 'writer-a', role: 'Writer' }],
        })
        const runRes = await gw.client.post<RunCreated>(`/api/v1/teams/${teamRes.body.id}/runs`, {
          workspaceId: wsRes.body.id,
        })
        const { threadId, conductorProfileId } = runRes.body

        await gw.client.post('/api/v1/run', {
          threadId,
          profileId: conductorProfileId,
          prompt:
            'Have ana create story.txt in the workspace containing a short story of at least 150 words. ' +
            'One single task. The scope is fully clear: do NOT ask me any questions.',
        })

        // Wait until ana is genuinely working, then kill her loop.
        const mid = await pollBoard(
          gw.client,
          threadId,
          (b) => b.tasks.some((t) => t.kind === 'work' && t.status === 'active'),
          180_000,
          250,
        )
        const activeTask = mid.tasks.find((t) => t.kind === 'work' && t.status === 'active')!
        const scheduler = gw.gateway.teams!.scheduler
        // The session may take a beat to register; retry the abort.
        const abortDeadline = Date.now() + 30_000
        let aborted = false
        while (!aborted && Date.now() < abortDeadline) {
          aborted = scheduler.abortTask(activeTask.id)
          if (!aborted) await new Promise((r) => setTimeout(r, 250))
        }
        expect(aborted).toBe(true)

        // Death → failed → conductor wake → re-assign (re-queues) →
        // fresh dispatch → done. The whole recovery is autonomous.
        const board = await pollBoard(gw.client, threadId, (b) => b.run.status !== 'active', 300_000)
        expect(board.run.status).toBe('done')
        const work = board.tasks.filter((t) => t.kind === 'work')
        expect(work.some((t) => t.status === 'done')).toBe(true)
        await access(join(wsPath, 'story.txt'))
        const story = await readFile(join(wsPath, 'story.txt'), 'utf-8')
        expect(story.split(/\s+/).length).toBeGreaterThan(100)
      } finally {
        await gw.stop()
      }
    },
    600_000,
  )

  it(
    'S3 verify-gap loop: the verifier catches a missing deliverable, files the gap, the team fixes it, round 2 passes',
    async () => {
      if (skipIfNoKey()) return

      const gw = await createTestGateway({
        profiles: [{ name: 'writer-a', model: MODEL, soulMd: MEMBER_SOUL, tools: MEMBER_TOOLS }],
      })
      try {
        const wsPath = join(gw.tmpDir, 'ws')
        await mkdir(wsPath, { recursive: true })
        const wsRes = await gw.client.post<{ id: string }>('/api/v1/workspaces', { path: wsPath })
        const teamRes = await gw.client.post<{ id: string }>('/api/v1/teams', {
          name: 'gap-crew',
          displayName: 'Gap Crew',
          conductorName: 'Juno',
          conductorModel: MODEL,
          members: [{ slug: 'ana', profileId: 'writer-a', role: 'Writer' }],
        })
        const runRes = await gw.client.post<RunCreated>(`/api/v1/teams/${teamRes.body.id}/runs`, {
          workspaceId: wsRes.body.id,
        })
        const { threadId, conductorProfileId } = runRes.body

        // The trap: done-criteria require TWO files, but the Conductor
        // is explicitly told to file only ONE task initially. Only the
        // fresh-eyes verifier can catch the missing second file.
        await gw.client.post('/api/v1/run', {
          threadId,
          profileId: conductorProfileId,
          prompt:
            'The goal: the workspace must contain BOTH data.txt (exactly three fruit names, one per line) ' +
            'AND readme.txt (exactly one line: "see data.txt"). Write BOTH files into the goal\'s done-criteria. ' +
            'However, for the first wave file ONLY ONE task: ana creates data.txt. Do NOT file a task for ' +
            'readme.txt yet — trust the process. Do not ask me any questions.',
        })

        const board = await pollBoard(gw.client, threadId, (b) => b.run.status !== 'active', 420_000)

        expect(board.run.status).toBe('done')
        const verifies = board.tasks.filter((t) => t.kind === 'verify')
        // Round 1 failed (gap filed), the fix ran, round 2+ passed.
        expect(verifies.length).toBeGreaterThanOrEqual(2)
        expect(verifies[verifies.length - 1]!.status).toBe('done')
        expect(verifies[verifies.length - 1]!.result).toMatch(/PASS/i)
        const gapTasks = board.tasks.filter((t) => t.kind === 'work' && t.filedBy === 'verifier')
        expect(gapTasks.length).toBeGreaterThanOrEqual(1)
        expect(gapTasks.every((t) => t.status === 'done' || t.status === 'cancelled')).toBe(true)
        await access(join(wsPath, 'data.txt'))
        await access(join(wsPath, 'readme.txt'))
      } finally {
        await gw.stop()
      }
    },
    600_000,
  )

  it(
    'S3 budget cap: the run pauses with a decision; the user approves a raise; the run completes',
    async () => {
      if (skipIfNoKey()) return

      const gw = await createTestGateway({
        profiles: [{ name: 'writer-a', model: MODEL, soulMd: MEMBER_SOUL, tools: MEMBER_TOOLS }],
      })
      try {
        const wsPath = join(gw.tmpDir, 'ws')
        await mkdir(wsPath, { recursive: true })
        const wsRes = await gw.client.post<{ id: string }>('/api/v1/workspaces', { path: wsPath })
        const teamRes = await gw.client.post<{ id: string }>('/api/v1/teams', {
          name: 'thrifty-crew',
          displayName: 'Thrifty Crew',
          conductorName: 'Juno',
          conductorModel: MODEL,
          // Absurdly small cap: the crystallize turn alone exceeds it,
          // so the pause fires before any member is dispatched.
          maxCostUsd: 0.0001,
          members: [{ slug: 'ana', profileId: 'writer-a', role: 'Writer' }],
        })
        const runRes = await gw.client.post<RunCreated>(`/api/v1/teams/${teamRes.body.id}/runs`, {
          workspaceId: wsRes.body.id,
        })
        const { threadId, conductorProfileId } = runRes.body

        // Two SEQUENTIAL tasks: the budget is boundary-checked (costs
        // land when turns/sessions complete — see BUILD-BOARD B13), so
        // the pause must fire at the boundary between task 1 and
        // task 2: once ana's first session cost lands, the gate stops
        // the second dispatch.
        await gw.client.post('/api/v1/run', {
          threadId,
          profileId: conductorProfileId,
          prompt:
            'Two tasks for ana, strictly sequential: first create note-1.txt containing the word "hello"; ' +
            'then (second task, depending on the first) create note-2.txt containing the word "world". ' +
            'The scope is fully clear: do NOT ask me any scope questions.',
        })

        // The pause: first task done, second still ready, nothing
        // active, run alive — the budget wake has the floor.
        await pollBoard(
          gw.client,
          threadId,
          (b) =>
            b.run.status === 'active' &&
            b.tasks.some((t) => t.kind === 'work' && t.status === 'done') &&
            b.tasks.some((t) => t.kind === 'work' && t.status === 'ready') &&
            !b.tasks.some((t) => (t.kind === 'work' || t.kind === 'verify') && t.status === 'active'),
          180_000,
          500,
        )
        // Give the budget wake + ask_user a beat, then confirm the
        // pause holds: the second task is still parked.
        await new Promise((r) => setTimeout(r, 10_000))
        const midBoard = await gw.client.get<BoardView>(`/api/v1/threads/${threadId}/team-board`)
        expect(midBoard.body.run.status).toBe('active')
        expect(midBoard.body.tasks.some((t) => t.kind === 'work' && t.status === 'ready')).toBe(true)
        expect(
          midBoard.body.tasks.some((t) => (t.kind === 'work' || t.kind === 'verify') && t.status === 'active'),
        ).toBe(false)

        // The user approves a raise. The Conductor must set_budget and
        // the kernel resumes automatically.
        await gw.client.post('/api/v1/run', {
          threadId,
          profileId: conductorProfileId,
          prompt: 'Yes — raise the budget to $2.00 and continue.',
        })

        const board = await pollBoard(gw.client, threadId, (b) => b.run.status !== 'active', 300_000)
        expect(board.run.status).toBe('done')
        expect(board.run.maxCostUsd).toBe(2)
        expect(await readFile(join(wsPath, 'note-1.txt'), 'utf-8')).toContain('hello')
        expect(await readFile(join(wsPath, 'note-2.txt'), 'utf-8')).toContain('world')
      } finally {
        await gw.stop()
      }
    },
    600_000,
  )

  it(
    'restart mid-run: kill the gateway while a member works, reboot, the run resumes and finishes',
    async () => {
      if (skipIfNoKey()) return

      // Manual boot (not the harness) — we need to stop and re-start a
      // gateway over the SAME dataDir, which the harness's auto-rm stop
      // does not support.
      const tmp = await mkdtemp(join(tmpdir(), 'cortex-team-restart-'))
      try {
        const profilesDir = join(tmp, 'profiles')
        const dataDir = join(tmp, 'data')
        const dbPath = join(tmp, 'test.db')
        const wsPath = join(tmp, 'ws')
        await mkdir(wsPath, { recursive: true })
        for (const name of ['writer-a', 'writer-b']) {
          const dir = join(profilesDir, name)
          await mkdir(dir, { recursive: true })
          await writeFile(
            join(dir, 'agent.json'),
            JSON.stringify({
              name,
              model: MODEL,
              tools: MEMBER_TOOLS,
              context: { cwd: false, datetime: false, git: false, os: false, project: false },
            }),
          )
          await writeFile(join(dir, 'SOUL.md'), MEMBER_SOUL)
        }

        const gw1 = new OwnwareGateway({ port: 0, profilesDir, dataDir, dbPath })
        await gw1.start()
        const client1 = new ApiClient(`http://127.0.0.1:${gw1.port}`, gw1.token)

        const wsRes = await client1.post<{ id: string }>('/api/v1/workspaces', { path: wsPath })
        const teamRes = await client1.post<{ id: string }>('/api/v1/teams', {
          name: 'restart-crew',
          displayName: 'Restart Crew',
          conductorName: 'Juno',
          conductorModel: MODEL,
          members: [
            { slug: 'ana', profileId: 'writer-a', role: 'Writer A' },
            { slug: 'ben', profileId: 'writer-b', role: 'Writer B' },
          ],
        })
        expect(teamRes.status).toBe(201)
        const runRes = await client1.post<RunCreated>(`/api/v1/teams/${teamRes.body.id}/runs`, {
          workspaceId: wsRes.body.id,
        })
        expect(runRes.status).toBe(201)
        const { threadId } = runRes.body

        await client1.post('/api/v1/run', {
          threadId,
          profileId: runRes.body.conductorProfileId,
          prompt: GOAL_PROMPT,
        })

        // Wait until a member is genuinely mid-task, then pull the plug.
        await pollBoard(
          client1,
          threadId,
          (b) => b.tasks.some((t) => t.kind === 'work' && t.status === 'active'),
          180_000,
          250,
        )
        await gw1.stop()

        // The board survived on disk; the in-flight member did not.
        // A fresh gateway must resume: orphaned active → ready →
        // re-dispatch → ... → finish_run.
        const gw2 = new OwnwareGateway({ port: 0, profilesDir, dataDir, dbPath })
        await gw2.start()
        try {
          const client2 = new ApiClient(`http://127.0.0.1:${gw2.port}`, gw2.token)
          const board = await pollBoard(client2, threadId, (b) => b.run.status !== 'active', 300_000)

          expect(board.run.status).toBe('done')
          expect(board.run.receipt).not.toBeNull()
          const doneWork = board.tasks.filter((t) => t.kind === 'work' && t.status === 'done')
          expect(doneWork.length).toBeGreaterThanOrEqual(2)
          await access(join(wsPath, 'fruits.txt'))
          await access(join(wsPath, 'colors.txt'))
        } finally {
          await gw2.stop()
        }
      } finally {
        await rm(tmp, { recursive: true, force: true })
      }
    },
    900_000,
  )
})
