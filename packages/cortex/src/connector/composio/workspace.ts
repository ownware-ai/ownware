/**
 * Composio workspace deep-link resolver.
 *
 * Problem
 * -------
 * The `app.composio.dev` and `platform.composio.dev/?next=auth-configs`
 * URLs both redirect authenticated users to
 * `platform.composio.dev/<org_slug>/<project_slug>` (workspace home) and
 * drop any deep-link hint, dumping users on a page with no guidance.
 * The only reliable deep-link is the fully-qualified workspace URL:
 *   `https://platform.composio.dev/<org_slug>/<project_slug>/auth-configs`
 *
 * The org + project slugs are per-account and can't be hardcoded.
 *
 * Resolution precedence
 * ---------------------
 *   1. Both `COMPOSIO_WORKSPACE_SLUG` + `COMPOSIO_PROJECT_SLUG` env vars
 *      set and non-empty → use them verbatim (skip API).
 *   2. Live call to `/api/v3/auth/session/info` via `ComposioClient`.
 *   3. On any failure → `null`. The frontend falls back to the generic
 *      `https://platform.composio.dev/` and users finish setup via the
 *      in-dialog instructions. No hard crash, one warn line.
 *
 * Called once at gateway boot when Composio is enabled. Result cached in
 * memory for process lifetime — slug renames require a Composio support
 * ticket in practice, so restart-to-refresh is acceptable.
 */

import type { ComposioClient } from './client.js'

const PLATFORM_HOST = 'https://platform.composio.dev'

export interface ResolveWorkspaceOpts {
  readonly client: ComposioClient
  readonly envWorkspaceSlug?: string | null | undefined
  readonly envProjectSlug?: string | null | undefined
  /** Test seam — override the warn logger. */
  readonly warn?: (msg: string) => void
}

export interface ComposioWorkspaceInfo {
  /** Fully-qualified dashboard base: `https://platform.composio.dev/<org>/<project>`. */
  readonly dashboardBaseUrl: string
}

const DEFAULT_WARN = (msg: string): void => { console.warn(msg) }

/**
 * Build `https://platform.composio.dev/<org>/<project>` with defensive
 * URL encoding. Slugs are typically `[a-z0-9_]+` but Composio's schema
 * doesn't formally restrict the character set, so we encode.
 */
function buildBaseUrl(orgSlug: string, projectSlug: string): string {
  return `${PLATFORM_HOST}/${encodeURIComponent(orgSlug)}/${encodeURIComponent(projectSlug)}`
}

function nonEmpty(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * Resolve the Composio dashboard base URL via precedence chain.
 * Returns `null` when no source yields a result — caller degrades to
 * the generic fallback URL.
 */
export async function resolveComposioWorkspace(
  opts: ResolveWorkspaceOpts,
): Promise<ComposioWorkspaceInfo | null> {
  const warn = opts.warn ?? DEFAULT_WARN

  // Step 1: explicit env override wins outright.
  if (nonEmpty(opts.envWorkspaceSlug) && nonEmpty(opts.envProjectSlug)) {
    return {
      dashboardBaseUrl: buildBaseUrl(
        opts.envWorkspaceSlug.trim(),
        opts.envProjectSlug.trim(),
      ),
    }
  }

  // Step 2: live API fetch.
  try {
    const info = await opts.client.getSessionInfo()
    const orgSlug = info.project.org.name
    const projectSlug = info.project.name
    if (!nonEmpty(orgSlug) || !nonEmpty(projectSlug)) {
      warn(
        '[ownware] composio: session info missing org/project slug; ' +
          'dashboard deep-link disabled',
      )
      return null
    }
    return { dashboardBaseUrl: buildBaseUrl(orgSlug, projectSlug) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warn(
      `[ownware] composio: could not resolve workspace for dashboard ` +
        `deep-link (${msg}); falling back to generic platform URL`,
    )
    return null
  }
}
