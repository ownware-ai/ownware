/**
 * Backend Module
 *
 * Filesystem abstraction layer with local, sandboxed, and zone-routed backends.
 */

export type {
  BackendProtocol,
  FileEntry,
  GrepResult,
  ExecResult,
  ReadFileOptions,
  ExecOptions,
  Zone,
  ZonePermission,
  BackendErrorCode,
} from './types.js'
export { BackendError } from './types.js'
export { LocalBackend } from './local.js'
export { ZoneRouter } from './zone-router.js'
export { SandboxBackend } from './sandbox.js'
export { WorkspaceManager } from './workspace.js'
