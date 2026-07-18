import {
  AccessGrantStore,
  type AccessAutonomy,
  type AccessConsent,
  type AccessGrantRevision,
  validateAccessContext,
} from './access-grant-store.js'

export const ACCESS_GRANT_EVALUATOR_VERSION = 'access_grant.v1' as const

export interface AccessEvaluationContext {
  readonly workspaceId: string
  readonly profileId: string
  readonly subjectId: string
  readonly purpose: string
  readonly channel: string | null
  readonly resourceKind: string
  readonly resourceId: string
  readonly operation: string
  readonly fieldScope: AccessGrantRevision['fieldScope']
  readonly rowScope: AccessGrantRevision['rowScope']
  readonly consent: AccessConsent
  readonly autonomy: AccessAutonomy
  /** Existing session mode is evidence only; it never bypasses this evaluator. */
  readonly permissionMode: 'auto' | 'ask' | 'deny' | 'allowlist'
  readonly hardFloor:
    | { readonly decision: 'allow' }
    | { readonly decision: 'deny'; readonly ruleId: string }
}

export type AccessEvaluation =
  | {
      readonly decision: 'allow'
      readonly code: 'grant_matched'
      readonly evaluatorVersion: typeof ACCESS_GRANT_EVALUATOR_VERSION
      readonly grantId: string
      readonly grantRevision: number
      readonly expiresAt: number
    }
  | {
      readonly decision: 'deny'
      readonly code: 'hard_floor_denied' | 'no_matching_grant' |
        'context_invalid' | 'grant_state_invalid'
      readonly evaluatorVersion: typeof ACCESS_GRANT_EVALUATOR_VERSION
    }

const AUTONOMY_RANK: Readonly<Record<AccessAutonomy, number>> = {
  observe: 0,
  recommend: 1,
  draft: 2,
  act: 3,
}

export class AccessGrantEvaluator {
  constructor(private readonly grants: AccessGrantStore) {}

  evaluate(context: AccessEvaluationContext, now: number = Date.now()): AccessEvaluation {
    if (!Number.isSafeInteger(now) || now < 0 || !validHardFloor(context.hardFloor) ||
        !validateAccessContext(context)) {
      return deny('context_invalid')
    }
    if (context.hardFloor.decision === 'deny') {
      return deny('hard_floor_denied')
    }
    let candidates: readonly AccessGrantRevision[]
    try {
      candidates = this.grants.findLiveCandidates(context, now)
    } catch {
      return deny('grant_state_invalid')
    }
    const matched = candidates.find((grant) => matches(grant, context))
    if (!matched) return deny('no_matching_grant')
    return {
      decision: 'allow',
      code: 'grant_matched',
      evaluatorVersion: ACCESS_GRANT_EVALUATOR_VERSION,
      grantId: matched.grantId,
      grantRevision: matched.revision,
      expiresAt: matched.expiresAt,
    }
  }
}

function matches(grant: AccessGrantRevision, context: AccessEvaluationContext): boolean {
  if (!consentMatches(grant.consent, context.consent)) return false
  if (AUTONOMY_RANK[context.autonomy] > AUTONOMY_RANK[grant.autonomyCeiling]) return false
  if (!scopeContains(grant.fieldScope, context.fieldScope)) return false
  return scopeContains(grant.rowScope, context.rowScope)
}

function consentMatches(grant: AccessConsent, actual: AccessConsent): boolean {
  if (grant.state !== actual.state) return false
  return grant.state === 'not_required' ||
    (actual.state === 'recorded' && grant.evidenceId === actual.evidenceId)
}

function scopeContains(
  scope: AccessGrantRevision['fieldScope'],
  requested: AccessGrantRevision['fieldScope'],
): boolean {
  if (requested.mode === 'all') return scope.mode === 'all'
  if (scope.mode === 'all') return true
  const allowed = new Set(scope.ids)
  return requested.ids.every((id) => allowed.has(id))
}

function validHardFloor(value: AccessEvaluationContext['hardFloor']): boolean {
  return value !== null && typeof value === 'object' &&
    (value.decision === 'allow' ||
    (value.decision === 'deny' &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.ruleId)))
}

function deny(code: Extract<AccessEvaluation, { decision: 'deny' }>['code']):
Extract<AccessEvaluation, { decision: 'deny' }> {
  return { decision: 'deny', code, evaluatorVersion: ACCESS_GRANT_EVALUATOR_VERSION }
}
