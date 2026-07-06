/**
 * Tool Guards — declarative per-tool input policies.
 *
 * Where this sits in the stack
 * ----------------------------
 * Loom already gates which TOOLS exist (ToolPolicy in this directory) and
 * classifies tools into security ZONES. Neither of those decides whether
 * a particular INPUT to a particular tool is acceptable. That's what
 * guards are for.
 *
 * A ToolGuard is a predicate over (toolName, input, context) that
 * returns `allow` or `deny`. Guards are produced from declarative specs
 * (ToolPolicySpec) that profile configs can safely serialize as JSON.
 * Enforcement happens by WRAPPING the tool's own execute — the loop
 * is not modified, no new event type is introduced, and no hot path
 * is touched. A denied call returns a normal ToolResult whose
 * `isError` is true and whose `metadata.policy === 'deny'`.
 *
 * For shell_execute specifically, the shell-kind spec composes with
 * the existing five-level command validator in `shell-security.ts`.
 * Level 1 (irreversible), 4 (exfiltration), and 5 (sensitive PII) are
 * always enforced — a profile cannot opt out of them. Level 2
 * (dangerous) and Level 3 (injection) can be opened with explicit
 * flags. When `allowPrefixes` is non-empty it behaves as a REQUIRED
 * whitelist: any command that doesn't match one of the prefixes is
 * denied before the command ever reaches the tool body.
 */

import { validateCommand } from './builtins/shell-security.js'
import type { Tool, ToolContext, ToolProgress, ToolResult } from './types.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ToolGuardDecision =
  | { readonly type: 'allow' }
  | { readonly type: 'deny'; readonly reason: string; readonly ruleId?: string }

/**
 * A precompiled guard. `appliesTo` is a cheap name matcher; `evaluate`
 * receives the tool's input (already JSON-parsed by the loop) and the
 * tool context.
 */
export interface ToolGuard {
  /** Stable identifier used in audit metadata and logs. */
  readonly id: string
  /** Whether this guard applies to a given tool name. */
  readonly appliesTo: (toolName: string) => boolean
  /** Decide whether the call may proceed. Must be synchronous and pure. */
  readonly evaluate: (
    input: Readonly<Record<string, unknown>>,
    context: ToolContext,
  ) => ToolGuardDecision
}

/**
 * Declarative spec for a shell-kind policy. Compiled by
 * `compileToolPolicies` into a ToolGuard.
 *
 * Semantics (in order):
 *   1. If `denyPatterns` matches the command → deny.
 *   2. If `allowPrefixes` is non-empty and no prefix matches → deny.
 *   3. Run `validateCommand` with `allowDangerous` / `allowInjection`.
 *      Any unsafe result → deny (including always-on L1/L4/L5).
 *   4. Otherwise → allow.
 */
export interface ShellPolicySpec {
  readonly tool: string
  readonly kind: 'shell'
  /** Literal command prefixes. If provided, ALL commands must match one. */
  readonly allowPrefixes?: readonly string[]
  /** JavaScript RegExp sources compiled once; any match denies. */
  readonly denyPatterns?: readonly string[]
  /** Permit shell-security Level 2 (rm -rf, sudo, chmod 777, ...). */
  readonly allowDangerous?: boolean
  /** Permit shell-security Level 3 (command substitution, backticks). */
  readonly allowInjection?: boolean
}

/**
 * Discriminated union of supported policy kinds. New kinds (path,
 * host, etc.) will be added here and gain a compiler branch in
 * `compileToolPolicies`.
 */
export type ToolPolicySpec = ShellPolicySpec

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

/**
 * Compile declarative specs into runtime guards. Invalid input (bad
 * regex source, empty tool pattern) throws at compile time so a
 * malformed profile fails loudly on load rather than silently at
 * tool-call time.
 */
export function compileToolPolicies(
  specs: readonly ToolPolicySpec[],
): ToolGuard[] {
  return specs.map((spec, i) => compileOne(spec, i))
}

function compileOne(spec: ToolPolicySpec, index: number): ToolGuard {
  if (!spec.tool || spec.tool.length === 0) {
    throw new Error(`policies[${index}]: "tool" must be a non-empty pattern`)
  }
  switch (spec.kind) {
    case 'shell':
      return compileShell(spec, index)
    default: {
      // Exhaustive check — if a new kind is added, TS will force a branch.
      const _exhaustive: never = spec.kind
      throw new Error(
        `policies[${index}]: unsupported policy kind ${String(_exhaustive)}`,
      )
    }
  }
}

