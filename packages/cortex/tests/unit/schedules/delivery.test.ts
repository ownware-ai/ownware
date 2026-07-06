/**
 * Pure unit tests for the delivery decision (`shouldNotify`, Slice 8e). No DB,
 * no model — runs under plain node. The non-spammy contract: tell the user
 * when there's something worth telling; stay silent on quiet days unless asked.
 */
import { describe, it, expect } from 'vitest'
import { shouldNotify } from '../../../src/schedules/delivery.js'
import type { DeliveryMode, RunStatus } from '../../../src/schedules/types.js'

const N = (runStatus: RunStatus, deliveryMode: DeliveryMode, quietOnEmpty: boolean): boolean =>
  shouldNotify({ runStatus, deliveryMode, quietOnEmpty })

describe('shouldNotify', () => {
  it('silent → never notifies', () => {
    expect(N('needs-approval', 'silent', false)).toBe(false)
    expect(N('failed-to-run', 'silent', false)).toBe(false)
    expect(N('succeeded', 'silent', false)).toBe(false)
  })

  it('every-run → always notifies on a terminal run', () => {
    expect(N('ran-empty', 'every-run', true)).toBe(true)
    expect(N('skipped', 'every-run', true)).toBe(true)
    expect(N('succeeded', 'every-run', true)).toBe(true)
  })

  it('on-activity → notifies on anything actionable / with a result', () => {
    for (const s of ['needs-approval', 'failed-to-run', 'failed-to-deliver', 'succeeded'] as RunStatus[]) {
      expect(N(s, 'on-activity', true)).toBe(true)
    }
  })

  it('on-activity → stays quiet on an empty/skipped run when quietOnEmpty (no-spam)', () => {
    expect(N('ran-empty', 'on-activity', true)).toBe(false)
    expect(N('skipped', 'on-activity', true)).toBe(false)
  })

  it('on-activity → notifies on an empty run when quietOnEmpty is OFF', () => {
    expect(N('ran-empty', 'on-activity', false)).toBe(true)
  })

  it('a still-running run never notifies, even under every-run', () => {
    expect(N('running', 'every-run', false)).toBe(false)
    expect(N('running', 'on-activity', false)).toBe(false)
  })
})
