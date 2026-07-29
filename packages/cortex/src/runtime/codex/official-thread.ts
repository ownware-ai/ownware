import { z } from 'zod'
import type { RuntimeConsequence } from '../port.js'

const SafeId = z.string().trim().min(1).max(256)
const AccountBinding = z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/)
const IsoTimestamp = z.string().datetime()

const Selection = z.object({
  runtime: z.literal('openai-codex'),
  access: z.object({
    route: z.literal('openai-chatgpt-managed'),
  }).strict(),
}).strict()

const TerminalTurn = z.object({
  id: SafeId,
  status: z.enum(['completed', 'interrupted', 'failed']),
  completedAt: IsoTimestamp,
  authority: z.enum(['turn/completed', 'thread/read']),
}).strict()

const ActiveTurn = z.object({
  id: SafeId,
  startedAt: IsoTimestamp,
  consequence: z.enum([
    'none_observed',
    'output_observed',
    'effect_possible',
    'effect_confirmed',
  ]),
}).strict()

const ReferenceInput = z.object({
  localThreadId: SafeId,
  remoteThreadId: SafeId,
  accountBinding: AccountBinding,
  model: SafeId,
  modelProvider: SafeId,
  profileReportId: SafeId,
  sandboxReportId: SafeId,
  boundAt: IsoTimestamp,
}).strict()

const Reference = ReferenceInput.extend({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  selection: Selection,
  activeTurn: ActiveTurn.nullable(),
  lastTerminalTurn: TerminalTurn.nullable(),
  recoveryState: z.enum(['ready', 'outcome_unknown']),
}).strict()

export type CodexThreadReference = z.infer<typeof Reference>
export type CodexThreadReferenceInput = z.infer<typeof ReferenceInput>
export type CodexTerminalTurnReference = z.infer<typeof TerminalTurn>
export type CodexActiveTurnReference = z.infer<typeof ActiveTurn>

export type CodexThreadReferenceErrorCode =
  | 'invalid_reference'
  | 'thread_changed'
  | 'account_changed'
  | 'model_changed'
  | 'plan_changed'
  | 'active_turn_unresolved'
  | 'outcome_unknown'
  | 'terminal_conflict'

export class CodexThreadReferenceError extends Error {
  public override readonly name = 'CodexThreadReferenceError'

  constructor(readonly code: CodexThreadReferenceErrorCode) {
    super(`Codex thread reference failed (${code}).`)
  }
}

export function createCodexThreadReference(
  input: CodexThreadReferenceInput,
): CodexThreadReference {
  const parsed = ReferenceInput.safeParse(input)
  if (!parsed.success) {
    throw new CodexThreadReferenceError('invalid_reference')
  }
  return {
    schemaVersion: 1,
    revision: 0,
    selection: {
      runtime: 'openai-codex',
      access: { route: 'openai-chatgpt-managed' },
    },
    ...parsed.data,
    activeTurn: null,
    lastTerminalTurn: null,
    recoveryState: 'ready',
  }
}

export function parseCodexThreadReference(
  input: unknown,
): CodexThreadReference {
  const parsed = Reference.safeParse(input)
  if (!parsed.success) {
    throw new CodexThreadReferenceError('invalid_reference')
  }
  return parsed.data
}

/**
 * Resume is intentionally stricter than thread/resume itself. A remote thread
 * may exist while the local account, model, or accepted profile envelope has
 * changed; those are explicit migration decisions, never silent overrides.
 */
