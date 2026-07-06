/**
 * Custom Tool Loader
 *
 * Dynamically loads tools from TypeScript/JavaScript files in a profile directory.
 * Validates that each export conforms to the Loom Tool interface.
 *
 * @security Path validation. `relativePath` comes from `agent.json` which is
 * attacker-controllable when a profile is shared, forked, or AI-generated.
 * Without validation, a path like `"../../../tmp/x.js"` would resolve outside
 * the profile directory and `await import(...)` would execute arbitrary code
 * with the gateway's full privileges (master key, vault, all credentials).
 *
 * Two-phase check enforced by `validateCustomToolPath`:
 *   (1) syntactic — reject empty / absolute / `..`-bearing paths BEFORE
 *       resolve(), so malformed input fails fast with no filesystem access.
 *   (2) realpath — after symlink resolution, the absolute path must still
 *       sit inside `basePath`. This catches symlink escape (legitimate path
 *       inside basePath, but its target lives elsewhere).
 *
 * Error messages are deliberately vague about the resolved path to avoid
 * leaking absolute filesystem locations to whoever sees the error.
 */

import { isAbsolute, relative, resolve, sep } from 'path'
import { realpath, stat } from 'fs/promises'
import type { Tool } from '@ownware/loom'

/**
 * Validate a profile-supplied custom-tool path. Throws with a non-leaky
 * message on any traversal/escape attempt. Returns the resolved absolute
 * path (post-realpath) on success.
 */
async function validateCustomToolPath(
  relativePath: string,
  basePath: string,
): Promise<string> {
  // Phase 1 — syntactic checks. These fail before any filesystem access.
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('Custom tool path must be a non-empty string.')
  }
  if (isAbsolute(relativePath)) {
    throw new Error(
      'Custom tool path must be relative to the profile directory ' +
      '(absolute paths are rejected for security).',
    )
  }
  // Reject `..` segments. We check both forward- and back-slash separators
  // so Windows-style paths can't slip through on POSIX hosts.
  const segments = relativePath.split(/[/\\]/)
  if (segments.some(seg => seg === '..')) {
    throw new Error(
      'Custom tool path must stay inside the profile directory ' +
      '(parent traversal segments are rejected).',
    )
  }
  // Reject NUL bytes — the rest of Node accepts them in some places but
  // they routinely confuse downstream code (and are a classic bypass).
  if (relativePath.includes('\0')) {
    throw new Error('Custom tool path contains an invalid character.')
  }

  // Resolve in the caller's path namespace. We deliberately do NOT switch
  // to `realpath(basePath)` for the resolve here: the returned path is fed
  // straight into `await import(...)` and Node's ESM loader expects the
  // path to match the namespace it was reached through (on macOS, callers
  // pass `/var/folders/...` which differs from the realpath
  // `/private/var/folders/...` — using the realpath at the import call
  // site triggers ERR_MODULE_NOT_FOUND).
  const resolved = resolve(basePath, relativePath)

  // Phase 2 — symlink-aware containment. We do TWO checks:
  //   (a) raw lexical: relative(basePath, resolved). Phase 1 already
  //       rejected `..` segments, so this should always be in-tree, but
  //       it's a cheap belt-and-braces against odd platform behaviour.
  //   (b) realpath-based: when both paths exist, compare their realpaths.
  //       This is the symlink-escape detector — a path that lexically
  //       sits inside basePath but whose realpath lands outside.
  //
  // realpath is BEST-EFFORT for the resolved path: a writeFile-bound
  // tool that doesn't yet exist on disk will fail realpath with ENOENT.
  // That's fine — phase 1 already rejected `..` so the lexical path is
  // in-tree by construction; the downstream stat() call will surface
  // the friendly "not found" error.
  const lexicalRel = relative(basePath, resolved)
  if (lexicalRel.startsWith('..') || isAbsolute(lexicalRel) || lexicalRel.startsWith(`..${sep}`)) {
    throw new Error(
      'Custom tool path resolves outside the profile directory.',
    )
  }

  // Best-effort symlink-aware check. Only fires when both paths exist.
  try {
    const realBase = await realpath(basePath)
    const realResolved = await realpath(resolved)
    const rel = relative(realBase, realResolved)
    if (rel.startsWith('..') || isAbsolute(rel) || rel.startsWith(`..${sep}`)) {
      throw new Error(
        'Custom tool path resolves outside the profile directory ' +
        '(symlink escape is rejected for security).',
      )
    }
  } catch (err) {
    // ENOENT on the resolved-path realpath is expected for files that
    // don't exist yet — keep going and let stat() handle the error
    // message. ANY OTHER error from realpath is suspicious enough to
    // surface, including the symlink-escape Error we throw above.
    if (err instanceof Error && err.message.includes('outside the profile directory')) {
      throw err
    }
    if (!(isNodeError(err) && err.code === 'ENOENT')) {
      throw err
    }
  }

  return resolved
}

