/**
 * FileWatcher — per-workspace chokidar instance with a coalescing
 * debounce.
 *
 * The watcher is deliberately dumb: its only job is to detect that
 * *something* in the workspace changed and fire a single callback
 * after the dust settles. The caller (FilesService) re-runs
 * `git status` on that fire; git is the source of truth for what
 * actually changed.
 *
 * Debounce is **coalescing**: any event within the window pushes
 * the timer out. The callback fires once per settled burst, not
 * once per event.
 *
 * Chokidar v4 note (load-bearing for large repos):
 *   - v4 removed glob-string support for `ignored`. We MUST pass a
 *     function; otherwise chokidar silently watches every file
 *     including `node_modules/`, exhausts the OS fd limit, and
 *     crashes with `EMFILE: too many open files, watch`.
 *   - The function is consulted during the initial crawl, so
 *     ignored directories are never even entered.
 *   - We also attach an `error` handler because an unhandled chokidar
 *     `error` event becomes an uncaught exception (gateway dies).
 */

import chokidar from 'chokidar'
import { basename, sep } from 'node:path'

const DEFAULT_DEBOUNCE_MS = 250

/**
 * Directory / file name segments that should NEVER be crawled or
 * watched. Matched by `basename` so nesting depth doesn't matter —
 * any path whose segment equals one of these is pruned.
 */
const IGNORED_SEGMENTS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.vite',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'target', // rust
  '.gradle',
  '.idea',
  '.vscode',
  '.DS_Store',
  'coverage',
  '.nyc_output',
  // Ownware Design generated thumbnail captures — internal artifacts written
  // by the offscreen capturer. Watching them would fire a change event on
  // every capture → a re-fetch → (pre-guard) a re-capture loop. They are not
  // design source, so never emit for them.
  '.thumbs',
  '.thumb.png',
])

/**
 * The `ignored` function chokidar v4 expects. Returns true when a
 * path should be pruned.
 *
 * We match on any segment in the path, not just the basename —
 * because chokidar asks about intermediate paths during its crawl
 * (e.g. `/root/packages/foo/node_modules/bar/index.js`). If any
 * segment is an ignored name, the whole subtree is pruned.
 *
 * Exported as a public helper so sibling watchers (e.g. the design-fs
 * watcher in `design-fs-service.ts`) can reuse the same prune set
 * without re-declaring `IGNORED_SEGMENTS`. Adding an entry here
 * automatically benefits every watcher that consults this predicate.
 */
export function makeIgnorePredicate(
  extraSegments: readonly string[],
): (path: string) => boolean {
  const all = new Set<string>(IGNORED_SEGMENTS)
  for (const s of extraSegments) all.add(s)
  return (path: string): boolean => {
    if (all.has(basename(path))) return true
    // Defensive: check each segment on posix + windows separators.
    if (path.indexOf(sep) >= 0) {
      for (const segment of path.split(sep)) {
        if (all.has(segment)) return true
      }
    }
    return false
  }
}

export interface FileWatcherOptions {
  /** Debounce window in ms. Default 250. */
  readonly debounceMs?: number
  /** Extra directory-name segments to prune beyond the defaults. */
  readonly extraIgnores?: readonly string[]
  /**
   * Testing seam — inject a fake chokidar-like factory. Returns an
   * object with `.on()` and `.close()`. The default uses real
   * chokidar.
   */
  readonly factory?: (
    root: string,
    ignore: (path: string) => boolean,
  ) => WatcherHandle
}

export interface FileWatcher {
  /** Stop watching + drop any pending debounced call. Idempotent. */
  stop(): Promise<void>
}

/** Minimal shape we actually consume from chokidar. Lets tests inject a fake. */
export interface WatcherHandle {
  on(
    event: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir' | 'error',
    fn: (arg?: unknown) => void,
  ): this
  close(): Promise<void>
}

export function createFileWatcher(
  root: string,
  onChange: () => void,
  opts: FileWatcherOptions = {},
): FileWatcher {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const ignore = makeIgnorePredicate(opts.extraIgnores ?? [])

  const factory =
    opts.factory ??
    ((r: string, ig: (p: string) => boolean) =>
      chokidar.watch(r, {
        ignoreInitial: true,
        ignored: ig,
        // Chokidar v4 picks the right backend per platform. On
        // macOS it's fsevents, one handle per directory — which is
        // why pruning node_modules / .git etc. (above) matters.
        awaitWriteFinish: {
          // Fire once a file has settled for 50ms — prevents
          // mid-write atomic-rename noise.
          stabilityThreshold: 50,
          pollInterval: 25,
        },
        // atomic: true combines a rename-tmp-then-mv into a single
        // change event, which matches what users expect from their
        // editor's save behavior.
        atomic: true,
      }) as unknown as WatcherHandle)

  const handle = factory(root, ignore)

  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const schedule = (): void => {
    if (stopped) return
    if (timer != null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (stopped) return
      try {
        onChange()
      } catch (err) {
        // Never let the callback's throw crash the watcher.
        // eslint-disable-next-line no-console
        console.warn('[files] watcher callback threw:', err)
      }
    }, debounceMs)
  }

  for (const ev of ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const) {
    handle.on(ev, schedule)
  }

  // CRITICAL: attach an `error` handler. Without this, chokidar's
  // EventEmitter will re-throw unhandled errors and kill the
  // gateway. EMFILE is the most common one — OS ran out of open
  // file descriptors. When we hit it, the watcher stops being
  // useful but the HTTP handlers (list/diff) still work, so
  // degradation is graceful.
  handle.on('error', (err) => {
    const asErr = err instanceof Error ? err : new Error(String(err))
    const code = (asErr as NodeJS.ErrnoException).code ?? 'UNKNOWN'
    // eslint-disable-next-line no-console
    console.warn(
      `[files] watcher error (${code}) on ${root}: ${asErr.message}. ` +
      `Live updates may be degraded; list/diff endpoints still work.`,
    )
    // If we've hit EMFILE, the file-descriptor table is in bad
    // shape. Close the watcher proactively so it doesn't keep
    // firing and bleeding fds into `git spawn` calls.
    if (code === 'EMFILE' || code === 'ENFILE') {
      void handle.close().catch(() => {})
    }
  })

  return {
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      if (timer != null) {
        clearTimeout(timer)
        timer = null
      }
      try {
        await handle.close()
      } catch (err) {
        // Never throw from stop — shutdown paths rely on it.
        // eslint-disable-next-line no-console
        console.warn('[files] watcher close threw:', err)
      }
    },
  }
}

// Exported for tests.
export const __testables = {
  IGNORED_SEGMENTS,
  DEFAULT_DEBOUNCE_MS,
  makeIgnorePredicate,
} as const
