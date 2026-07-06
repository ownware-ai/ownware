/**
 * Public surface of the `files` subsystem.
 *
 * Consumers (gateway handlers, tests) import from `./index.js`
 * rather than reaching into internal modules.
 */

export {
  FilesEventBus,
  FileEntrySchema,
  FileStatusSchema,
  FilesUpdatedEventSchema,
  type FileEntry,
  type FileStatus,
  type FilesEvent,
  type FilesListener,
  type FilesUpdatedEvent,
  type Unsubscribe,
} from './files-event-bus.js'

export {
  createGitAdapter,
  resolveInsideRoot,
  BlockedPathError,
  GitSpawnError,
  PathNotFoundError,
  PathTraversalError,
  type DiffSide,
  type GitAdapter,
  type LoadDiffResult,
} from './git-adapter.js'

export {
  createFileWatcher,
  makeIgnorePredicate,
  type FileWatcher,
  type FileWatcherOptions,
  type WatcherHandle,
} from './file-watcher.js'

export {
  createFilesService,
  type DiffResult,
  type FilesService,
  type FilesServiceOptions,
  type ListResult,
  type OriginalResult,
  type TreeEntry,
  type TreeResult,
  type WorkspaceResolver,
} from './files-service.js'

export {
  DesignFsEventBus,
  DesignFsChangedEventSchema,
  DesignFsChangeKindSchema,
  type DesignFsChangedEvent,
  type DesignFsChangeKind,
  type DesignFsEvent,
  type DesignFsListener,
} from './design-fs-event-bus.js'

export {
  createDesignFsService,
  type DesignFsService,
  type DesignFsServiceOptions,
  type DesignResolver,
  type DesignFsWatcherFactory,
  type DesignFsWatcherHandle,
} from './design-fs-service.js'
