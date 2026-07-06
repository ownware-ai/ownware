/**
 * Tool-result spill — make oversized-output truncation recoverable.
 *
 * When a tool result exceeds the in-context byte cap, the loop head/tail-
 * truncates it (preserving the failure tail) but the middle is otherwise
 * gone. This module persists the FULL pre-truncation output to a configured
 * directory and produces an honest marker citing the path, so the model can
 * read the omitted middle back via the readFile / grep tools — the RTK "tee"
 * pattern. Spilling is opt-in (`config.toolExecution.spillDir`); when unset
 * the loop keeps its prior in-context-only behaviour and emits no spill
 * marker (the head/tail truncation marker is already honest about the cut).
 *
 * Best-effort by contract: a spill write failure must NEVER break the turn —
 * it degrades to exactly the pre-feature behaviour (truncated in context, the
 * dropped bytes unrecoverable), and `spillMarker(null)` stays silent so we
 * never promise a file that isn't there.
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'

/**
 * Persist `content` under `spillDir` keyed by session + tool call. Returns the
 * absolute path on success, or `null` when spilling is disabled (no spillDir)
 * or the write fails. The filename is sanitised so an exotic session/call id
 * can't escape the directory or produce an invalid path.
 */
export async function spillToolResult(
  spillDir: string | undefined,
  sessionId: string,
  toolCallId: string,
  content: string,
): Promise<string | null> {
  if (!spillDir) return null
  try {
    await mkdir(spillDir, { recursive: true })
    const safeId = `${sessionId}-${toolCallId}`.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = join(spillDir, `${safeId}.txt`)
    await writeFile(path, content, 'utf8')
    return isAbsolute(path) ? path : join(process.cwd(), path)
  } catch {
    // Disk full / permission denied / read-only FS — degrade silently to
    // in-context-only truncation. The marker (null path) won't claim a file.
    return null
  }
}

/**
 * The marker appended to a truncated tool result. Emitted ONLY when the full
 * output was actually spilled — it cites the retrievable path. When `null`
 * (spill disabled or failed) it returns the empty string, so the model is
 * never told a file exists that doesn't (the head/tail truncation marker
 * already states honestly that bytes were cut).
 */
export function spillMarker(spillPath: string | null): string {
  if (!spillPath) return ''
  return (
    `\n\n[Full untruncated output saved to ${spillPath} — ` +
    `read it with the readFile tool (or grep / head / tail) if you need the omitted middle.]`
  )
}
