/**
 * FilesService — per-workspace composition of:
 *   - GitAdapter (the source of truth for status + diff)
 *   - FileWatcher (cheap trigger to re-ask git)
 *   - FilesEventBus (fan-out of status snapshots)
 *
 * Lazy construction: we don't spawn a chokidar watcher until the
 * first subscribe / list / diff call lands for a workspace.
 *
 * Shutdown: the service owns every live watcher; `shutdown()`
 * closes them all and is awaited from the gateway's stop path.
 */

import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { FilesEventBus, FileEntry, FilesUpdatedEvent } from './files-event-bus.js'
import { BlockedPathError, PathTraversalError, resolveInsideRoot } from './git-adapter.js'
import type { DiffSide, GitAdapter, LoadDiffResult } from './git-adapter.js'
import { createGitAdapter } from './git-adapter.js'
import {
  createFileWatcher,
  makeIgnorePredicate,
  type FileWatcher,
  type FileWatcherOptions,
} from './file-watcher.js'
import { isBlockedFilePath } from '@ownware/loom'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WorkspaceResolver {
  /** Return the filesystem path for a workspace, or null if unknown. */
  getWorkspacePath(workspaceId: string): string | null
}

export type ListResult =
  | { readonly ok: true; readonly items: readonly FileEntry[] }
  | { readonly ok: false; readonly reason: 'workspace_unknown' | 'not_git_repo' }

export type DiffResult =
  | { readonly ok: true; readonly value: LoadDiffResult }
  | {
      readonly ok: false
      readonly reason:
        | 'workspace_unknown'
        | 'not_git_repo'
        | 'path_traversal'
        | 'blocked_path'
        | 'not_found'
    }

/**
 * One entry in a directory listing for the file-tree explorer.
 * `path` is workspace-relative with forward slashes (e.g. `src/api/auth.ts`)
 * — the same shape `/panes/source` and the diff endpoint accept.
 */
export interface TreeEntry {
  readonly name: string
  readonly path: string
  readonly type: 'file' | 'dir'
}

export type TreeResult =
  | { readonly ok: true; readonly entries: readonly TreeEntry[] }
  | {
      readonly ok: false
      readonly reason:
        | 'workspace_unknown'
        | 'path_traversal'
        | 'not_found'
        | 'not_a_directory'
    }

export type OriginalResult =
  | { readonly ok: true; readonly content: string | null }
  | {
      readonly ok: false
      readonly reason:
        | 'workspace_unknown'
        | 'not_git_repo'
        | 'path_traversal'
        | 'blocked_path'
    }

export interface FilesService {
  list(wsId: string): Promise<ListResult>
  diff(wsId: string, relPath: string, side: DiffSide): Promise<DiffResult>
  /**
   * The file's content at HEAD (the "original" side of the diff editor). `null`
   * content = the path isn't in HEAD (new/untracked) — the diff renders as all
   * additions against an empty original.
   */
  original(wsId: string, relPath: string): Promise<OriginalResult>
  /**
   * List ONE directory's children (lazy tree expansion). `relPath` is
   * workspace-relative; `''` (or `.`) lists the workspace root. Unlike
   * `list`/`diff`, does NOT require a git repo — it walks the real
   * filesystem so the explorer shows the whole project, not just changes.
   * Noise dirs (`node_modules`, `.git`, `dist`, …) are pruned via the
   * shared watcher ignore set.
   */
  tree(wsId: string, relPath: string): Promise<TreeResult>
  /** Subscribe to `files.updated` events for a single workspace. */
  subscribe(wsId: string, listener: (ev: FilesUpdatedEvent) => void): () => void
  /** Close every live watcher. Safe to call multiple times. */
  shutdown(): Promise<void>
}

