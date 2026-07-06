/**
 * SourcePreferences — persists the user's per-logical-key source choice.
 *
 * When the unified `/api/v1/connectors` view deduplicates multiple source
 * variants of the same logical app (e.g. `mcp:notion` + `composio:notion`),
 * the user can override the resolver's default. The choice is durable and
 * survives restarts — we keep it in the existing `user_settings` table
 * (migration 004) under the key `connector.alias.<logicalKey>.source`.
 *
 * This service is a narrow wrapper around that store. It validates the
 * logical key against the alias table so we never persist preferences for
 * unknown keys, and normalises the stored value to the trimmed string the
 * resolver compares on.
 */

import { isAliasLogicalKey } from './aliases.js'

/**
 * Narrow storage contract — the same duck-typing pattern used by
 * `WebSearchSettingsStore`. `GatewayState` already implements it.
 */
export interface SourcePreferencesStore {
  getSetting(key: string): { value: string } | undefined
  setSetting(key: string, value: string): unknown
  deleteSetting(key: string): boolean
}

/** Build the user_settings key for a given logical key. */
export function sourcePreferenceKey(logicalKey: string): string {
  return `connector.alias.${logicalKey}.source`
}

export class SourcePreferences {
  constructor(private readonly store: SourcePreferencesStore) {}

  /** Read the user's choice, or `null` if unset. */
  get(logicalKey: string): string | null {
    if (!isAliasLogicalKey(logicalKey)) return null
    const row = this.store.getSetting(sourcePreferenceKey(logicalKey))
    const v = row?.value
    return typeof v === 'string' && v.length > 0 ? v : null
  }

  /**
   * Persist the user's choice. Throws on unknown logical keys so we
   * never stash garbage in user_settings.
   */
  set(logicalKey: string, source: string): void {
    if (!isAliasLogicalKey(logicalKey)) {
      throw new Error(`Unknown alias logical key: '${logicalKey}'`)
    }
    const trimmed = source.trim()
    if (trimmed.length === 0) {
      throw new Error('source must be a non-empty string')
    }
    this.store.setSetting(sourcePreferenceKey(logicalKey), trimmed)
  }

  /**
   * Clear any persisted choice for this logical key. Returns true when
   * a row was deleted.
   */
  clear(logicalKey: string): boolean {
    if (!isAliasLogicalKey(logicalKey)) return false
    return this.store.deleteSetting(sourcePreferenceKey(logicalKey))
  }
}