export function assertCodexThreadResume(
  input: unknown,
  currentInput: CodexThreadReferenceInput,
): CodexThreadReference {
  const reference = parseCodexThreadReference(input)
  const current = ReferenceInput.safeParse(currentInput)
  if (!current.success) {
    throw new CodexThreadReferenceError('invalid_reference')
  }
  if (
    reference.localThreadId !== current.data.localThreadId
    || reference.remoteThreadId !== current.data.remoteThreadId
  ) {
    throw new CodexThreadReferenceError('thread_changed')
  }
  if (reference.accountBinding !== current.data.accountBinding) {
    throw new CodexThreadReferenceError('account_changed')
  }
  if (
    reference.model !== current.data.model
    || reference.modelProvider !== current.data.modelProvider
  ) {
    throw new CodexThreadReferenceError('model_changed')
  }
  if (
    reference.profileReportId !== current.data.profileReportId
    || reference.sandboxReportId !== current.data.sandboxReportId
  ) {
    throw new CodexThreadReferenceError('plan_changed')
  }
  if (reference.activeTurn != null) {
    throw new CodexThreadReferenceError('active_turn_unresolved')
  }
  if (reference.recoveryState === 'outcome_unknown') {
    throw new CodexThreadReferenceError('outcome_unknown')
  }
  return input as CodexThreadReference
}

const CONSEQUENCE_RANK: Readonly<Record<RuntimeConsequence, number>> = {
  none_observed: 0,
  output_observed: 1,
  effect_possible: 2,
  effect_confirmed: 3,
}

export function beginCodexThreadTurn(
  input: unknown,
  activeInput: {
    readonly id: string
    readonly startedAt: string
  },
): CodexThreadReference {
  const reference = parseCodexThreadReference(input)
  if (reference.recoveryState === 'outcome_unknown') {
    throw new CodexThreadReferenceError('outcome_unknown')
  }
  if (reference.activeTurn != null) {
    throw new CodexThreadReferenceError('active_turn_unresolved')
  }
  const active = ActiveTurn.safeParse({
    ...activeInput,
    consequence: 'none_observed',
  })
  if (!active.success) {
    throw new CodexThreadReferenceError('invalid_reference')
  }
  return {
    ...reference,
    revision: reference.revision + 1,
    activeTurn: active.data,
  }
}

export function observeCodexThreadConsequence(
  input: unknown,
  consequence: RuntimeConsequence,
): CodexThreadReference {
  const reference = parseCodexThreadReference(input)
  if (reference.activeTurn == null) {
    throw new CodexThreadReferenceError('active_turn_unresolved')
  }
  const current = reference.activeTurn.consequence
  if (CONSEQUENCE_RANK[consequence] <= CONSEQUENCE_RANK[current]) {
    return reference
  }
  return {
    ...reference,
    revision: reference.revision + 1,
    activeTurn: {
      ...reference.activeTurn,
      consequence,
    },
  }
}

export function completeCodexThreadTurn(
  input: unknown,
  terminalInput: CodexTerminalTurnReference,
  outcomeKnown: boolean,
): CodexThreadReference {
  const reference = parseCodexThreadReference(input)
  const terminal = TerminalTurn.safeParse(terminalInput)
  if (!terminal.success) {
    throw new CodexThreadReferenceError('invalid_reference')
  }
  if (
    reference.activeTurn == null
    || reference.activeTurn.id !== terminal.data.id
  ) {
    throw new CodexThreadReferenceError('terminal_conflict')
  }
  return {
    ...reference,
    revision: reference.revision + 1,
    activeTurn: null,
    lastTerminalTurn: terminal.data,
    recoveryState: outcomeKnown ? 'ready' : 'outcome_unknown',
  }
}

export function advanceCodexThreadReference(
  input: unknown,
  terminalInput: CodexTerminalTurnReference,
): CodexThreadReference {
  const reference = parseCodexThreadReference(input)
  const terminal = TerminalTurn.safeParse(terminalInput)
  if (!terminal.success) {
    throw new CodexThreadReferenceError('invalid_reference')
  }
  if (reference.lastTerminalTurn?.id === terminal.data.id) {
    if (
      reference.lastTerminalTurn.status !== terminal.data.status
      || reference.lastTerminalTurn.completedAt !== terminal.data.completedAt
      || reference.lastTerminalTurn.authority !== terminal.data.authority
    ) {
      throw new CodexThreadReferenceError('terminal_conflict')
    }
    return reference
  }
  return {
    ...reference,
    revision: reference.revision + 1,
    lastTerminalTurn: terminal.data,
  }
}
