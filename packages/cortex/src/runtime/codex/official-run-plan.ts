import type {
  CodexPreparedProfileMapping,
  CodexScopedToolAuthority,
  CodexTurnUserInput,
} from './profile-mapping.js'
import type {
  CodexPreparedSandboxPlan,
  CodexSandboxPlan,
} from './run-isolation.js'

export type CodexOfficialRunPlanErrorCode =
  | 'profile_not_ready'
  | 'sandbox_not_ready'
  | 'tool_authority_stale'

export class CodexOfficialRunPlanError extends Error {
  public override readonly name = 'CodexOfficialRunPlanError'

  constructor(readonly code: CodexOfficialRunPlanErrorCode) {
    super(`Codex official run plan failed (${code}).`)
  }
}

export interface CodexOfficialRunPlan {
  readonly profileReportId: string
  readonly sandboxReportId: string
  readonly requestDigest: string
  readonly scopedToolNames: readonly string[]
  readonly threadStart: {
    readonly cwd: string
    readonly model: string
    readonly developerInstructions: string
    readonly sandbox: CodexSandboxPlan['threadStart']['sandbox']
    readonly approvalPolicy: CodexSandboxPlan['threadStart']['approvalPolicy']
  }
  readonly turnStart: {
    readonly input: readonly CodexTurnUserInput[]
    readonly sandboxPolicy: CodexSandboxPlan['turnStart']['sandboxPolicy']
  }
  readonly readScope: CodexSandboxPlan['readScope']
  readonly networkScope: CodexSandboxPlan['networkScope']
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length
    && left.every((value, index) => value === right[index])
  )
}

/**
 * Removes the no-write preview fence only after both independent
 * compatibility decisions are ready. Tool-bearing mappings also require
 * their live registration/discovery authority to remain active.
 */
export function composeCodexOfficialRunPlan(input: {
  readonly profile: CodexPreparedProfileMapping
  readonly sandbox: CodexPreparedSandboxPlan
  readonly scopedTools?: CodexScopedToolAuthority
}): CodexOfficialRunPlan {
  const mapping = input.profile.mapping
  if (
    input.profile.report.state !== 'ready'
    || mapping == null
    || mapping.reportId !== input.profile.report.id
  ) {
    throw new CodexOfficialRunPlanError('profile_not_ready')
  }
  const sandbox = input.sandbox.plan
  if (sandbox == null) {
    throw new CodexOfficialRunPlanError('sandbox_not_ready')
  }
  const mappedNames = [...mapping.scopedToolNames].sort()
  if (
    mappedNames.length > 0
    && (
      input.scopedTools == null
      || !input.scopedTools.isActive()
      || !sameStrings(
        mappedNames,
        [...input.scopedTools.toolNames].sort(),
      )
    )
  ) {
    throw new CodexOfficialRunPlanError('tool_authority_stale')
  }

  return {
    profileReportId: mapping.reportId,
    sandboxReportId: input.sandbox.report.id,
    requestDigest: mapping.requestDigest,
    scopedToolNames: mappedNames,
    threadStart: {
      cwd: mapping.threadStart.cwd,
      model: mapping.threadStart.model,
      developerInstructions: mapping.threadStart.developerInstructions,
      ...sandbox.threadStart,
    },
    turnStart: {
      input: mapping.turnStart.input,
      ...sandbox.turnStart,
    },
    readScope: sandbox.readScope,
    networkScope: sandbox.networkScope,
  }
}
