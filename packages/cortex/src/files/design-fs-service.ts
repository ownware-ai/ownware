/**
 * DesignFsService — per-design, refcounted filesystem watcher for
 * Ownware Design workspace folders.
 *
 * Sibling to `files-service.ts`, deliberately separate:
 *
 *   - `FilesService` calls `git status` on every settled burst and
 *     fans out a full snapshot. Right shape for the IDE files panel,
 *     wrong shape for the canvas, and requires the workspace to be a
 *     git repo. Design workspaces are not git repos today and the
 *     canvas doesn't need git semantics.
 *   - `DesignFsService` wraps chokidar directly and emits per-path
 *     `{ designId, path, kind }` events. No git. Reuses the IGNORE
 *     predicate from `file-watcher.ts` so `.git/`, `node_modules/`,
 *     `.ownware/` etc. stay pruned with the same single source of
 *     truth.
 *
 * Refcount semantics match `FilesService`:
 *   - Watcher spawns on the first `subscribe(designId, …)`.
 *   - Watcher tears down when the last subscriber for that design
 *     leaves.
 *   - `shutdown()` closes every live watcher; awaited from the
 *     gateway's stop path.
 *
 * Path normalization: chokidar emits absolute OS paths. We strip the
 * workspace root prefix and normalize to forward-slash posix so the
 * wire shape is platform-stable (Windows users see `assets/logo.svg`,
 * not `assets\logo.svg`).
 */

import chokidar from 'chokidar'
import { relative, sep } from 'node:path'
import { makeIgnorePredicate } from './file-watcher.js'
import type {
  DesignFsChangeKind,
  DesignFsEventBus,
} from './design-fs-event-bus.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Resolve a Ownware Design id to the workspace folder it points at. */
export interface DesignResolver {
  /** Return the absolute folder path for a design, or null when unknown. */
  getDesignPath(designId: string): string | null
}

/** Minimal chokidar surface — tests inject a fake. */
export interface DesignFsWatcherHandle {
  on(
    event: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir' | 'error',
    fn: (arg?: unknown) => void,
  ): this
  close(): Promise<void>
}

export type DesignFsWatcherFactory = (
  root: string,
  ignore: (path: string) => boolean,
) => DesignFsWatcherHandle

export interface DesignFsServiceOptions {
  readonly designs: DesignResolver
  readonly bus: DesignFsEventBus
  /** Debounce window in ms applied per (designId, relPath, kind) tuple. */
  readonly debounceMs?: number
  /** Extra directory-name segments to prune beyond the defaults. */
  readonly extraIgnores?: readonly string[]
  /** Testing seam — inject a fake chokidar-like factory. */
  readonly watcherFactory?: DesignFsWatcherFactory
  /** Testing seam — clock for the debounce timer. Defaults to wall-clock setTimeout. */
  readonly now?: () => string
}

