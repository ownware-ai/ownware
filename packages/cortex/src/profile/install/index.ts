/**
 * Profile install — public entry surface.
 *
 * Phase 1 ships the install primitive only. Update / uninstall (Phase 2)
 * and the gateway HTTP wrapper (Phase 5) live in their own modules.
 */

export { installProfileFromGithub } from './install-from-github.js'
export { isGitAvailable } from './clone.js'
export { parseGithubUrl, toCloneUrl, displayName, namespacedDirPrefix } from './github-url.js'
export type { GithubUrl } from './github-url.js'
export { parseManifest, MarketplaceManifestSchema, MANIFEST_MAX_BYTES } from './manifest.js'
export type {
  MarketplaceManifest,
  ProfileEntry,
  ConnectorDecl,
  ConnectorAuth,
  CapabilityTag,
} from './manifest.js'
export { validateTree } from './validate-tree.js'
export type { ValidateTreeOptions, TreeStats } from './validate-tree.js'
export {
  buildPreflight,
  PREFLIGHT_FETCH_MAX_BYTES,
  PREFLIGHT_FETCH_TIMEOUT_MS,
} from './preflight.js'
export type {
  Preflight,
  PreflightConnector,
  PreflightFetcher,
  PreflightFetchRequest,
  PreflightFetchResponse,
  BuildPreflightOptions,
} from './preflight.js'
export { InstallError, isInstallError } from './errors.js'
export type { InstallErrorCode, InstallErrorDetail } from './errors.js'
export type {
  GithubAuth,
  InstallOptions,
  InstallResult,
  InstalledProfile,
} from './types.js'
