/**
 * Pure unit tests for the scheduler's honest outcome classification
 * (`classifyOutcome`). No DB, no model — imports only the pure function
 * (runner.ts pulls in cadence.ts at runtime, which is pure), so this suite
 * runs under plain node without the better-sqlite3 native module (ENV-2).
 *
 * Anchors BUGS HON-1: a run that returns 'completed' but emitted an in-band
 * error message must be classified failed-to-run, never a false success.
 */
import { describe, it, expect } from 'vitest'
import { classifyOutcome } from '../../../src/schedules/runner.js'

describe('classifyOutcome — honest run verdicts', () => {
  it('completed with no error event → succeeded', () => {
    expect(classifyOutcome({ status: 'completed' }).runStatus).toBe('succeeded')
  })

  it('HON-1: completed WITH an in-band error event → failed-to-run (not a false success)', () => {
    const out = classifyOutcome({
      status: 'completed',
      errorEvent: 'Could not resolve authentication method',
    })
    expect(out.runStatus).toBe('failed-to-run')
    expect(out.errorMessage).toBe('Could not resolve authentication method')
  })

  it('an empty-string errorEvent does not trip the failure path (treated as none)', () => {
    expect(classifyOutcome({ status: 'completed', errorEvent: '' }).runStatus).toBe('succeeded')
  })

  it("status 'error' → failed-to-run, surfacing the error message", () => {
    expect(classifyOutcome({ status: 'error', error: 'boom' })).toEqual({
      runStatus: 'failed-to-run',
      errorMessage: 'boom',
    })
  })

  it("status 'aborted' (thread would collapse to completed) → failed-to-run", () => {
    const out = classifyOutcome({ status: 'aborted' })
    expect(out.runStatus).toBe('failed-to-run')
    expect(out.errorMessage).toMatch(/aborted|timed out/i)
  })

  it('an unknown/undefined verdict → failed-to-run, never a silent success', () => {
    expect(classifyOutcome(undefined).runStatus).toBe('failed-to-run')
    expect(classifyOutcome({ status: 'weird' }).runStatus).toBe('failed-to-run')
  })
})