export interface DesignFsService {
  /**
   * Cheap check — does this design id resolve to a workspace path?
   * Used by the SSE handler to send a structured 404 before paying
   * the cost of opening a watcher.
   */
  hasDesign(designId: string): boolean
  /**
   * Subscribe to fs events for one design. Watcher is spawned on
   * first call, torn down when the last subscriber leaves.
   *
   * Returns null when `designId` is unknown — caller can branch on
   * that to send a structured 404 without holding an SSE socket open.
   */
  subscribe(designId: string, onEvent?: () => void): null | (() => void)
  /** Close every live watcher. Safe to call multiple times. */
  shutdown(): Promise<void>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_DEBOUNCE_MS = 250

interface PendingEmit {
  readonly kind: DesignFsChangeKind
  timer: ReturnType<typeof setTimeout>
}

interface DesignState {
  readonly root: string
  handle: DesignFsWatcherHandle | null
  subscriberCount: number
  /**
   * Per-path debouncers. chokidar fires `add` → `change` for some
   * editor save sequences; the debouncer coalesces them into a single
   * event of the last-seen kind. `unlink` immediately drops any
   * pending add/change for that path (the file no longer exists).
   */
  pending: Map<string, PendingEmit>
}

export function createDesignFsService(
  opts: DesignFsServiceOptions,
): DesignFsService {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const ignore = makeIgnorePredicate(opts.extraIgnores ?? [])
  const watcherFactory: DesignFsWatcherFactory =
    opts.watcherFactory ??
    ((root, ig) =>
      chokidar.watch(root, {
        ignoreInitial: true,
        ignored: ig,
        awaitWriteFinish: {
          stabilityThreshold: 50,
          pollInterval: 25,
        },
        atomic: true,
      }) as unknown as DesignFsWatcherHandle)
  const now = opts.now ?? (() => new Date().toISOString())

  const states = new Map<string, DesignState>()

  function toRelPath(root: string, abs: string): string | null {
    const rel = relative(root, abs)
    if (rel.length === 0 || rel.startsWith('..')) return null
    return sep === '/' ? rel : rel.split(sep).join('/')
  }

  function scheduleEmit(
    designId: string,
    state: DesignState,
    relPath: string,
    kind: DesignFsChangeKind,
  ): void {
    const existing = state.pending.get(relPath)
    if (existing != null) {
      clearTimeout(existing.timer)
    }
    // For `unlink` the latest wins; for an `add`/`change` arriving
    // after an `unlink` we still take the latest (file came back).
    const timer = setTimeout(() => {
      state.pending.delete(relPath)
      try {
        opts.bus.emit({
          type: 'design-fs.changed',
          designId,
          path: relPath,
          kind,
          at: now(),
        })
      } catch (err) {
        // Don't kill the service on a transient emit failure.
        // eslint-disable-next-line no-console
        console.warn(
          `[design-fs] emit failed for design=${designId} path=${relPath}:`,
          err,
        )
      }
    }, debounceMs)
    state.pending.set(relPath, { kind, timer })
  }

  function spawnWatcher(designId: string, state: DesignState): void {
    if (state.handle != null) return
    const handle = watcherFactory(state.root, ignore)
    state.handle = handle

    const onFsEvent = (kind: DesignFsChangeKind) => (rawPath: unknown) => {
      if (typeof rawPath !== 'string') return
      const rel = toRelPath(state.root, rawPath)
      if (rel == null) return
      scheduleEmit(designId, state, rel, kind)
    }

    handle.on('add', onFsEvent('add'))
    handle.on('change', onFsEvent('change'))
    handle.on('unlink', onFsEvent('unlink'))
    // addDir / unlinkDir intentionally NOT forwarded. The client's lobby
    // store keys on file paths; directory create/delete will manifest
    // through the files inside them.

    // CRITICAL — unhandled chokidar errors kill the gateway.
    handle.on('error', (err) => {
      const asErr = err instanceof Error ? err : new Error(String(err))
      const code = (asErr as NodeJS.ErrnoException).code ?? 'UNKNOWN'
      // eslint-disable-next-line no-console
      console.warn(
        `[design-fs] watcher error (${code}) on design=${designId} root=${state.root}: ${asErr.message}. ` +
          `Live updates may be degraded; raw + write endpoints still work.`,
      )
      if (code === 'EMFILE' || code === 'ENFILE') {
        void handle.close().catch(() => {
          // Cleanup paths during fd exhaustion are best-effort by
          // design — there's no caller waiting on this promise and
          // a second throw would mask the original EMFILE in logs.
        })
      }
    })
  }

  function tearDownWatcher(state: DesignState): void {
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer)
    }
    state.pending.clear()
    const handle = state.handle
    state.handle = null
    if (handle != null) {
      void handle.close().catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[design-fs] watcher close threw:', err)
      })
    }
  }

  function subscribe(
    designId: string,
    onEvent?: () => void,
  ): null | (() => void) {
    const root = opts.designs.getDesignPath(designId)
    if (root == null) return null

    let state = states.get(designId)
    if (state == null) {
      state = {
        root,
        handle: null,
        subscriberCount: 0,
        pending: new Map(),
      }
      states.set(designId, state)
    }

    state.subscriberCount += 1
    spawnWatcher(designId, state)

    let unsubBus: (() => void) | null = null
    if (onEvent != null) {
      unsubBus = opts.bus.subscribe((ev) => {
        if (ev.designId !== designId) return
        onEvent()
      })
    }

    let gone = false
    return () => {
      if (gone) return
      gone = true
      if (unsubBus != null) unsubBus()
      const s = states.get(designId)
      if (s == null) return
      s.subscriberCount -= 1
      if (s.subscriberCount <= 0) {
        tearDownWatcher(s)
        states.delete(designId)
      }
    }
  }

  function hasDesign(designId: string): boolean {
    return opts.designs.getDesignPath(designId) != null
  }

  async function shutdown(): Promise<void> {
    const victims = Array.from(states.values())
    states.clear()
    await Promise.all(
      victims.map(async (s) => {
        for (const pending of s.pending.values()) {
          clearTimeout(pending.timer)
        }
        s.pending.clear()
        if (s.handle != null) {
          await s.handle.close().catch(() => {
            // Shutdown swallows close errors by design — the process
            // is going away. Re-throwing would crash the gateway exit
            // path. The watcher is being abandoned either way.
          })
        }
      }),
    )
  }

  return { hasDesign, subscribe, shutdown }
}
