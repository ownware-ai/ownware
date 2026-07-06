/**
 * Persistent Permission Module
 *
 * Manages user permission preferences per profile.
 * Persisted to ~/.ownware/permissions/<profileId>.json.
 */

export { PermissionStore, permissionStore } from './store.js'
export type { SavedPermissionRule, ProfilePermissions } from './store.js'
