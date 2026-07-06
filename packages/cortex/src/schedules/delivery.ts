/**
 * Delivery decision (Slice 8e) — should a finished scheduled run notify the
 * user? Pure; the notification + badge layer (8f) consumes it. The honest,
 * non-spammy rule: tell the user when there's something worth telling
 * (drafted / needs approval / failed / produced a result), stay silent on a
 * nothing-to-report or skipped run unless they asked for every run.
 */
import type { DeliveryMode, RunStatus } from './types.js'

export function shouldNotify(p: {
  readonly runStatus: RunStatus
  readonly deliveryMode: DeliveryMode
  readonly quietOnEmpty: boolean
}): boolean {
  if (p.runStatus === 'running') return false // not terminal → nothing to deliver yet
  if (p.deliveryMode === 'silent') return false
  if (p.deliveryMode === 'every-run') return true
  // 'on-activity' — the default. Only when there's something worth telling.
  switch (p.runStatus) {
    case 'needs-approval':
    case 'failed-to-run':
    case 'failed-to-deliver':
    case 'succeeded':
      return true
    case 'ran-empty':
    case 'skipped':
      return !p.quietOnEmpty // quiet day → silent unless the user opted out
    default:
      return false
  }
}
