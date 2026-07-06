/**
 * TeamStore unit tests — schema round-trips, the kernel-only status
 * writer (transition validation), owner-checked completion, and the
 * board's writer discipline (L3).
 */

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'
import { TeamStore } from '../../../src/team/store.js'
import type { Team, TeamRun } from '../../../src/team/schema.js'

let db: Database.Database
let store: TeamStore

function makeTeam(): Team {
  return store.createTeam({
    name: 'design-eng',
    displayName: 'Design Eng',
    charter: 'Build things well.',
    conductorName: 'Juno',
    members: [
      { slug: 'maya', profileId: 'backend-profile', role: 'Backend' },
      { slug: 'rex', profileId: 'frontend-profile', role: 'Frontend' },
    ],
  })
}

function makeRun(team: Team): TeamRun {
  // team_runs.thread_id references threads — create a real thread row.
  db.prepare(`INSERT INTO threads (id, profile_id) VALUES (?, ?)`).run('thread-1', 'p')
  return store.createRun(team.id, 'thread-1', null)
}

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const m of MIGRATIONS) db.exec(m.sql)
  store = new TeamStore(db)
})

afterEach(() => {
  db.close()
})

describe('TeamStore — teams', () => {
  it('round-trips a team with ordered members', () => {
    const team = makeTeam()
    const loaded = store.getTeam(team.id)
    expect(loaded).not.toBeNull()
    expect(loaded!.members.map((m) => m.slug)).toEqual(['maya', 'rex'])
    expect(loaded!.conductorName).toBe('Juno')
    expect(store.getTeamByName('design-eng')!.id).toBe(team.id)
  })

  it('instruction fragments round-trip and compose into the conductor SOUL', async () => {
    const team = makeTeam()
    const updated = store.updateTeam(team.id, {
      fragments: {
        identity: 'Ships features end-to-end. Not infra.',
        workflow: 'Data lands first, then backend freezes the contract.',
        rules: 'Never deploy without asking.',
      },
    })!
    expect(updated.fragments.identity).toContain('end-to-end')
    expect(updated.fragments.principles).toBeUndefined()
    // Reload from disk-shape rows, not the in-memory return.
    const fresh = store.getTeam(team.id)!
    expect(fresh.fragments.workflow).toContain('freezes the contract')

    const { materializeConductor } = await import('../../../src/team/conductor.js')
    const { config } = materializeConductor(fresh, { checkpointDir: '/tmp/x' })
    expect(config.systemPrompt).toContain('## Identity — who this company is')
    expect(config.systemPrompt).toContain('freezes the contract')
    expect(config.systemPrompt).not.toContain('## Charter')

    // Legacy fallback: no fragments → the freeform charter section.
    const bare = store.updateTeam(team.id, { fragments: {} })!
    const legacy = materializeConductor(bare, { checkpointDir: '/tmp/x' })
    expect(legacy.config.systemPrompt).toContain('## Charter')
    expect(legacy.config.systemPrompt).toContain('Build things well.')
  })

  it('conductor depth (escalation + extra instructions) round-trips and composes into the SOUL', async () => {
    const team = makeTeam()
    const { materializeConductor } = await import('../../../src/team/conductor.js')

    // Default: no escalation set → 'balanced', no operator block.
    expect(team.conductorEscalation).toBe('balanced')
    expect(team.conductorInstructions).toBeNull()
    const base = materializeConductor(store.getTeam(team.id)!, { checkpointDir: '/tmp/x' })
    expect(base.config.systemPrompt).toContain('## How closely to involve the user')
    expect(base.config.systemPrompt).toContain('Resolve the routine coordination yourself')
    expect(base.config.systemPrompt).not.toContain('Direct instructions from your operator')

    // Autonomous + operator instructions compose distinct, real guidance.
    const updated = store.updateTeam(team.id, {
      conductorEscalation: 'autonomous',
      conductorInstructions: 'Prefer TypeScript. Never touch the billing module.',
    })!
    expect(updated.conductorEscalation).toBe('autonomous')
    const fresh = store.getTeam(team.id)!
    expect(fresh.conductorInstructions).toContain('billing module')
    const soul = materializeConductor(fresh, { checkpointDir: '/tmp/x' }).config.systemPrompt!
    expect(soul).toContain('Minimize interruptions')
    expect(soul).toContain('## Direct instructions from your operator')
    expect(soul).toContain('Never touch the billing module')

    // Consultative is a different stance again.
    const consult = store.updateTeam(team.id, { conductorEscalation: 'consultative' })!
    const soul2 = materializeConductor(consult, { checkpointDir: '/tmp/x' }).config.systemPrompt!
    expect(soul2).toContain('Keep the user closely in the loop')

    // Clearing instructions (null) removes the operator block.
    const cleared = store.updateTeam(team.id, { conductorInstructions: null })!
    expect(cleared.conductorInstructions).toBeNull()
  })

  it('product surface round-trips and stamps the conductor productId', async () => {
    const team = makeTeam()
    expect(team.surface).toBe('ownware') // store default for pre-surface callers
    const updated = store.updateTeam(team.id, { surface: 'ownware-coder' })!
    expect(updated.surface).toBe('ownware-coder')
    const { materializeConductor } = await import('../../../src/team/conductor.js')
    const { config } = materializeConductor(store.getTeam(team.id)!, { checkpointDir: '/tmp/x' })
    expect(config.productId).toBe('ownware-coder')
  })

  it('rejects an unknown product surface at the schema boundary', async () => {
    const { CreateTeamSchema } = await import('../../../src/team/schema.js')
    const ok = CreateTeamSchema.safeParse({
      name: 'x',
      displayName: 'X',
      surface: 'ownware-design',
      members: [{ slug: 'a', profileId: 'p', role: 'R' }],
    })
    expect(ok.success).toBe(true)
    const bad = CreateTeamSchema.safeParse({
      name: 'x',
      displayName: 'X',
      surface: 'not-a-real-product',
      members: [{ slug: 'a', profileId: 'p', role: 'R' }],
    })
    expect(bad.success).toBe(false)
  })

  it('reference docs round-trip and inject into the conductor SOUL', async () => {
    const team = makeTeam()
    expect(team.references).toEqual([])
    const updated = store.updateTeam(team.id, {
      references: [
        { name: 'API contract', content: 'GET /habits returns Habit[].' },
        { name: 'Style guide', content: 'Use tabs. No semicolons.' },
      ],
    })!
    expect(updated.references).toHaveLength(2)
    const fresh = store.getTeam(team.id)!
    expect(fresh.references[0]!.name).toBe('API contract')
    expect(fresh.references[1]!.content).toContain('No semicolons')

    const { materializeConductor } = await import('../../../src/team/conductor.js')
    const soul = materializeConductor(fresh, { checkpointDir: '/tmp/x' }).config.systemPrompt!
    expect(soul).toContain('## Reference — docs the team keeps on hand')
    expect(soul).toContain('### API contract')
    expect(soul).toContain('No semicolons')

    // Clearing references empties the section + cascades the rows.
    const cleared = store.updateTeam(team.id, { references: [] })!
    expect(cleared.references).toEqual([])
    const soul2 = materializeConductor(cleared, { checkpointDir: '/tmp/x' }).config.systemPrompt!
    expect(soul2).not.toContain('docs the team keeps on hand')
  })

  it('granted composio toolkits round-trip and cascade on delete', () => {
    const team = makeTeam()
    expect(team.composioToolkits).toEqual([])
    const updated = store.updateTeam(team.id, { composioToolkits: ['gmail', 'github'] })!
    expect(updated.composioToolkits).toEqual(['gmail', 'github'])
    expect(store.getTeam(team.id)!.composioToolkits).toEqual(['gmail', 'github'])
    // Clearing removes them.
    expect(store.updateTeam(team.id, { composioToolkits: [] })!.composioToolkits).toEqual([])
    // Re-grant then delete → rows cascade.
    store.updateTeam(team.id, { composioToolkits: ['slack'] })
    expect(store.deleteTeam(team.id)).toBe(true)
    const orphans = db
      .prepare(`SELECT COUNT(*) AS n FROM team_connectors WHERE team_id = ?`)
      .get(team.id) as { n: number }
    expect(orphans.n).toBe(0)
  })

  it('deleting a team cascades its reference docs', () => {
    const team = makeTeam()
    store.updateTeam(team.id, { references: [{ name: 'R', content: 'c' }] })
    expect(store.deleteTeam(team.id)).toBe(true)
    const orphans = db
      .prepare(`SELECT COUNT(*) AS n FROM team_references WHERE team_id = ?`)
      .get(team.id) as { n: number }
    expect(orphans.n).toBe(0)
  })

  it('updates roster atomically and deletes cascade members', () => {
    const team = makeTeam()
    const updated = store.updateTeam(team.id, {
      members: [{ slug: 'solo', profileId: 'p1', role: 'Everything' }],
    })
    expect(updated!.members).toHaveLength(1)
    expect(store.deleteTeam(team.id)).toBe(true)
    const orphans = db.prepare(`SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?`).get(team.id) as { n: number }
    expect(orphans.n).toBe(0)
  })
})

