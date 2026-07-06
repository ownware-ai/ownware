/**
 * Lease gate unit/integration tests — "impossible, not managed."
 *
 * Drives the REAL loom writeFile tool through the gate (not a stub):
 * the second member's write is rejected at validateInput with the
 * structured denial as the tool result, the file is written exactly
 * once, leases renew on activity, and every lease releases when its
 * task leaves 'active'.
 */

import Database from 'better-sqlite3'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { builtinTools, type Tool, type ToolContext } from '@ownware/loom'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'
import { TeamStore } from '../../../src/team/store.js'
import { wrapMemberToolsWithLeaseGate } from '../../../src/team/lease-gate.js'
import { hintsOverlap } from '../../../src/team/scheduler.js'
import type { Team, TeamRun, TeamTask } from '../../../src/team/schema.js'

let db: Database.Database
let store: TeamStore
let ws: string
let team: Team
let run: TeamRun
let taskA: TeamTask
let taskB: TeamTask

const writeFileTool = builtinTools.find((t) => t.name === 'writeFile')!

function makeContext(): ToolContext {
  return {
    cwd: ws,
    signal: new AbortController().signal,
    sessionId: 'test',
    agentId: null,
    workspacePath: ws,
  } as unknown as ToolContext
}

function gateFor(task: TeamTask, slug: string, onDenied: (k: string) => void = () => {}): Tool[] {
  return wrapMemberToolsWithLeaseGate([writeFileTool], {
    store,
    runId: run.id,
    taskId: task.id,
    memberSlug: slug,
    workspacePath: ws,
    onDenied,
  })
}

/** validate → (on pass) execute — the executor's contract, condensed. */
async function invoke(tool: Tool, input: Record<string, unknown>) {
  const ctx = makeContext()
  const validation = await tool.validateInput!(input, ctx)
  if (validation.result === false) {
    return { isError: true, content: validation.message }
  }
  const out = tool.execute(input, ctx)
  const result = out instanceof Promise ? await out : await drainGenerator(out)
  return result
}

async function drainGenerator(gen: AsyncGenerator<unknown, { content: string; isError: boolean }>) {
  let next = await gen.next()
  while (!next.done) next = await gen.next()
  return next.value
}

beforeEach(async () => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const m of MIGRATIONS) db.exec(m.sql)
  store = new TeamStore(db)
  ws = await mkdtemp(join(tmpdir(), 'team-lease-'))
  team = store.createTeam({
    name: 'gate-crew',
    displayName: 'Gate Crew',
    charter: '',
    conductorName: 'Juno',
    members: [
      { slug: 'maya', profileId: 'p1', role: 'Backend' },
      { slug: 'rex', profileId: 'p2', role: 'Frontend' },
    ],
  })
  db.prepare(`INSERT INTO threads (id, profile_id) VALUES ('th1', 'p')`).run()
  run = store.createRun(team.id, 'th1', null)
  taskA = store.insertTask(run.id, { kind: 'work', title: 'A', brief: 'b', filedBy: 'conductor', owner: 'maya' })
  taskB = store.insertTask(run.id, { kind: 'work', title: 'B', brief: 'b', filedBy: 'conductor', owner: 'rex' })
  store.setTaskStatus(taskA.id, 'active')
  store.setTaskStatus(taskB.id, 'active')
})

afterEach(async () => {
  db.close()
  await rm(ws, { recursive: true, force: true })
})

