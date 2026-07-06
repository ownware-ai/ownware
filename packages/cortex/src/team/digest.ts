/**
 * Team digest — awareness as a bounded render of board state (L8).
 *
 * Pure function: (team, run, tasks, viewer) → string. No LLM, no I/O.
 * Recomputed from LIVE store state on every board change and delivered
 * to running members through loom's ReminderInjector (`hook.context`
 * event — see BUILD-BOARD delta A5: loom's ReminderEvent union is
 * closed, so the digest rides the engine's generic context channel).
 *
 * The size is bounded by construction — it renders CURRENT state, not
 * history, so eight agents or three, hour-long run or week-long, the
 * digest stays a glance. Resist every temptation to put more in it
 * (doc 11 Part 10: digest fatigue is the failure mode).
 */

import type { Team, TeamLease, TeamRun, TeamTask } from './schema.js'

const RESULT_TRIM = 160
const MAX_QUEUED_LINES = 8

function trim(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`
}

function taskRef(task: TeamTask): string {
  return `T${task.seq}`
}

/**
 * Render the digest for one member. `viewerSlug` shapes the "You:" and
 * "Open for you:" lines; everything else is shared.
 */
export function renderDigest(
  team: Team,
  run: TeamRun,
  tasks: readonly TeamTask[],
  viewerSlug: string,
  leases: readonly TeamLease[] = [],
): string {
  const goal = tasks.find((t) => t.kind === 'goal')
  const lines: string[] = []
  const holdsFor = (slug: string): string => {
    const keys = leases.filter((l) => l.agentId === slug).map((l) => l.resourceKey)
    return keys.length > 0 ? `, holds ${keys.slice(0, 4).join(', ')}` : ''
  }

  lines.push(
    `TEAM ${team.displayName} — ${goal ? trim(goal.title, 80) : 'goal being crystallized'}`,
  )

  const mine = tasks.find((t) => t.owner === viewerSlug && t.status === 'active')
  if (mine) {
    const deliverables = mine.deliverables.length > 0 ? ` Deliverables: ${mine.deliverables.join(', ')}` : ''
    lines.push(`You: ${taskRef(mine)} "${trim(mine.title, 80)}" (active).${deliverables}`)
  }

  const teammates = team.members.filter((m) => m.slug !== viewerSlug)
  if (teammates.length > 0) {
    lines.push('Teammates:')
    for (const member of teammates) {
      const active = tasks.find((t) => t.owner === member.slug && t.status === 'active')
      const lastDone = [...tasks].reverse().find((t) => t.owner === member.slug && t.status === 'done')
      if (active) {
        lines.push(
          `  ${member.slug}/${trim(member.role, 30)} — ${taskRef(active)} "${trim(active.title, 60)}" active${holdsFor(member.slug)}`,
        )
      } else if (lastDone) {
        const result = lastDone.result ? ` → result: "${trim(lastDone.result, RESULT_TRIM)}"` : ''
        lines.push(`  ${member.slug}/${trim(member.role, 30)} — ${taskRef(lastDone)} "${trim(lastDone.title, 60)}" done${result}`)
      } else {
        lines.push(`  ${member.slug}/${trim(member.role, 30)} — idle`)
      }
    }
  }

  const openQuestionsForViewer = tasks.filter(
    (t) => t.kind === 'question' && t.owner === viewerSlug && (t.status === 'ready' || t.status === 'active'),
  )
  for (const q of openQuestionsForViewer) {
    lines.push(`Open for you: ${taskRef(q)} from ${q.filedBy}: "${trim(q.brief, 140)}"`)
  }

  const queued = tasks
    .filter((t) => t.kind === 'work' && (t.status === 'ready' || t.status === 'blocked'))
    .slice(0, MAX_QUEUED_LINES)
  if (queued.length > 0) {
    lines.push(
      `Queued: ${queued
        .map((t) => `${taskRef(t)} "${trim(t.title, 40)}" (${t.owner ?? 'unassigned'})`)
        .join(' · ')}`,
    )
  }

  const recentlyDone = tasks
    .filter((t) => t.kind === 'work' && t.status === 'done')
    .slice(-3)
  if (recentlyDone.length > 0) {
    lines.push(`Recently done: ${recentlyDone.map((t) => `${taskRef(t)} ${trim(t.title, 40)}`).join(' · ')}`)
  }

  if (team.maxCostUsd !== null && team.maxCostUsd !== undefined) {
    lines.push(`Budget: $${run.costUsd.toFixed(2)} / $${team.maxCostUsd.toFixed(2)}`)
  }

  return lines.join('\n')
}

/**
 * Render the full board for the Conductor (check_status / wake
 * context). Richer than the member digest — the Conductor's read-model
 * IS board rows (summaries, never transcripts).
 */
export function renderBoardForConductor(
  team: Team,
  run: TeamRun,
  tasks: readonly TeamTask[],
  leases: readonly TeamLease[] = [],
): string {
  const lines: string[] = []
  const goal = tasks.find((t) => t.kind === 'goal')
  if (goal) {
    lines.push(`GOAL ${taskRef(goal)} "${goal.title}" (${goal.status})`)
    lines.push(`  done means: ${trim(goal.doneCriteria, 400)}`)
  } else {
    lines.push('GOAL: not yet written — crystallize first (board_write set_goal).')
  }
  const rest = tasks.filter((t) => t.kind !== 'goal')
  if (rest.length === 0) {
    lines.push('Board: no tasks filed yet.')
  }
  for (const t of rest) {
    const deps = t.dependsOn.length > 0
      ? ` deps:[${t.dependsOn
          .map((id) => {
            const dep = tasks.find((d) => d.id === id)
            return dep ? taskRef(dep) : id
          })
          .join(',')}]`
      : ''
    const owner = t.owner ?? 'unassigned'
    const result = t.result ? ` → "${trim(t.result, RESULT_TRIM)}"` : ''
    const blocked = t.blockedReason ? ` [blocked: ${trim(t.blockedReason, 100)}]` : ''
    lines.push(`${taskRef(t)} ${t.kind} "${trim(t.title, 80)}" — ${owner} — ${t.status}${deps}${result}${blocked}`)
  }
  if (leases.length > 0) {
    lines.push(
      `Held resources: ${leases.map((l) => `${l.resourceKey} (${l.agentId})`).join(' · ')}`,
    )
  }
  lines.push(`Run cost so far: $${run.costUsd.toFixed(2)}${team.maxCostUsd != null ? ` / $${team.maxCostUsd.toFixed(2)}` : ''}`)
  return lines.join('\n')
}