describe('TeamStore — tasks (the Board)', () => {
  let team: Team
  let run: TeamRun

  beforeEach(() => {
    team = makeTeam()
    run = makeRun(team)
  })

  it('assigns per-run seq ordinals starting at 1', () => {
    const goal = store.insertTask(run.id, { kind: 'goal', title: 'G', brief: 'b', filedBy: 'conductor', status: 'active' })
    const t2 = store.insertTask(run.id, { kind: 'work', title: 'W', brief: 'b', filedBy: 'conductor', owner: 'maya' })
    expect(goal.seq).toBe(1)
    expect(t2.seq).toBe(2)
    expect(store.getTaskBySeq(run.id, 2)!.id).toBe(t2.id)
  })

  it('kernel status writer rejects illegal transitions', () => {
    const t = store.insertTask(run.id, { kind: 'work', title: 'W', brief: 'b', filedBy: 'conductor', owner: 'maya' })
    expect(t.status).toBe('ready')
    expect(() => store.setTaskStatus(t.id, 'review')).toThrow(/Illegal task status transition/)
    store.setTaskStatus(t.id, 'active')
    store.setTaskStatus(t.id, 'failed', 'it broke')
    expect(store.getTask(t.id)!.blockedReason).toBe('it broke')
    store.setTaskStatus(t.id, 'ready') // retry path
    expect(() => store.setTaskStatus(store.insertTask(run.id, { kind: 'work', title: 'X', brief: 'b', filedBy: 'c' }).id, 'draft')).toThrow()
  })

  it('completeTask enforces ownership and active status', () => {
    const t = store.insertTask(run.id, { kind: 'work', title: 'W', brief: 'b', filedBy: 'conductor', owner: 'maya' })
    expect(() => store.completeTask('rex', t.id, 'done!')).toThrow(/belongs to "maya"/)
    expect(() => store.completeTask('maya', t.id, 'done!')).toThrow(/not active/)
    store.setTaskStatus(t.id, 'active')
    const done = store.completeTask('maya', t.id, 'wrote the store, see src/data/store.ts')
    expect(done.status).toBe('done')
    expect(done.result).toContain('src/data/store.ts')
  })

  it('answerQuestion writes the answer and closes a ready question', () => {
    const q = store.insertTask(run.id, { kind: 'question', title: 'Q?', brief: 'Q?', filedBy: 'maya' })
    const answered = store.answerQuestion(q.id, 'today only')
    expect(answered.status).toBe('done')
    expect(answered.result).toBe('today only')
    expect(() => store.answerQuestion(answered.id, 'again')).toThrow()
  })

  it('run receipt + cost accumulation round-trips', () => {
    store.addRunCost(run.id, 0.5)
    store.addRunCost(run.id, 0.25)
    expect(store.getRun(run.id)!.costUsd).toBeCloseTo(0.75)
    store.setRunStatus(run.id, 'done', {
      summary: 'shipped',
      outcome: 'done',
      taskCounts: { draft: 0, ready: 0, active: 0, blocked: 0, review: 0, done: 2, failed: 0, cancelled: 0 },
      costUsd: 0.75,
      durationMs: 1234,
    })
    const fresh = store.getRun(run.id)!
    expect(fresh.status).toBe('done')
    expect(fresh.receipt!.summary).toBe('shipped')
    expect(store.listActiveRuns()).toHaveLength(0)
  })

  it('thread deletion cascades the run and its board', () => {
    store.insertTask(run.id, { kind: 'goal', title: 'G', brief: 'b', filedBy: 'conductor', status: 'active' })
    db.prepare(`DELETE FROM threads WHERE id = ?`).run('thread-1')
    expect(store.getRun(run.id)).toBeNull()
    const tasks = db.prepare(`SELECT COUNT(*) AS n FROM team_tasks WHERE run_id = ?`).get(run.id) as { n: number }
    expect(tasks.n).toBe(0)
  })
})
