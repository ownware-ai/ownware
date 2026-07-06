/**
 * Built-in Shell Tool
 *
 * Executes shell commands via child_process.spawn.
 * Streams stdout/stderr as ToolProgress events.
 * Integrates security validation, input sanitization, and output redaction.
 *
 * @security Every command passes through:
 *   1. Input sanitizer (prompt injection detection)
 *   2. Shell validator (5-level command validation)
 *   3. Permission check (based on validation level)
 *   4. Output sanitizer (secret redaction)
 */

import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { defineTool } from '../types.js'
import type { Tool, ToolContext, ToolResult, ToolProgress } from '../types.js'
import { validateCommand } from './shell-security.js'
import { sanitizeOutput } from './output-sanitizer.js'
import { sanitizeInput } from './input-sanitizer.js'
import { BLOCKED_FILE_ERROR_MESSAGE } from '../../credentials/patterns.js'
import {
  buildSubprocessEnv,
  commandContainsInlineCredentialValue,
  commandTargetsEnvFile,
  redactShellOutput,
} from './shell-credential-guards.js'
import type { ShellRunner } from './shell-runner.js'
import type {
  ShellSessionClient,
  ShellSessionReadInput,
  ShellSessionSignal,
  ShellSessionSpawnInput,
} from './shell-session-client.js'

// ---------------------------------------------------------------------------
// Shell execute tool
// ---------------------------------------------------------------------------