/**
 * Load custom tools from a file in the profile directory.
 *
 * @param relativePath - Path relative to the profile directory. MUST be a
 *                       relative path with no `..` segments. See the security
 *                       note on this module for the threat model.
 * @param functions - Specific function names to extract (all if omitted)
 * @param basePath - Absolute path to the profile directory (trusted)
 * @returns Array of validated Tool objects
 * @throws Error if the file doesn't exist, the path escapes the profile
 *               directory, or the file exports invalid tools
 */
export async function loadCustomTools(
  relativePath: string,
  functions: string[] | undefined,
  basePath: string,
): Promise<Tool[]> {
  const absolutePath = await validateCustomToolPath(relativePath, basePath)

  // Verify file exists
  try {
    const fileStat = await stat(absolutePath)
    if (!fileStat.isFile()) {
      throw new Error(
        `Custom tool path "${relativePath}" is not a file.`,
      )
    }
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      throw new Error(
        `Custom tool file "${relativePath}" not found. ` +
        `Check the "tools.custom" path in your agent.json.`,
      )
    }
    throw err
  }

  // Dynamic import
  let mod: Record<string, unknown>
  try {
    mod = await import(absolutePath) as Record<string, unknown>
  } catch (err) {
    throw new Error(
      `Failed to import custom tool file "${relativePath}": ` +
      `${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const tools: Tool[] = []

  if (functions && functions.length > 0) {
    // Extract only specified exports
    for (const fnName of functions) {
      const exported = mod[fnName]
      if (exported === undefined) {
        throw new Error(
          `Custom tool file "${relativePath}" does not export "${fnName}". ` +
          `Available exports: ${Object.keys(mod).join(', ')}.`,
        )
      }
      if (!isValidTool(exported)) {
        throw new Error(
          `Export "${fnName}" from "${relativePath}" is not a valid Tool. ` +
          `A Tool must have: name (string), description (string), inputSchema (object), execute (function).`,
        )
      }
      tools.push(exported)
    }
  } else {
    // Extract all exports that look like Tools
    for (const [key, value] of Object.entries(mod)) {
      if (key === 'default') continue  // skip default export unless it's a Tool
      if (isValidTool(value)) {
        tools.push(value)
      }
    }

    // Check default export too
    if (isValidTool(mod['default'])) {
      tools.push(mod['default'] as Tool)
    }

    if (tools.length === 0) {
      // Actionable error: enumerate what the file DID export so the user
      // can see at a glance whether this was a helper-file misconfig
      // (common case — e.g. `shared.ts` with retry/util helpers listed
      // in `tools.custom` by mistake) or a shape issue on a real tool.
      const allExports = Object.keys(mod).filter(k => k !== 'default')
      const hasDefault = mod['default'] !== undefined
      const exportList = allExports.length === 0 && !hasDefault
        ? '(none)'
        : [...allExports, ...(hasDefault ? ['default'] : [])].join(', ')

      throw new Error(
        `Custom tool file "${relativePath}" does not export any valid Tools.\n` +
        `  A Tool must have: name (string), description (string), ` +
        `inputSchema (object), execute (function).\n` +
        `  File exports: ${exportList}.\n` +
        `  Hint: if this file is a SHARED HELPER (utilities imported by ` +
        `other tool files), remove it from the "tools.custom" list in ` +
        `agent.json — helper files don't need to be listed; the real ` +
        `tool files will import them automatically via normal ESM.`,
      )
    }
  }

  return tools
}

/**
 * Type guard: checks if a value conforms to the Loom Tool interface.
 */
function isValidTool(value: unknown): value is Tool {
  if (typeof value !== 'object' || value === null) return false

  const obj = value as Record<string, unknown>
  return (
    typeof obj['name'] === 'string' &&
    typeof obj['description'] === 'string' &&
    typeof obj['inputSchema'] === 'object' &&
    obj['inputSchema'] !== null &&
    typeof obj['execute'] === 'function'
  )
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}
