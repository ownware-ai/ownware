/**
 * Browser Launcher — Loom's engine-level Chrome launcher.
 *
 * Responsibility: find a Chromium-family executable, spawn it with CDP
 * enabled and an isolated user-data directory, wait for CDP to answer,
 * and hand the caller a lifecycle handle. Callers (Cortex gateway, CLI
 * scripts, tests) own when to stop.
 *
 * This module does NOT register global shutdown hooks or process-exit
 * handlers. Wire shutdown explicitly in the consumer's lifecycle layer.
 */

export {
  findBrowserExecutable,
  resolveBrowserExecutableForPlatform,
  findChromeExecutableMac,
  findChromeExecutableLinux,
  findChromeExecutableWindows,
  readBrowserVersion,
  parseBrowserMajorVersion,
  extractExecutableFromExecLine,
  splitExecLine,
  expandWindowsEnvVars,
  extractWindowsExecutablePath,
} from './executables.js'
export type { BrowserExecutable, BrowserKind } from './executables.js'

export {
  launchChrome,
  buildLaunchArgs,
  isChromeReachable,
  findFreePort,
  assertPortFree,
  LaunchChromeOptionsSchema,
  createDeferredChromeLauncher,
} from './launcher.js'
export type {
  LaunchChromeOptions,
  RunningChrome,
  BuildLaunchArgsParams,
  DeferredChromeLauncher,
  CreateDeferredChromeLauncherOptions,
} from './launcher.js'
