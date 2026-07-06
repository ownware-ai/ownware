/**
 * createWorkspaceAgentShellRunner — per-session adapter that matches
 * Loom's `ShellRunner` interface exactly. Mirrors `scoped-store.ts`
 * for tasks: Loom stays ignorant of workspace ids; Cortex wires the
 * right PTY at session assembly time.
 *
 * The runner binds to the workspace's stable **agent shell** — a user-kind PTY
 * (`getOrCreateAgentShell`) so the agent's commands appear in the terminal dock
 * as a normal interactive tab, identical to a human one (unified-terminal
 * decision). It is shared across the workspace's runs, never reaped per-thread.
 */

import { PtyShellRunner } from './shell-runner.js'
import type { TerminalSessionRegistry } from './session-registry.js'

// Shape-compatible with Loom's `ShellRunner`. Duplicated here to avoid
// pulling the Loom import graph into a runtime dependency — same
// pattern used for `LoomTaskStoreShape` in `scoped-store.ts`.
export interface LoomShellRunnerShape {
  run(input: {
    readonly command: string
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly timeoutMs: number
    readonly signal: AbortSignal
  }): Promise<{
    readonly output: string
    readonly exitCode: number | null
    readonly terminated?: 'timeout' | 'aborted' | undefined
  }>
}

export function createWorkspaceAgentShellRunner(
  registry: TerminalSessionRegistry,
  workspaceId: string,
): LoomShellRunnerShape {
  const inner = new PtyShellRunner({
    resolveSession: () => registry.getOrCreateAgentShell(workspaceId),
    // OSC-633 mode when the agent shell is integrated (zsh) — resolved per run
    // so a respawned shell's new nonce is picked up. Null → Stage-1 fallback.
    resolveIntegration: () => registry.getAgentShellIntegration(workspaceId),
  })
  return {
    async run(input) {
      // env is intentionally ignored — the PTY carries its own env
      // from spawn time. If a future feature needs to surface
      // new env vars mid-session, we can export them into the PTY
      // via a preamble write.
      return inner.run({
        command: input.command,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      })
    },
  }
}