export const execute: Tool = defineTool({
  name: 'shell_execute',
  description:
    'Execute shell commands — one-shot runs AND persistent sessions.\n' +
    '\n' +
    'DEFAULT MODE (`action` omitted or "run"): one-shot. Runs a\n' +
    "command synchronously and returns its output + exit code. Use\n" +
    'for: tests, installs, git, build, system info. Do NOT use for\n' +
    'file ops (readFile/writeFile/editFile) or searches (glob/grep).\n' +
    'Commands have a 120s timeout; override with `timeout`. Dangerous\n' +
    'commands require user approval.\n' +
    '\n' +
    'SESSION MODE (`action` = spawn/read/write/signal/list/kill):\n' +
    'for long-running processes that must persist across turns —\n' +
    'dev servers, test watchers, build processes, log tailing, REPLs.\n' +
    'Each session has a `session_id` the agent reuses across calls.\n' +
    '\n' +
    'SESSION DISCIPLINE (do not skip these):\n' +
    '1. Use `action: "spawn"` for long-running processes. Pass\n' +
    "   `notifyOnExit: true` on commands you expect to FINISH (builds,\n" +
    '   tests, migrations) so you get a structured exit event — do\n' +
    '   NOT poll with repeated `read` just to detect completion.\n' +
    '2. Do NOT set `timeoutSeconds` for sessions meant to keep\n' +
    '   running (dev servers, watch modes, REPLs). DO set it for\n' +
    '   commands that are expected to finish on their own (builds,\n' +
    '   unit tests, e2e suites, migrations).\n' +
    '3. `action: "read"` is cursor-paginated: pass `offset` from the\n' +
    "   last response's `offset + lines.length`. NEVER read the same\n" +
    '   offset twice — use the returned `hasMore` flag.\n' +
    '4. Prefer `pattern` over raw reads when you need specific info\n' +
    '   (e.g. `pattern: "error|warn"`). The server filters BEFORE\n' +
    '   pagination, so a 10-line match window saves context vs\n' +
    '   pulling 500 raw lines and scanning client-side.\n' +
    '5. `action: "list"` is cheap (no output bytes). Use it before\n' +
    "   `read` when you're unsure which session is the one to check.\n" +
    '6. `action: "signal"` with `SIGINT` is the preferred stop for a\n' +
    '   foreground command. `SIGTERM`/`SIGKILL` kill the shell itself.\n' +
    '7. Never `sleep` + `read` in a loop to wait for exit. Flag\n' +
    '   `notifyOnExit: true` and wait for the next turn.',
  category: 'shell',
  isReadOnly: false,
  requiresPermission: true,
  timeoutMs: 120_000,
  uiDescriptor: {
    kind: 'shell',
    summary: { verb: 'Ran', primaryField: 'command' },
    preview: { contentField: 'output', format: 'plain', truncateAtLines: 10 },
    openAction: { target: 'terminal-pane', pathField: 'sessionId' },
  },
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'run',
          'spawn',
          'read',
          'read-agent',
          'write',
          'signal',
          'list',
          'kill',
          'dump',
        ],
        description:
          'What to do. Omit (or "run") for the default one-shot path. ' +
          '"spawn" creates a persistent session. "read"/"write"/"signal"/"kill" ' +
          'address a session by `session_id`. "read-agent" paginates the ' +
          'workspace agent PTY (the pinned "Agent" tab) — use when you need ' +
          "to re-check what you ran earlier and the output isn't in your " +
          'current conversation context. "list" enumerates active sessions. ' +
          '"dump" writes the full session buffer to disk and returns a path + preview (use when the buffer is too big to inline).',
      },
      command: {
        type: 'string',
        description:
          'The shell command. Required for `run` and `spawn`. Ignored by other actions.',
      },
      session_id: {
        type: 'string',
        description:
          'Session id returned by a prior `spawn`. Required for `read`, `write`, `signal`, `kill`.',
      },
      timeout: {
        type: 'number',
        description:
          'One-shot timeout in milliseconds. Overrides the default tool timeout. Applies only to `run`.',
      },
      cwd: {
        type: 'string',
        description:
          'Working directory. Applies only to `run` (sessions use the workspace path).',
      },
      notifyOnExit: {
        type: 'boolean',
        description:
          '`spawn` only. When true, you receive a structured exit event on completion (lineCount + lastLine). Set for commands that are expected to finish; DO NOT poll the session in the meantime.',
      },
      timeoutSeconds: {
        type: 'number',
        description:
          '`spawn` only. Auto-kill the session after N seconds (positive integer). Use for builds / test suites / migrations. DO NOT set for dev servers / watch modes / REPLs.',
      },
      title: {
        type: 'string',
        description:
          '`spawn` only. Human-readable label for the session tab.',
      },
      offset: {
        type: 'number',
        description:
          '`read` only. 0-based line offset. When `pattern` is set, paginates MATCHES, not raw lines.',
      },
      limit: {
        type: 'number',
        description:
          '`read` only. Max lines returned per call. Hard-capped by the server. Default 500.',
      },
      pattern: {
        type: 'string',
        description:
          '`read` only. Regex to filter lines server-side. Pagination applies to the matches.',
      },
      ignoreCase: {
        type: 'boolean',
        description: '`read` only. Case-insensitive regex match.',
      },
      data: {
        type: 'string',
        description:
          '`write` only. Raw bytes to send to stdin. Include `\\n` to press Enter.',
      },
      signal: {
        type: 'string',
        enum: ['SIGINT', 'SIGTERM', 'SIGKILL'],
        description:
          '`signal` only. SIGINT is the common Ctrl+C-equivalent; SIGTERM/SIGKILL kill the shell.',
      },
    },
  },

  async *execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): AsyncGenerator<ToolProgress, ToolResult> {
    const action = typeof input.action === 'string' ? input.action : 'run'

    // Session actions route through the injected ShellSessionClient.
    // When the host didn't wire one up, fall through with a clear
    // error — never silently downgrade to `run`; the agent asked
    // for something specific.
    if (action !== 'run') {
      const sessionResult = await runSessionAction(action, input, context)
      if (sessionResult != null) {
        return sessionResult
      }
      // runSessionAction returned null means `run` semantics requested;
      // fall through to the one-shot path below.
    }

    const {
      command,
      timeout,
      cwd,
    } = input as {
      command: string
      timeout?: number
      cwd?: string
    }

    if (typeof command !== 'string' || command.length === 0) {
      return {
        content: '`command` is required for `action: "run"`.',
        isError: true,
        metadata: { exitCode: null },
      }
    }

    // ── Step 1: Input sanitization ──────────────────────────────
    const inputCheck = sanitizeInput('shell.execute', input)
    if (inputCheck.blocked) {
      return {
        content: `Blocked: ${inputCheck.reason}`,
        isError: true,
        metadata: { security: 'input_blocked', reason: inputCheck.reason },
      }
    }

    // ── Step 2: Command security validation ─────────────────────
    const validation = validateCommand(command)

    if (validation.level === 'blocked') {
      // LEVEL 1: Never execute, never ask. Hard block.
      return {
        content: `Command blocked (security): ${validation.reason}`,
        isError: true,
        metadata: {
          security: 'blocked',
          level: validation.level,
          reason: validation.reason,
          pattern: validation.pattern,
        },
      }
    }

    if (!validation.safe) {
      // LEVELS 2-5: Require explicit permission
      const approved = await context.requestPermission(
        `shell.execute [${validation.level}]`,
        `${validation.reason}\n\nCommand: ${command.length > 200 ? command.slice(0, 200) + '...' : command}`,
      )
      if (!approved) {
        return {
          content: `Command denied by user (${validation.level}): ${validation.reason}`,
          isError: true,
          metadata: {
            security: 'denied',
            level: validation.level,
            reason: validation.reason,
          },
        }
      }
    }

    // ── Step 2b: Credential-isolation pre-execution guards ──────
    //
    // Hard-block commands that (a) read .env/secret files directly, or
    // (b) inline a known credential value the agent must never have
    // quoted literally. Both paths skip spawn entirely — the child
    // process would produce secret-bearing output that our redactor
    // would have to scrub after the fact. Blocking upfront is simpler
    // and keeps the damage contained.
    if (commandTargetsEnvFile(command)) {
      return {
        content: BLOCKED_FILE_ERROR_MESSAGE,
        isError: true,
        metadata: {
          security: 'blocked',
          level: 'credential_isolation',
          reason: 'Command targets a .env or secret file',
        },
      }
    }

    const knownCredentialValues = context.listAllCredentialValues()
    const inlineHit = commandContainsInlineCredentialValue(command, knownCredentialValues)
    if (inlineHit !== null) {
      return {
        content:
          `Command blocked: a known credential value (${inlineHit.label}) was inlined. ` +
          `Credential values must not appear literally in shell commands. Reference ` +
          `credentials by their environment variable name instead (e.g. $VARIABLE_NAME).`,
        isError: true,
        metadata: {
          security: 'blocked',
          level: 'credential_isolation',
          reason: 'Inline credential value detected',
          credentialId: inlineHit.credentialId,
        },
      }
    }

    // ── Step 3: Validate cwd ──────────────────────────────────────
    const workingDir = cwd ?? context.cwd
    // Validate cwd is within workspace
    if (cwd) {
      const resolvedCwd = path.resolve(context.cwd, cwd)
      if (resolvedCwd !== context.workspacePath && !resolvedCwd.startsWith(context.workspacePath + path.sep)) {
        return { content: `Working directory "${cwd}" is outside the workspace.`, isError: true, metadata: { exitCode: null } }
      }
    }

    const timeoutMs = timeout ?? 120_000

    const stdout: string[] = []
    const stderr: string[] = []
    let exitCode: number | null = null

    yield { message: `$ ${command}` }

    // Check if already aborted before spawning
    if (context.signal.aborted) {
      return { content: 'Command was cancelled before execution.', isError: true, metadata: { exitCode: null } }
    }

    // Assemble the child env: parent process.env PLUS every vault-known
    // env credential. Deterministic — every spawn gets every credential,
    // regardless of whether the command references it. The model can't
    // "forget" a credential into a subprocess it already controls.
    const childEnv = buildSubprocessEnv(
      process.env,
      context.listEnvCredentials,
      context.resolveCredential,
    )

    // ── Optional: route through an injected ShellRunner ─────────
    //
    // When the session's config carries a `shellRunner`, the command
    // runs through it instead of a detached spawn. Typical binding:
    // Cortex wires a PTY-backed runner so the agent and the user share
    // the workspace's terminal. Security pipeline (already run above)
    // is unchanged — only the execute step differs, and output
    // redaction below applies equally to the runner's string.
    const injectedRunner = (context.config as Record<string, unknown>).shellRunner as
      | ShellRunner | undefined
    if (injectedRunner) {
      let runnerOutput: string
      let runnerExitCode: number | null
      let runnerTerminated: 'timeout' | 'aborted' | undefined
      try {
        // Narrow the env down to defined string values — `childEnv` is
        // a `ProcessEnv` with `string | undefined` but the ShellRunner
        // contract is `Record<string, string>`. Undefineds are dropped.
        const runnerEnv: Record<string, string> = {}
        for (const [k, v] of Object.entries(childEnv)) {
          if (typeof v === 'string') runnerEnv[k] = v
        }
        const result = await injectedRunner.run({
          command,
          cwd: workingDir,
          env: runnerEnv,
          timeoutMs,
          signal: context.signal,
        })
        runnerOutput = result.output
        runnerExitCode = result.exitCode
        runnerTerminated = result.terminated
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e)
        return {
          content: `Error: ${errorMsg}`,
          isError: true,
          metadata: { exitCode: null },
        }
      }

      // Same two-stage redaction as the detached-spawn branch below.
      let content = runnerOutput.length > 0 ? runnerOutput : '(no output)'
      const isError =
        runnerExitCode !== 0 || runnerTerminated != null
      if (runnerTerminated === 'timeout') {
        content += `\n\nCommand timed out after ${Math.round(timeoutMs / 1000)}s`
      } else if (runnerTerminated === 'aborted') {
        content += '\n\nCommand was cancelled.'
      } else if (isError) {
        content += `\n\nExit code: ${runnerExitCode}`
      }

      const valueRedaction = redactShellOutput(content, knownCredentialValues)
      const patternRedaction = sanitizeOutput(valueRedaction.redacted)

      return {
        content: patternRedaction.sanitized,
        isError,
        metadata: {
          exitCode: runnerExitCode,
          ...(runnerTerminated != null ? { terminated: runnerTerminated } : {}),
          security: {
            validation: validation.level,
            redactedCount:
              valueRedaction.redactedCount +
              valueRedaction.envLineRedactionCount +
              patternRedaction.redactedCount,
            redactedTypes: [
              ...valueRedaction.redactedLabels.map(l => `credential:${l}`),
              ...(valueRedaction.envLineRedactionCount > 0 ? ['sensitive_env_line'] : []),
              ...patternRedaction.redactedTypes,
            ],
          },
        },
      }
    }

    try {
      exitCode = await new Promise<number | null>((resolve, reject) => {
        const proc = spawn(command, {
          shell: true,
          cwd: workingDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: childEnv,
        })

        let killTimer: ReturnType<typeof setTimeout> | undefined
        const timer = setTimeout(() => {
          proc.kill('SIGTERM')
          killTimer = setTimeout(() => proc.kill('SIGKILL'), 5_000)
          reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s`))
        }, timeoutMs)

        const onAbort = () => {
          proc.kill('SIGTERM')
          clearTimeout(timer)
          if (killTimer) clearTimeout(killTimer)
          reject(new Error('Command was cancelled'))
        }
        context.signal.addEventListener('abort', onAbort, { once: true })

        proc.stdout.on('data', (data: Buffer) => { stdout.push(data.toString()) })
        proc.stderr.on('data', (data: Buffer) => { stderr.push(data.toString()) })

        proc.on('close', (code) => {
          clearTimeout(timer)
          if (killTimer) clearTimeout(killTimer)
          context.signal.removeEventListener('abort', onAbort)
          resolve(code)
        })

        proc.on('error', (error) => {
          clearTimeout(timer)
          if (killTimer) clearTimeout(killTimer)
          context.signal.removeEventListener('abort', onAbort)
          reject(error)
        })
      })
    } catch (e) {
      const combined = buildOutput(stdout, stderr)
      const errorMsg = e instanceof Error ? e.message : String(e)
      return {
        content: combined
          ? `${combined}\n\nError: ${errorMsg}`
          : `Error: ${errorMsg}`,
        isError: true,
        metadata: { exitCode: null },
      }
    }

    // ── Step 4: Sanitize output ─────────────────────────────────
    //
    // Two-stage scrub:
    //   (a) Value-based redaction — replace every known credential
    //       value (plain, base64, urlencoded) with a REDACTED marker,
    //       and collapse sensitive `KEY=value` env lines.
    //   (b) Pattern-based sanitizer — the pre-existing secret-pattern
    //       sweep for AWS keys / JWTs / private keys / etc. catches
    //       values the vault doesn't know about (e.g. third-party
    //       secrets leaked into a log line).
    //
    // Stage (a) runs first so credentialId-matched values are replaced
    // with their label before the generic sanitizer can overwrite them
    // with a less-informative `[REDACTED:JWT]`-style marker.
    const combined = buildOutput(stdout, stderr)
    const isError = exitCode !== 0

    let content = combined || '(no output)'
    if (isError) {
      content += `\n\nExit code: ${exitCode}`
    }

    const valueRedaction = redactShellOutput(content, knownCredentialValues)
    const patternRedaction = sanitizeOutput(valueRedaction.redacted)

    return {
      content: patternRedaction.sanitized,
      isError,
      metadata: {
        exitCode,
        security: {
          validation: validation.level,
          // Combined redaction count across both stages + env-line collapse.
          redactedCount:
            valueRedaction.redactedCount +
            valueRedaction.envLineRedactionCount +
            patternRedaction.redactedCount,
          // Distinct types seen across both stages. Credential labels are
          // added alongside the generic secret types so observability
          // shows "we redacted these three labeled credentials AND one
          // JWT-pattern match" in a single list.
          redactedTypes: [
            ...valueRedaction.redactedLabels.map(l => `credential:${l}`),
            ...(valueRedaction.envLineRedactionCount > 0 ? ['sensitive_env_line'] : []),
            ...patternRedaction.redactedTypes,
          ],
        },
      },
    }
  },
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildOutput(stdout: string[], stderr: string[]): string {
  const out = stdout.join('')
  const err = stderr.join('')
  if (out && err) return `${out}\n\nSTDERR:\n${err}`
  return out || err
}

// ---------------------------------------------------------------------------
// Session actions — spawn / read / write / signal / list / kill.
//
// Route the agent's request through the injected ShellSessionClient
// when present. Returns a ToolResult on handled actions, or null when
// the caller asked for `run` (handled by the main body).
//
// Input validation is deliberately strict: missing `session_id` on
// read/write/signal/kill returns an error rather than silently
// degrading. The agent needs crisp feedback to correct the next call.
// ---------------------------------------------------------------------------

async function runSessionAction(
  action: string,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult | null> {
  if (action === 'run') return null

  const client = (context.config as Record<string, unknown>).shellSessionClient as
    | ShellSessionClient
    | undefined

  if (client == null) {
    return {
      content:
        `Session action "${action}" requires a persistent-shell backend, ` +
        `but this environment has none wired up (no shellSessionClient). ` +
        `Use \`action: "run"\` for one-shot commands, or ask the host to ` +
        `enable persistent shells.`,
      isError: true,
      metadata: { sessionAction: action, reason: 'no_client' },
    }
  }

  try {
    switch (action) {
      case 'spawn':
        return await handleSpawn(input, client)
      case 'read':
        return await handleRead(input, client)
      case 'read-agent':
        return await handleReadAgent(input, client)
      case 'write':
        return await handleWrite(input, client)
      case 'signal':
        return await handleSignal(input, client)
      case 'list':
        return await handleList(client)
      case 'kill':
        return await handleKill(input, client)
      case 'dump':
        return await handleDump(input, client)
      default:
        return {
          content: `Unknown action "${action}". Valid: run, spawn, read, read-agent, write, signal, list, kill, dump.`,
          isError: true,
          metadata: { sessionAction: action, reason: 'unknown_action' },
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: `Session action "${action}" failed: ${msg}`,
      isError: true,
      metadata: { sessionAction: action, reason: 'backend_error' },
    }
  }
}

async function handleSpawn(
  input: Record<string, unknown>,
  client: ShellSessionClient,
): Promise<ToolResult> {
  const command = typeof input.command === 'string' ? input.command : ''
  if (command.length === 0) {
    return {
      content: '`command` is required for `action: "spawn"`.',
      isError: true,
      metadata: { sessionAction: 'spawn', reason: 'missing_command' },
    }
  }
  const spawnInput: ShellSessionSpawnInput = {
    command,
    ...(typeof input.notifyOnExit === 'boolean'
      ? { notifyOnExit: input.notifyOnExit }
      : {}),
    ...(typeof input.timeoutSeconds === 'number'
      ? { timeoutSeconds: input.timeoutSeconds }
      : {}),
    ...(typeof input.title === 'string' ? { title: input.title } : {}),
  }
  const { id, info } = await client.spawn(spawnInput)
  return {
    content:
      `Spawned session ${id} — ${info.status}. ` +
      (spawnInput.notifyOnExit
        ? `You will receive a \`terminal.exited\` event when it finishes; do not poll.`
        : `Use \`action: "read"\` with this \`session_id\` to check output.`),
    isError: false,
    metadata: { sessionAction: 'spawn', sessionId: id, info },
  }
}

async function handleRead(
  input: Record<string, unknown>,
  client: ShellSessionClient,
): Promise<ToolResult> {
  const id = typeof input.session_id === 'string' ? input.session_id : ''
  if (id.length === 0) {
    return {
      content: '`session_id` is required for `action: "read"`.',
      isError: true,
      metadata: { sessionAction: 'read', reason: 'missing_session_id' },
    }
  }
  const readInput: ShellSessionReadInput = {
    id,
    ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
    ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    ...(typeof input.pattern === 'string' ? { pattern: input.pattern } : {}),
    ...(typeof input.ignoreCase === 'boolean'
      ? { ignoreCase: input.ignoreCase }
      : {}),
  }
  const result = await client.read(readInput)
  // Render as `cat -n`-style numbered lines — matches how the agent
  // already reads files.
  const body =
    result.lines.length === 0
      ? result.filter != null
        ? `(no lines match \`${result.filter.pattern}\`)`
        : `(no output yet)`
      : result.lines
          .map((l) => `${String(l.lineNumber).padStart(5, ' ')}  ${l.text}`)
          .join('\n')
  const footer: string[] = []
  if (result.filter != null) {
    footer.push(
      `filter: /${result.filter.pattern}/${result.filter.ignoreCase ? 'i' : ''} — ${result.filter.matchCount} matches`,
    )
  }
  footer.push(
    `totalLines=${result.totalLines} offset=${result.offset} hasMore=${result.hasMore}`,
  )
  return {
    content: `${body}\n\n${footer.join(' • ')}`,
    isError: false,
    metadata: { sessionAction: 'read', sessionId: id, ...result },
  }
}

async function handleReadAgent(
  input: Record<string, unknown>,
  client: ShellSessionClient,
): Promise<ToolResult> {
  // Same query shape as `read`, minus `session_id` — the workspace
  // agent PTY is singular. Presenting the result the same way
  // (cat -n + footer) keeps the agent's rendering path identical
  // whether it's reading its own tab or a spawned session.
  const readInput = {
    ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
    ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    ...(typeof input.pattern === 'string' ? { pattern: input.pattern } : {}),
    ...(typeof input.ignoreCase === 'boolean'
      ? { ignoreCase: input.ignoreCase }
      : {}),
  }
  const result = await client.readAgent(readInput)
  const body =
    result.lines.length === 0
      ? result.filter != null
        ? `(no lines match \`${result.filter.pattern}\` in the agent terminal)`
        : `(agent terminal has no output yet)`
      : result.lines
          .map((l) => `${String(l.lineNumber).padStart(5, ' ')}  ${l.text}`)
          .join('\n')
  const footer: string[] = []
  if (result.filter != null) {
    footer.push(
      `filter: /${result.filter.pattern}/${result.filter.ignoreCase ? 'i' : ''} — ${result.filter.matchCount} matches`,
    )
  }
  footer.push(
    `totalLines=${result.totalLines} offset=${result.offset} hasMore=${result.hasMore}`,
  )
  return {
    content: `${body}\n\n${footer.join(' • ')}`,
    isError: false,
    metadata: { sessionAction: 'read-agent', ...result },
  }
}

async function handleWrite(
  input: Record<string, unknown>,
  client: ShellSessionClient,
): Promise<ToolResult> {
  const id = typeof input.session_id === 'string' ? input.session_id : ''
  const data = typeof input.data === 'string' ? input.data : null
  if (id.length === 0) {
    return {
      content: '`session_id` is required for `action: "write"`.',
      isError: true,
      metadata: { sessionAction: 'write', reason: 'missing_session_id' },
    }
  }
  if (data == null) {
    return {
      content: '`data` (string) is required for `action: "write"`.',
      isError: true,
      metadata: { sessionAction: 'write', reason: 'missing_data' },
    }
  }
  await client.write({ id, data })
  return {
    content: `Wrote ${data.length} bytes to session ${id}.`,
    isError: false,
    metadata: { sessionAction: 'write', sessionId: id, bytes: data.length },
  }
}

async function handleSignal(
  input: Record<string, unknown>,
  client: ShellSessionClient,
): Promise<ToolResult> {
  const id = typeof input.session_id === 'string' ? input.session_id : ''
  const signal =
    input.signal === 'SIGINT' ||
    input.signal === 'SIGTERM' ||
    input.signal === 'SIGKILL'
      ? (input.signal as ShellSessionSignal)
      : null
  if (id.length === 0) {
    return {
      content: '`session_id` is required for `action: "signal"`.',
      isError: true,
      metadata: { sessionAction: 'signal', reason: 'missing_session_id' },
    }
  }
  if (signal == null) {
    return {
      content: '`signal` must be one of: SIGINT, SIGTERM, SIGKILL.',
      isError: true,
      metadata: { sessionAction: 'signal', reason: 'invalid_signal' },
    }
  }
  await client.signal({ id, signal })
  return {
    content: `Sent ${signal} to session ${id}.`,
    isError: false,
    metadata: { sessionAction: 'signal', sessionId: id, signal },
  }
}

async function handleList(client: ShellSessionClient): Promise<ToolResult> {
  const infos = await client.list()
  if (infos.length === 0) {
    return {
      content: '(no active sessions)',
      isError: false,
      metadata: { sessionAction: 'list', count: 0 },
    }
  }
  const lines = infos.map(
    (i) =>
      `${i.id}  status=${i.status}${i.exitCode != null ? ` exit=${i.exitCode}` : ''}` +
      (i.parentAgent != null ? `  agent=${i.parentAgent}` : '') +
      `  pid=${i.pid}`,
  )
  return {
    content: lines.join('\n'),
    isError: false,
    metadata: { sessionAction: 'list', count: infos.length, infos },
  }
}

async function handleKill(
  input: Record<string, unknown>,
  client: ShellSessionClient,
): Promise<ToolResult> {
  const id = typeof input.session_id === 'string' ? input.session_id : ''
  if (id.length === 0) {
    return {
      content: '`session_id` is required for `action: "kill"`.',
      isError: true,
      metadata: { sessionAction: 'kill', reason: 'missing_session_id' },
    }
  }
  await client.kill(id)
  return {
    content: `Killed session ${id}.`,
    isError: false,
    metadata: { sessionAction: 'kill', sessionId: id },
  }
}

async function handleDump(
  input: Record<string, unknown>,
  client: ShellSessionClient,
): Promise<ToolResult> {
  const id = typeof input.session_id === 'string' ? input.session_id : ''
  if (id.length === 0) {
    return {
      content: '`session_id` is required for `action: "dump"`.',
      isError: true,
      metadata: { sessionAction: 'dump', reason: 'missing_session_id' },
    }
  }
  const result = await client.dump(id)
  // Return the path + preview in a form the agent can act on directly:
  // it can either quote the preview in its next turn, or read a
  // specific window via `action: "read"` + offset (file or live
  // buffer — both have the same line numbering).
  const previewBody =
    result.preview.length === 0
      ? '(buffer is empty)'
      : result.preview
          .map((l) => `${String(l.lineNumber).padStart(5, ' ')}  ${l.text}`)
          .join('\n')
  return {
    content:
      `Dumped ${result.lineCount} lines (${result.byteLength} bytes) to:\n` +
      `  ${result.path}\n\n` +
      `First ${result.preview.length} lines:\n${previewBody}`,
    isError: false,
    metadata: {
      sessionAction: 'dump',
      sessionId: id,
      path: result.path,
      byteLength: result.byteLength,
      lineCount: result.lineCount,
    },
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const shellTools: Tool[] = [execute]
