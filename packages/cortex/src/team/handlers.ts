/**
 * Team vertical — HTTP endpoints (mirrors the designs-handler shape).
 *
 *   GET    /api/v1/teams                     list (summaries + last run)
 *   POST   /api/v1/teams                     create
 *   GET    /api/v1/teams/:teamId             detail
 *   PATCH  /api/v1/teams/:teamId             update
 *   DELETE /api/v1/teams/:teamId             delete (cancels active runs)
 *   POST   /api/v1/teams/:teamId/runs        start a run → { runId, threadId, conductorProfileId, model }
 *   GET    /api/v1/teams/:teamId/runs        list runs (receipts)
 *   GET    /api/v1/threads/:threadId/team-board   board view for a team thread
 *   POST   /api/v1/team-runs/:runId/cancel   stop everything, honestly
 *
 * Board reads are plain row CRUD over HTTP — live updates ride the
 * existing SSE as `team.board.changed` invalidation hints (gateway
 * realtime contract: SSE never carries business payloads).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { sendJSON, sendError, readJSON } from '../gateway/router.js'
import { classifyError } from '../errors/classify.js'
import { CreateTeamSchema, UpdateTeamSchema, type BoardView, type Team, type TeamSummary } from './schema.js'
import type { TeamModule } from './module.js'

const CreateRunSchema = z
  .object({
    workspaceId: z.string().min(1).optional(),
  })
  .strict()

const CancelRunSchema = z
  .object({
    reason: z.string().min(1).max(1_000).optional(),
  })
  .strict()

export function createTeamHandlers(module: TeamModule) {
  const { store } = module

  function toSummary(team: Team): TeamSummary {
    const runs = store.listRunsForTeam(team.id)
    const last = runs[0] ?? null
    const missionSource = team.fragments.identity ?? team.charter
    const mission =
      missionSource
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? null
    return {
      id: team.id,
      name: team.name,
      displayName: team.displayName,
      conductorName: team.conductorName,
      surface: team.surface,
      mission,
      memberCount: team.members.length,
      members: team.members.map((m) => ({ slug: m.slug, profileId: m.profileId, role: m.role })),
      lastRun: last
        ? { runId: last.id, status: last.status, receipt: last.receipt, updatedAt: last.updatedAt }
        : null,
    }
  }

  async function listTeams(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    sendJSON(res, 200, store.listTeams().map(toSummary))
  }

  async function createTeam(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJSON(req)
    const parsed = CreateTeamSchema.safeParse(body)
    if (!parsed.success) {
      sendError(res, 400, `Invalid team: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
      return
    }
    if (store.getTeamByName(parsed.data.name) !== null) {
      sendError(res, 409, `A team named "${parsed.data.name}" already exists.`)
      return
    }
    try {
      const team = module.createTeam(parsed.data)
      sendJSON(res, 201, team)
    } catch (err) {
      const classified = classifyError(err)
      sendError(res, 400, classified.message, undefined, classified.category)
    }
  }

  async function getTeam(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const team = store.getTeam(params['teamId']!)
    if (!team) {
      sendError(res, 404, `Team "${params['teamId']}" not found`)
      return
    }
    sendJSON(res, 200, team)
  }

  async function updateTeam(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const body = await readJSON(req)
    const parsed = UpdateTeamSchema.safeParse(body)
    if (!parsed.success) {
      sendError(res, 400, `Invalid update: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
      return
    }
    try {
      const team = module.updateTeam(params['teamId']!, parsed.data)
      if (!team) {
        sendError(res, 404, `Team "${params['teamId']}" not found`)
        return
      }
      sendJSON(res, 200, team)
    } catch (err) {
      const classified = classifyError(err)
      sendError(res, 400, classified.message, undefined, classified.category)
    }
  }

  async function deleteTeam(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const deleted = module.deleteTeam(params['teamId']!)
    if (!deleted) {
      sendError(res, 404, `Team "${params['teamId']}" not found`)
      return
    }
    sendJSON(res, 200, { deleted: true })
  }

  async function createRun(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const body = await readJSON(req)
    const parsed = CreateRunSchema.safeParse(body ?? {})
    if (!parsed.success) {
      sendError(res, 400, `Invalid body: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
      return
    }
    try {
      const { run, conductorProfileId, model } = await module.createRun(
        params['teamId']!,
        parsed.data.workspaceId ?? null,
      )
      sendJSON(res, 201, {
        runId: run.id,
        threadId: run.threadId,
        conductorProfileId,
        model,
      })
    } catch (err) {
      const classified = classifyError(err)
      const status = classified.message.includes('not found') ? 404 : 500
      sendError(res, status, classified.message, undefined, classified.category)
    }
  }

  async function listRuns(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const team = store.getTeam(params['teamId']!)
    if (!team) {
      sendError(res, 404, `Team "${params['teamId']}" not found`)
      return
    }
    sendJSON(res, 200, store.listRunsForTeam(team.id))
  }

  async function getBoardForThread(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const run = store.getRunByThread(params['threadId']!)
    if (!run) {
      sendError(res, 404, `Thread "${params['threadId']}" has no team run`)
      return
    }
    const team = store.getTeam(run.teamId)
    if (!team) {
      sendError(res, 404, `Team "${run.teamId}" not found`)
      return
    }
    const view: BoardView = {
      run,
      teamId: team.id,
      teamName: team.displayName,
      tasks: store.listTasks(run.id),
    }
    sendJSON(res, 200, view)
  }

  async function cancelRun(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const body = await readJSON(req)
    const parsed = CancelRunSchema.safeParse(body ?? {})
    if (!parsed.success) {
      sendError(res, 400, `Invalid body: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
      return
    }
    const run = store.getRun(params['runId']!)
    if (!run) {
      sendError(res, 404, `Team run "${params['runId']}" not found`)
      return
    }
    if (run.status !== 'active') {
      sendError(res, 409, `Run is already ${run.status}`)
      return
    }
    module.scheduler.cancelRun(run.id, parsed.data.reason ?? 'Cancelled by the user.')
    sendJSON(res, 200, { cancelled: true })
  }

  return {
    listTeams,
    createTeam,
    getTeam,
    updateTeam,
    deleteTeam,
    createRun,
    listRuns,
    getBoardForThread,
    cancelRun,
  }
}