describe('lease gate — single writer per resource', () => {
  it('second member is denied with the structured text; the file is written exactly once', async () => {
    const denied: string[] = []
    const [mayaWrite] = gateFor(taskA, 'maya')
    const [rexWrite] = gateFor(taskB, 'rex', (k) => denied.push(k))

    const first = await invoke(mayaWrite!, { file_path: 'shared.txt', content: 'maya was here\n' })
    expect(first.isError).toBe(false)

    const second = await invoke(rexWrite!, { file_path: './shared.txt', content: 'rex overwrites\n' })
    expect(second.isError).toBe(true)
    expect(second.content).toContain('is held by **maya**')
    expect(second.content).toContain(`T${taskA.seq}`)
    expect(second.content).toContain('(a)')
    expect(second.content).toContain('ask_team')
    expect(second.content).toContain('(c) wait')

    // No corruption — rex's write never executed (relative path
    // './shared.txt' contended on the same canonical key).
    expect(await readFile(join(ws, 'shared.txt'), 'utf-8')).toBe('maya was here\n')
    expect(denied).toEqual([resolve(ws, 'shared.txt')])
  })

  it('concurrent first-touch: exactly one of two simultaneous writers acquires', async () => {
    const [mayaWrite] = gateFor(taskA, 'maya')
    const [rexWrite] = gateFor(taskB, 'rex')
    const [r1, r2] = await Promise.all([
      invoke(mayaWrite!, { file_path: 'race.txt', content: 'maya\n' }),
      invoke(rexWrite!, { file_path: 'race.txt', content: 'rex\n' }),
    ])
    const errors = [r1, r2].filter((r) => r.isError)
    expect(errors).toHaveLength(1)
    const content = await readFile(join(ws, 'race.txt'), 'utf-8')
    expect(content === 'maya\n' || content === 'rex\n').toBe(true)
  })

  it('the holder is re-entrant per task and its lease renews on activity', async () => {
    const [mayaWrite] = gateFor(taskA, 'maya')
    await invoke(mayaWrite!, { file_path: 'mine.txt', content: 'v1\n' })
    const before = store.listLeases(run.id)[0]!
    await new Promise((r) => setTimeout(r, 1_100))
    // Same task, same key — the gate re-admits (writeFile itself would
    // refuse the overwrite; the GATE is what's under test, so validate
    // only) and the acquire renews the heartbeat.
    const revalidate = await mayaWrite!.validateInput!(
      { file_path: 'mine.txt', content: 'v2\n' },
      makeContext(),
    )
    expect(revalidate.result).toBe(true)
    const after = store.listLeases(run.id)[0]!
    expect(after.lastActivityAt > before.lastActivityAt).toBe(true)
    expect(await readFile(join(ws, 'mine.txt'), 'utf-8')).toBe('v1\n')
  })

  it('leases release when the task leaves active — and the resource is then acquirable', async () => {
    const [mayaWrite] = gateFor(taskA, 'maya')
    await invoke(mayaWrite!, { file_path: 'handoff.txt', content: 'maya v1\n' })
    expect(store.listLeases(run.id)).toHaveLength(1)

    const [rexWrite] = gateFor(taskB, 'rex')
    const deniedWhileHeld = await rexWrite!.validateInput!(
      { file_path: 'handoff.txt', content: 'rex\n' },
      makeContext(),
    )
    expect(deniedWhileHeld.result).toBe(false)

    store.completeTask('maya', taskA.id, 'wrote handoff.txt')
    expect(store.listLeases(run.id)).toHaveLength(0)

    // Post-release the gate admits rex — and rex's TASK now holds it.
    const afterRelease = await rexWrite!.validateInput!(
      { file_path: 'handoff.txt', content: 'rex\n' },
      makeContext(),
    )
    expect(afterRelease.result).toBe(true)
    expect(store.listLeases(run.id)[0]!.agentId).toBe('rex')
  })

  it("the original tool's own validateInput still runs after the gate passes", async () => {
    const [mayaWrite] = gateFor(taskA, 'maya')
    // writeFile's built-in sensitive-path block — gate passes (key
    // acquired), the chained original validator rejects.
    const result = await invoke(mayaWrite!, { file_path: '/etc/passwd', content: 'nope' })
    expect(result.isError).toBe(true)
    expect(result.content).not.toContain('is held by')
  })
})

describe('hint-overlap heuristic (anti-co-scheduling)', () => {
  it('detects prefix and glob overlap, ignores disjoint paths', () => {
    expect(hintsOverlap(['src/styles/**'], ['src/styles/tokens.css'])).toBe(true)
    expect(hintsOverlap(['src/api/**'], ['src/api'])).toBe(true)
    expect(hintsOverlap(['src/api/**'], ['src/components/**'])).toBe(false)
    expect(hintsOverlap([], ['anything'])).toBe(false)
    expect(hintsOverlap(['fruits.txt'], ['fruits.txt'])).toBe(true)
  })
})
