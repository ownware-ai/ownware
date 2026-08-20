import { afterEach, describe, expect, it } from 'vitest'
import { createTestGateway, type TestGateway } from '../../framework/harness/index.js'

/**
 * V1 (board 14): the runner has no cron math. Before this fix a cron schedule
 * was accepted, stored as 'scheduled' with no next fire time, and silently
 * never ran — an accepted configuration doing nothing. The honest behaviour
 * is refusal with a reason, at create AND at update.
 */

const PROFILE = 'cron-rejection'

let gateway: TestGateway | undefined

afterEach(async () => {
  await gateway?.stop()
  gateway = undefined
})

const schedule = (cadenceKind: string, cadenceExpr: string) => ({
  profileId: PROFILE,
  name: 'nightly',
  prompt: 'summarize the day',
  cadenceKind,
  cadenceExpr,
  cadenceDisplay: 'test',
  timezone: 'UTC',
})

describe('cron cadence rejection', () => {
  it('refuses to create a cron schedule instead of arming nothing', async () => {
    gateway = await createTestGateway({ profiles: [{ name: PROFILE, tools: { preset: 'none' } }] })
    const response = await gateway.client.post(
      '/api/v1/schedules', schedule('cron', '0 9 * * 1-5'))
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: 'cadence_unsupported' })
  })

  it('refuses to switch an existing schedule to cron, which would disarm it', async () => {
    gateway = await createTestGateway({ profiles: [{ name: PROFILE, tools: { preset: 'none' } }] })
    const created = await gateway.client.post(
      '/api/v1/schedules', schedule('daily', '{"time":"09:00"}'))
    expect(created.status).toBe(201)
    const id = (created.body as { schedule: { id: string } }).schedule.id
    const updated = await gateway.client.patch(
      `/api/v1/schedules/${id}`, { cadenceKind: 'cron', cadenceExpr: '0 9 * * *' })
    expect(updated.status).toBe(400)
    expect(updated.body).toMatchObject({ error: 'cadence_unsupported' })
    // The original cadence survives untouched.
    const after = await gateway.client.get(`/api/v1/schedules/${id}`)
    expect((after.body as { schedule: { cadenceKind: string } }).schedule.cadenceKind).toBe('daily')
  })

  it('still creates and arms a daily schedule normally', async () => {
    gateway = await createTestGateway({ profiles: [{ name: PROFILE, tools: { preset: 'none' } }] })
    const created = await gateway.client.post(
      '/api/v1/schedules', schedule('daily', '{"time":"09:00"}'))
    expect(created.status).toBe(201)
    const body = created.body as { schedule: { nextRunAt: number | null; state: string } }
    // The server owns the cadence math; a supported schedule is armed at birth.
    expect(body.schedule.state).toBe('scheduled')
    expect(body.schedule.nextRunAt).not.toBeNull()
  })
})
