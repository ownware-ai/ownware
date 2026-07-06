/**
 * Public types shared across the install module.
 *
 * Kept in their own file so consumers (CLI, gateway handlers, tests) can
 * import only the type surface without pulling in the heavy modules.
 */

import type { OriginSidecar } from '../registry.js'
import type { MarketplaceManifest } from './manifest.js'

/**
 * GitHub authentication carried into the install pipeline. Both forms
 * use the same Bearer-token wire shape; we keep them distinct in the
 * type so future flows (OAuth refresh, scope checks) can branch on
 * provenance without an extra field.
 *
 * The token is only ever read once per call: once injected into a
 * single `git clone --config http.extraHeader=...` command, then
 * dropped. We never persist it. We never echo it back in any error
 * message (the clone wrapper scrubs stderr).
 */
export type GithubAuth =
  | { readonly kind: 'pat'; readonly token: string }
  | { readonly kind: 'oauth'; readonly token: string }

/** Caller-supplied install options. */
export interface InstallOptions {
  /** GitHub URL — `https://github.com/<owner>/<repo>(.git)?` */
  readonly url: string
  /** Optional explicit ref override (branch / tag / sha). Beats any ref
   *  embedded in the URL. */
  readonly ref?: string
  /** Cortex data dir (e.g. `~/.ownware`). Profile lands at
   *  `<dataDir>/profiles/<owner>__<repo>__<name>/`. */
  readonly dataDir: string
  /** Optional auth for private repos. */
  readonly auth?: GithubAuth
  /** Override clone timeout. Test hook. */
  readonly cloneTimeoutMs?: number
  /** Override max bytes. Test hook. */
  readonly maxBytes?: number
  /** Override max files. Test hook. */
  readonly maxFiles?: number
  /** Override the `git` binary. Test hook. */
  readonly gitBinary?: string
}

/**
 * Per-installed-profile summary. The `repoId` is shared across every
 * top-level profile placed by a single install call so uninstall can
 * act on the whole repo as one unit.
 */
export interface InstalledProfile {
  /** Display name (`<owner>/<repo>/<profile-name>` or `<owner>/<repo>` for
   *  a single-profile repo). */
  readonly displayName: string
  /** On-disk dir absolute path. */
  readonly dirPath: string
  /** The dir name on disk (last segment of dirPath). Useful for
   *  registry lookups. */
  readonly dirName: string
  /** The profile's `name` field as declared in its agent.json. */
  readonly profileName: string
}

/**
 * Successful install result. Returned to the gateway handler / CLI
 * caller so they can react (refresh registry, log, render).
 */
export interface InstallResult {
  /** `<owner>/<repo>` — the repo identity. Same value lands in every
   *  installed profile's sidecar `repoId`. */
  readonly repoId: string
  /** Resolved commit SHA at install time. */
  readonly commit: string
  /** Ref we cloned (branch / tag / sha that was passed or defaulted). */
  readonly ref: string
  /** One entry per top-level profile placed by this call. Helpers
   *  nested inside each profile's `helpers/` ride along but do not
   *  appear here — they are not addressable as standalone profiles. */
  readonly profiles: readonly InstalledProfile[]
  /** The manifest as parsed (caller may want it for UI rendering). */
  readonly manifest: MarketplaceManifest
  /**
   * The shared sidecar (with `kind: 'github'`) written into each
   * installed profile's dir. Returned for the caller's logging /
   * verification. Never re-written by the caller.
   */
  readonly sidecar: OriginSidecar
}
