/**
 * Cortex-internal constants — single source of truth for product-level
 * names that the kernel needs a default for when no explicit value is
 * threaded in.
 *
 * In the desktop ship, the desktop client's electron main process
 * resolves the data dir from its own canonical constant and passes it
 * to the gateway via the `OWNWARE_DATA_DIR` env var (see
 * `gateway/server.ts`). The defaults here only kick in when cortex is
 * run standalone — tests, the CLI, or any non-electron host.
 *
 * The desktop client and cortex live in different layers; they keep
 * two independent constants on purpose (cortex must not import from
 * a UI client). After every product rename, both must move in lockstep.
 */

/**
 * Homedir data directory name. Holds `ownware.db`, credentials, profiles,
 * permissions, bridges, MCP registry cache, etc. Renamed 2026-05-23
 * from `.cortex` to `.ownware` for the pre-customer brand cut.
 */
export const DEFAULT_DATA_DIR_NAME = '.ownware' as const

/**
 * Project-local subdirectory for plan artifacts produced by the
 * `plan_draft` / `plan_submit` tools. Lives inside the user's project
 * repo (not inside the data dir).
 */
export const PROJECT_PLANS_SUBDIR = '.ownware/plans' as const

/**
 * Project-local subdirectory for session checkpoint files (when a
 * profile selects the `file` checkpoint store with no explicit `dir`).
 * Lives inside the user's project repo.
 */
export const PROJECT_CHECKPOINTS_SUBDIR = '.ownware/checkpoints' as const

/**
 * Project convention filename — agents read this from the user's
 * project root (and from `.ownware/OWNWARE.md`) to pick up
 * project-level rules. Sibling concept to `CLAUDE.md`.
 */
export const PROJECT_CONVENTION_FILE = 'OWNWARE.md' as const

/**
 * Sidecar file written into a profile directory when it's forked from
 * a bundled profile — records the origin slug + version for diffing.
 */
export const PROFILE_ORIGIN_SIDECAR_FILE = '.ownware-origin.json' as const
