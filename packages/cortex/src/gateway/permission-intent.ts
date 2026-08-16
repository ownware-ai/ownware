import { createHash } from 'node:crypto'
import type { EgressMode, Tool } from '@ownware/loom'

export const PERMISSION_INTENT_REVISION = 1 as const
export const SCHEDULE_APPROVAL_INTENT_REVISION = 1 as const
export const SHA256_HEX = /^[0-9a-f]{64}$/
const MAX_CANONICAL_PERMISSION_DEPTH = 256

/**
 * Canonical JSON for authorization identities. Undefined, functions,
 * non-finite numbers and cyclic structures reject instead of being silently
 * normalized into a different action.
 */
export function canonicalPermissionJson(value: unknown): string {
  return canonicalPermissionJsonValue(value, new Set<object>(), 0)
}

function invalidPermissionIntent(): never {
  throw new Error('Permission intent is invalid')
}

function canonicalPermissionJsonValue(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
): string {
  if (depth > MAX_CANONICAL_PERMISSION_DEPTH) invalidPermissionIntent()
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidPermissionIntent()
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value) || Object.getOwnPropertySymbols(value).length > 0) {
      invalidPermissionIntent()
    }
    const ownNames = Object.getOwnPropertyNames(value)
    if (ownNames.length !== value.length + 1 || !ownNames.includes('length')) {
      invalidPermissionIntent()
    }
    ancestors.add(value)
    try {
      const items: string[] = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          invalidPermissionIntent()
        }
        items.push(canonicalPermissionJsonValue(descriptor.value, ancestors, depth + 1))
      }
      return `[${items.join(',')}]`
    } finally {
      ancestors.delete(value)
    }
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const prototype = Object.getPrototypeOf(record)
    if (
      (prototype !== Object.prototype && prototype !== null)
      || ancestors.has(record)
      || Object.getOwnPropertySymbols(record).length > 0
    ) {
      invalidPermissionIntent()
    }
    const keys = Object.getOwnPropertyNames(record).sort()
    ancestors.add(record)
    try {
      return `{${keys.map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(record, key)
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          invalidPermissionIntent()
        }
        return `${JSON.stringify(key)}:${canonicalPermissionJsonValue(
          descriptor.value,
          ancestors,
          depth + 1,
        )}`
      }).join(',')}}`
    } finally {
      ancestors.delete(record)
    }
  }
  return invalidPermissionIntent()
}

export function sha256PermissionRevision(value: unknown): string {
  return createHash('sha256').update(canonicalPermissionJson(value)).digest('hex')
}

/**
 * Structural tool revision. This proves the executable was assembled with the
 * same declared name/schema/permission surface; it does not prove arbitrary
 * implementation prose or remote authority state.
 */
export function permissionToolRevision(tool: Tool): string {
  const conditionalRevision = tool.conditionalEffect?.contractRevision ?? null
  const egressRevision = tool.egress?.contractRevision ?? null
  if (
    (conditionalRevision !== null
      && !/^[A-Za-z0-9_.:-]{1,200}$/.test(conditionalRevision))
    || (egressRevision !== null
      && !/^[A-Za-z0-9_.:-]{1,200}$/.test(egressRevision))
  ) {
    throw new Error('Tool contract revision is invalid')
  }
  return sha256PermissionRevision({
    revision: 'ownware.permission-tool.v1',
    name: tool.name,
    inputSchema: tool.inputSchema,
    isReadOnly: tool.isReadOnly ?? false,
    requiresPermission: tool.requiresPermission ?? false,
    category: tool.category ?? null,
    requires: tool.requires ?? [],
    conditionalEffectRevision: conditionalRevision,
    egressRevision,
    egressMediation: tool.egress?.mediation ?? null,
  })
}

export function permissionPolicyRevision(input: {
  readonly profileId: string
  readonly candidateId: string | null
  readonly workspaceId: string | null
  readonly workspacePath: string | null
  readonly safetyLevel: 'read-only' | 'draft-approval' | 'full-access' | null
  readonly permissionMode: string
  readonly egressMode: EgressMode
  readonly zoneConfig: unknown
  readonly tools: readonly Tool[]
}): string {
  return sha256PermissionRevision({
    revision: 'ownware.permission-policy.v1',
    profileId: input.profileId,
    candidateId: input.candidateId,
    workspaceId: input.workspaceId,
    workspacePath: input.workspacePath,
    safetyLevel: input.safetyLevel,
    permissionMode: input.permissionMode,
    egressMode: input.egressMode,
    zoneConfig: input.zoneConfig,
    tools: [...input.tools]
      .map((tool) => permissionToolRevision(tool))
      .sort(),
  })
}

export function validateTargetRevision(value: string | null): void {
  if (
    value !== null
    && (
      value.length < 1
      || value.length > 512
      || /[\u0000-\u001f\u007f]/.test(value)
    )
  ) {
    throw new Error('Target revision is invalid')
  }
}

export function scheduleApprovalIntentMaterial(input: {
  readonly approvalId: string
  readonly scheduleId: string
  readonly runId: string
  readonly threadId: string | null
  readonly toolName: string
  readonly toolInput: unknown
  readonly policyRevision: string
  readonly toolRevision: string
  readonly targetRevision: string | null
}): string {
  if (!SHA256_HEX.test(input.policyRevision) || !SHA256_HEX.test(input.toolRevision)) {
    throw new Error('Schedule approval revision is invalid')
  }
  validateTargetRevision(input.targetRevision)
  return canonicalPermissionJson({
    intentRevision: SCHEDULE_APPROVAL_INTENT_REVISION,
    approvalId: input.approvalId,
    scheduleId: input.scheduleId,
    runId: input.runId,
    threadId: input.threadId,
    policyRevision: input.policyRevision,
    toolRevision: input.toolRevision,
    targetRevision: input.targetRevision,
    toolName: input.toolName,
    input: input.toolInput,
  })
}

/** Equality identity only; it is never presented as proof that the action is safe. */
export function scheduleApprovalOperationHash(
  input: Parameters<typeof scheduleApprovalIntentMaterial>[0],
): string {
  return createHash('sha256').update(scheduleApprovalIntentMaterial(input)).digest('hex')
}

export function permissionIntentMaterial(input: {
  readonly runId: string
  readonly requestId: string
  readonly policyRevision: string
  readonly agentId: string | null
  readonly toolName: string
  readonly toolInput: Record<string, unknown>
}): string {
  if (!SHA256_HEX.test(input.policyRevision)) {
    throw new Error('Permission policy revision is invalid')
  }
  if (
    input.agentId !== null
    && !/^[A-Za-z0-9_.:-]{1,200}$/.test(input.agentId)
  ) {
    throw new Error('Permission agent identity is invalid')
  }
  return canonicalPermissionJson({
    intentRevision: PERMISSION_INTENT_REVISION,
    runId: input.runId,
    requestId: input.requestId,
    policyRevision: input.policyRevision,
    agentId: input.agentId,
    toolName: input.toolName,
    input: input.toolInput,
  })
}
