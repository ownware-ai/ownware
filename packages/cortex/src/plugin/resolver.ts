import type {
  PluginGrantRecord,
  PluginVersionRecord,
} from '../storage/plugin-repository.js'

export interface PluginResolutionContext {
  readonly workspaceId?: string
  readonly agentId: string
}

export type PluginResolution =
  | { readonly status: 'enabled'; readonly version: PluginVersionRecord }
  | { readonly status: 'disabled'; readonly reason: 'no_grant' | 'denied' | 'version_missing' }

function applies(grant: PluginGrantRecord, context: PluginResolutionContext): boolean {
  switch (grant.scopeKind) {
    case 'global': return true
    case 'workspace': return context.workspaceId !== undefined && grant.scopeId === context.workspaceId
    case 'agent': return grant.scopeId === context.agentId
  }
}

function specificity(grant: PluginGrantRecord): number {
  switch (grant.scopeKind) {
    case 'global': return 0
    case 'workspace': return 1
    case 'agent': return 2
  }
}

/**
 * Resolve one plugin deterministically.
 *
 * A deny at any applicable level wins. Otherwise the most-specific allow
 * selects the version (agent, then workspace, then global). This keeps a
 * central emergency stop while allowing intentional per-agent pinning.
 */
export function resolvePluginVersion(
  grants: readonly PluginGrantRecord[],
  versions: readonly PluginVersionRecord[],
  context: PluginResolutionContext,
): PluginResolution {
  const applicable = grants.filter(grant => applies(grant, context))
  if (applicable.some(grant => grant.decision === 'deny')) {
    return { status: 'disabled', reason: 'denied' }
  }
  const selected = applicable
    .filter(grant => grant.decision === 'allow')
    .sort((left, right) => specificity(right) - specificity(left))[0]
  if (selected === undefined || selected.version === null) {
    return { status: 'disabled', reason: 'no_grant' }
  }
  const version = versions.find(candidate => candidate.version === selected.version)
  return version === undefined
    ? { status: 'disabled', reason: 'version_missing' }
    : { status: 'enabled', version }
}