export interface FilesServiceOptions {
  readonly workspaces: WorkspaceResolver
  readonly bus: FilesEventBus
  /** Testing seams. */
  readonly adapter?: GitAdapter
  readonly watcherFactory?: (
    root: string,
    onChange: () => void,
    opts?: FileWatcherOptions,
  ) => FileWatcher
  /** Debounce window forwarded into the watcher. */
  readonly debounceMs?: number
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface WorkspaceState {
  readonly root: string
  watcher: FileWatcher | null
  busUnsub: null
  subscriberCount: number
  /** Last known status snapshot — used as the initial frame for new subscribers. */
  lastItems: readonly FileEntry[] | null
  /** Wall-clock ms of the last `listStatus` that populated `lastItems`. */
  lastItemsAt: number
  /** True once we've confirmed this is a git repo. */
  isRepo: boolean | null
}

/**
 * How fresh `lastItems` must be for us to skip the subscribe
 * warmup refresh. If the HTTP /files call populated the cache
 * less than this many ms ago, a subsequent SSE subscribe doesn't
 * trigger another `git status` — the data is already fresh.
 */
const SUBSCRIBE_WARMUP_FRESHNESS_MS = 500

export function createFilesService(opts: FilesServiceOptions): FilesService {
  const adapter = opts.adapter ?? createGitAdapter()
  const watcherFactory =
    opts.watcherFactory ??
    ((root, onChange, o) => createFileWatcher(root, onChange, o))

  const states = new Map<string, WorkspaceState>()

  // Shared noise-prune set (node_modules, .git, dist, …) — same one the
  // file watcher uses, so the tree and the watcher agree on what to hide.
  const isIgnored = makeIgnorePredicate([])

  function stateFor(wsId: string): WorkspaceState | null {
    const existing = states.get(wsId)
    if (existing != null) return existing
    const root = opts.workspaces.getWorkspacePath(wsId)
    if (root == null) return null
    const fresh: WorkspaceState = {
      root,
      watcher: null,
      busUnsub: null,
      subscriberCount: 0,
      lastItems: null,
      lastItemsAt: 0,
      isRepo: null,
    }
    states.set(wsId, fresh)
    return fresh
  }

  async function ensureRepoKnown(state: WorkspaceState): Promise<boolean> {
    if (state.isRepo != null) return state.isRepo
    state.isRepo = await adapter.isGitRepo(state.root)
    return state.isRepo
  }

  async function refreshAndEmit(wsId: string, state: WorkspaceState): Promise<void> {
    try {
      const items = await adapter.listStatus(state.root)
      state.lastItems = items
      state.lastItemsAt = Date.now()
      opts.bus.emit({
        type: 'files.updated',
        workspaceId: wsId,
        at: new Date().toISOString(),
        items,
      })
    } catch (err) {
      // Don't kill the service on a transient git failure — log and
      // let the next tick retry.
      // eslint-disable-next-line no-console
      console.warn(`[files] refresh failed for ${wsId}:`, err)
    }
  }

  function ensureWatcher(wsId: string, state: WorkspaceState): void {
    if (state.watcher != null) return
    state.watcher = watcherFactory(state.root, () => {
      void refreshAndEmit(wsId, state)
    }, opts.debounceMs != null ? { debounceMs: opts.debounceMs } : undefined)
  }

  async function list(wsId: string): Promise<ListResult> {
    const state = stateFor(wsId)
    if (state == null) return { ok: false, reason: 'workspace_unknown' }
    const isRepo = await ensureRepoKnown(state)
    if (!isRepo) return { ok: false, reason: 'not_git_repo' }
    // Warm snapshot on first hit so the SSE initial frame is meaningful.
    if (state.lastItems == null) {
      const items = await adapter.listStatus(state.root)
      state.lastItems = items
      state.lastItemsAt = Date.now()
    }
    return { ok: true, items: state.lastItems }
  }

  async function diff(
    wsId: string,
    relPath: string,
    side: DiffSide,
  ): Promise<DiffResult> {
    const state = stateFor(wsId)
    if (state == null) return { ok: false, reason: 'workspace_unknown' }
    const isRepo = await ensureRepoKnown(state)
    if (!isRepo) return { ok: false, reason: 'not_git_repo' }

    // Path safety BEFORE any I/O or shell-out. Two layers of
    // defense: the adapter also repeats these checks.
    let absTarget: string
    try {
      absTarget = resolveInsideRoot(state.root, relPath)
    } catch (err) {
      if (err instanceof PathTraversalError) {
        return { ok: false, reason: 'path_traversal' }
      }
      throw err
    }
    if (isBlockedFilePath(absTarget)) {
      return { ok: false, reason: 'blocked_path' }
    }

    try {
      const value = await adapter.loadDiff(state.root, relPath, side)
      return { ok: true, value }
    } catch (err) {
      if (err instanceof PathTraversalError) return { ok: false, reason: 'path_traversal' }
      if (err instanceof BlockedPathError) return { ok: false, reason: 'blocked_path' }
      if (err != null && (err as { kind?: unknown }).kind === 'not_found') {
        return { ok: false, reason: 'not_found' }
      }
      throw err
    }
  }

  async function original(wsId: string, relPath: string): Promise<OriginalResult> {
    const state = stateFor(wsId)
    if (state == null) return { ok: false, reason: 'workspace_unknown' }
    const isRepo = await ensureRepoKnown(state)
    if (!isRepo) return { ok: false, reason: 'not_git_repo' }

    let absTarget: string
    try {
      absTarget = resolveInsideRoot(state.root, relPath)
    } catch (err) {
      if (err instanceof PathTraversalError) return { ok: false, reason: 'path_traversal' }
      throw err
    }
    if (isBlockedFilePath(absTarget)) {
      return { ok: false, reason: 'blocked_path' }
    }

    try {
      const content = await adapter.showHead(state.root, relPath)
      return { ok: true, content }
    } catch (err) {
      if (err instanceof PathTraversalError) return { ok: false, reason: 'path_traversal' }
      if (err instanceof BlockedPathError) return { ok: false, reason: 'blocked_path' }
      throw err
    }
  }

  async function tree(wsId: string, relPath: string): Promise<TreeResult> {
    const state = stateFor(wsId)
    if (state == null) return { ok: false, reason: 'workspace_unknown' }

    const clean = relPath.trim()
    let absDir: string
    if (clean === '' || clean === '.') {
      absDir = state.root
    } else {
      try {
        absDir = resolveInsideRoot(state.root, clean)
      } catch (err) {
        if (err instanceof PathTraversalError) {
          return { ok: false, reason: 'path_traversal' }
        }
        throw err
      }
    }

    let dirents
    try {
      const st = await stat(absDir)
      if (!st.isDirectory()) return { ok: false, reason: 'not_a_directory' }
      dirents = await readdir(absDir, { withFileTypes: true })
    } catch {
      return { ok: false, reason: 'not_found' }
    }

    const entries: TreeEntry[] = []
    for (const d of dirents) {
      if (isIgnored(d.name)) continue
      const abs = join(absDir, d.name)
      const rel = relative(state.root, abs).split(sep).join('/')
      entries.push({ name: d.name, path: rel, type: d.isDirectory() ? 'dir' : 'file' })
    }
    // Directories first, then files; each group alphabetical (case-insensitive).
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return { ok: true, entries }
  }

  function subscribe(
    wsId: string,
    listener: (ev: FilesUpdatedEvent) => void,
  ): () => void {
    const state = stateFor(wsId)
    // If the workspace is unknown we still accept the subscribe so
    // the caller can unsubscribe without branching; we just never
    // emit anything. The handler layer rejects at HTTP time.
    if (state == null) {
      return () => {}
    }

    state.subscriberCount += 1
    // Lazy-start the watcher on the first subscribe. We only
    // trigger a fresh refreshAndEmit here if our cached snapshot
    // is stale — otherwise the handler just called `list()` and
    // we'd be running a redundant `git status` for no visible
    // change.
    void (async () => {
      const isRepo = await ensureRepoKnown(state)
      if (!isRepo) return // Handler already rejected; nothing to do.
      ensureWatcher(wsId, state)
      const age = Date.now() - state.lastItemsAt
      if (state.lastItems == null || age > SUBSCRIBE_WARMUP_FRESHNESS_MS) {
        await refreshAndEmit(wsId, state)
      }
      // When snapshot is fresh: the watcher will fire the next
      // refresh on the next actual file change. No waste.
    })()

    const unsub = opts.bus.subscribe((ev) => {
      if (ev.workspaceId !== wsId) return
      listener(ev)
    })

    let gone = false
    return () => {
      if (gone) return
      gone = true
      unsub()
      state.subscriberCount -= 1
      // When the last subscriber leaves, tear the watcher down.
      // List / diff endpoints still work — they spawn on-demand.
      if (state.subscriberCount <= 0 && state.watcher != null) {
        const w = state.watcher
        state.watcher = null
        void w.stop()
      }
    }
  }

  async function shutdown(): Promise<void> {
    const victims = Array.from(states.values())
    states.clear()
    await Promise.all(
      victims.map(async (s) => {
        if (s.watcher != null) {
          await s.watcher.stop()
        }
      }),
    )
  }

  return { list, diff, original, tree, subscribe, shutdown }
}
