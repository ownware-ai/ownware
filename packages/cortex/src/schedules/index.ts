/**
 * Per-profile scheduling vertical ("Ownware Calendar").
 *
 * A schedule runs ONE profile on a cadence as a normal single-agent run
 * (NOT the team kernel). This module owns the durable store; the firing
 * engine (ScheduleRunner), the gateway API, and the calendar UI land in
 * later slices.
 */

export { SqliteScheduleStore } from './store.js'
export {
  SqliteApprovalStore,
  ApprovalStatusSchema,
  type ApprovalStatus,
  type ApprovalDto,
  type PendingApprovalDto,
  type CreateApprovalInput,
  type DecideApprovalInput,
} from './approvals.js'
export { applySafetyLevel, allowsMutatingTools, SafetyLevelSchema, DEFAULT_SAFETY_LEVEL, type SafetyLevel } from './safety.js'
export { shouldNotify } from './delivery.js'
export {
  applyRunSafety,
  envelopeSpawnerPool,
  holdTool,
  summarizeHeldCall,
  HELD_RESULT_MESSAGE,
  type HoldSink,
  type HeldCall,
} from './draft-hold.js'
export {
  ScheduleRunner,
  type ScheduleRunnerDeps,
  type StartProfileRunFn,
  type ScheduleDelivery,
  type ScheduleDeliverySink,
} from './runner.js'
export {
  computeNextRun,
  occurrencesInRange,
  nextOccurrences,
  graceMs,
  type CadenceContext,
} from './cadence.js'
export * from './types.js'
