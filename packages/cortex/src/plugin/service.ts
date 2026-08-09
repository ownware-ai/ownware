import type { SkillDefinition } from '@ownware/loom'
import type {
  PluginGrantRecord,
  PluginRepository,
  PluginVersionRecord,
} from '../storage/plugin-repository.js'
import {
  PluginPackageStore,
  type InstalledPluginPackage,
  type PluginPackageDisplay,
} from './package-store.js'
import { resolvePluginVersion, type PluginResolutionContext } from './resolver.js'
import { parsePluginManifest } from './manifest.js'

export interface ResolvedPluginSkills {
  readonly skills: readonly SkillDefinition[]
  readonly versions: readonly PluginVersionRecord[]
}

export interface TaskPackCatalogEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly availableVersions: readonly string[]
  /** Version whose tasks apply in the requested context; null when the pack is disabled. */
  readonly effectiveVersion: string | null
  /** UI-safe display metadata for the selected version, or the latest version when disabled. */
  readonly display: PluginPackageDisplay | null
  readonly tasks: readonly {
    readonly id: string
    readonly label: string
    readonly description: string
    readonly examples: readonly string[]
  }[]
  readonly scopes: readonly TaskPackScopeRecord[]
}

export interface TaskPackScopeRecord {
  readonly taskPackId: string
  readonly scopeKind: PluginGrantRecord['scopeKind']
  readonly scopeId: string | null
  readonly decision: PluginGrantRecord['decision']
  readonly version: string | null
  readonly revision: number
  readonly updatedAt: string
}

/** Single orchestration seam used by boot reconciliation, HTTP handlers and runs. */
export class PluginService {
  readonly packages: PluginPackageStore

  constructor(
    dataDir: string,
    private readonly repository: PluginRepository,
  ) {
    this.packages = new PluginPackageStore(dataDir, repository)
  }

  async initialize(builtinDirectories: readonly string[]): Promise<void> {
    await this.packages.initialize()
    for (const directory of builtinDirectories) {
      const installed = await this.packages.installFromDirectory(directory, 'builtin', 'builtin')
      await this.ensureGlobalDefault(installed)
    }
  }

  async resolveSkills(context: PluginResolutionContext): Promise<ResolvedPluginSkills> {
    const grants = await this.repository.listGrants()
    const pluginIds = [...new Set(grants.map(grant => grant.pluginId))].sort()
    const skills: SkillDefinition[] = []
    const versions: PluginVersionRecord[] = []
    const names = new Set<string>()
    for (const pluginId of pluginIds) {
      const pluginGrants = grants.filter(grant => grant.pluginId === pluginId)
      const installed = await this.repository.listVersions(pluginId)
      const resolution = resolvePluginVersion(pluginGrants, installed, context)
      if (resolution.status !== 'enabled') continue
      const loaded = await this.packages.loadSkills(resolution.version)
      for (const skill of loaded) {
        if (names.has(skill.name)) {
          throw new TypeError('Enabled plugin skills must have globally unique names.')
        }
        names.add(skill.name)
        skills.push(skill)
      }
      versions.push(resolution.version)
    }
    return { skills, versions }
  }

  async catalog(
    context: { readonly workspaceId?: string; readonly agentId?: string } = {},
  ): Promise<readonly TaskPackCatalogEntry[]> {
    const grants = await this.repository.listGrants()
    const pluginIds = [...new Set(grants.map(grant => grant.pluginId))].sort()
    const entries: TaskPackCatalogEntry[] = []
    for (const pluginId of pluginIds) {
      const versions = await this.repository.listVersions(pluginId)
      const latest = versions[0]
      if (latest === undefined) continue
      await Promise.all(versions.map(version => this.packages.verify(version)))
      const resolution = resolvePluginVersion(
        grants.filter(grant => grant.pluginId === pluginId),
        versions,
        { ...context, agentId: context.agentId ?? '' },
      )
      const effective = resolution.status === 'enabled' ? resolution.version : null
      const selected = effective ?? latest
      const manifest = parsePluginManifest(selected.manifest)
      entries.push({
        id: pluginId,
        name: manifest.name,
        description: manifest.description,
        availableVersions: versions.map(version => version.version),
        effectiveVersion: effective?.version ?? null,
        display: await this.packages.loadDisplay(selected),
        tasks: (effective === null ? [] : manifest.tasks).map(task => ({
          id: task.id,
          label: task.label,
          description: task.description,
          examples: task.examples,
        })),
        scopes: grants.filter(grant => grant.pluginId === pluginId).map(grant => ({
          taskPackId: grant.pluginId,
          scopeKind: grant.scopeKind,
          scopeId: grant.scopeId,
          decision: grant.decision,
          version: grant.version,
          revision: grant.revision,
          updatedAt: grant.updatedAt,
        })),
      })
    }
    return entries
  }

  async setGrant(
    grant: Omit<PluginGrantRecord, 'revision' | 'updatedAt'>,
    expectedRevision: number | null,
  ): Promise<PluginGrantRecord> {
    return this.repository.putGrant(grant, expectedRevision)
  }

  private async ensureGlobalDefault(installed: InstalledPluginPackage): Promise<void> {
    const key = {
      pluginId: installed.manifest.id,
      scopeKind: 'global' as const,
      scopeId: null,
    }
    const existing = await this.repository.getGrant(key)
    if (existing !== null) return
    await this.repository.putGrant({
      ...key,
      decision: 'allow',
      version: installed.manifest.version,
    }, null)
  }
}