function compileShell(spec: ShellPolicySpec, index: number): ToolGuard {
  const allowPrefixes = spec.allowPrefixes ?? []
  const denyRegexes = (spec.denyPatterns ?? []).map((src, j) => {
    try {
      return new RegExp(src)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `policies[${index}].denyPatterns[${j}]: invalid regex "${src}": ${msg}`,
      )
    }
  })
  const appliesTo = compileNameMatcher(spec.tool)
  const id = `shell:${spec.tool}`

  return {
    id,
    appliesTo,
    evaluate(input) {
      const raw = input['command']
      const command = typeof raw === 'string' ? raw : ''
      if (command.trim().length === 0) {
        // Empty command — let the underlying tool handle it.
        return { type: 'allow' }
      }

      // 1. Explicit deny patterns — hard block.
      for (const re of denyRegexes) {
        if (re.test(command)) {
          return {
            type: 'deny',
            reason: `matched deny pattern /${re.source}/`,
            ruleId: `${id}:deny-pattern`,
          }
        }
      }

      // 2. Required allowlist — if any prefix is configured, command
      //    must start with one of them (whitespace-trimmed).
      if (allowPrefixes.length > 0) {
        const trimmed = command.trim()
        const matched = allowPrefixes.some((p) => trimmed.startsWith(p))
        if (!matched) {
          return {
            type: 'deny',
            reason: `command not in profile allowlist`,
            ruleId: `${id}:allowlist`,
          }
        }
      }

      // 3. Shell-security floors. `customAllowlist` is deliberately NOT
      //    passed — the allowlist short-circuit inside validateCommand
      //    would bypass L1/L4/L5 which must always hold.
      const result = validateCommand(command, {
        allowDangerous: spec.allowDangerous === true,
        allowInjection: spec.allowInjection === true,
      })
      if (!result.safe) {
        return {
          type: 'deny',
          reason: result.reason ?? `shell-security level ${result.level}`,
          ruleId: `${id}:${result.level}`,
        }
      }

      return { type: 'allow' }
    },
  }
}

// ---------------------------------------------------------------------------
// Tool-name matcher
// ---------------------------------------------------------------------------

/**
 * Compile a tool-name pattern into a fast matcher. Supports:
 *   - "*" — matches any tool name
 *   - "prefix*" / "*suffix" / "pre*suf" — glob with `*` wildcard
 *   - bare names — exact match
 *
 * Regex special characters other than `*` are escaped, so patterns
 * like `mcp__github__*` work without surprises.
 */
export function compileNameMatcher(
  pattern: string,
): (name: string) => boolean {
  if (pattern === '*') return () => true
  if (!pattern.includes('*')) {
    return (name) => name === pattern
  }
  const regexSource =
    '^' + pattern.split('*').map(escapeRegex).join('.*') + '$'
  const regex = new RegExp(regexSource)
  return (name) => regex.test(name)
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// Wrap tools with guards
// ---------------------------------------------------------------------------

/**
 * Return a new tool list where each tool whose name matches at least
 * one guard has its `execute` wrapped to run guards first. Tools not
 * targeted by any guard are returned unchanged (referential equality
 * preserved, which matters for downstream tests and caches).
 */
export function wrapToolsWithGuards(
  tools: readonly Tool[],
  guards: readonly ToolGuard[],
): Tool[] {
  if (guards.length === 0) return [...tools]
  return tools.map((tool) => {
    const matching = guards.filter((g) => g.appliesTo(tool.name))
    if (matching.length === 0) return tool
    return wrapOne(tool, matching)
  })
}

function wrapOne(tool: Tool, guards: readonly ToolGuard[]): Tool {
  const originalExecute = tool.execute.bind(tool)
  const toolName = tool.name

  // The wrapper always returns an AsyncGenerator<ToolProgress, ToolResult>,
  // which satisfies the Tool.execute union type. Tools that originally
  // returned a plain Promise still get their result surfaced correctly
  // because the loop handles both shapes.
  async function* guarded(
    input: Record<string, unknown>,
    context: ToolContext,
  ): AsyncGenerator<ToolProgress, ToolResult> {
    for (const guard of guards) {
      let decision: ToolGuardDecision
      try {
        decision = guard.evaluate(input, context)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        decision = {
          type: 'deny',
          reason: `guard '${guard.id}' threw: ${msg}`,
          ruleId: guard.id,
        }
      }
      if (decision.type === 'deny') {
        return {
          content: `Blocked by policy: ${decision.reason}`,
          isError: true,
          metadata: {
            policy: 'deny',
            reason: decision.reason,
            ruleId: decision.ruleId ?? guard.id,
            tool: toolName,
          },
        }
      }
    }

    const inner = originalExecute(input, context)
    if (isAsyncGenerator(inner)) {
      let next = await inner.next()
      while (!next.done) {
        yield next.value
        next = await inner.next()
      }
      return next.value
    }
    return await inner
  }

  return {
    ...tool,
    execute: guarded,
  }
}

function isAsyncGenerator(
  value: unknown,
): value is AsyncGenerator<ToolProgress, ToolResult> {
  return (
    value != null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in (value as object)
  )
}
