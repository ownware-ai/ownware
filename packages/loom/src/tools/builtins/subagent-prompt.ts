/**
 * Subagent system-prompt scaffolding — shared by the delegation tools
 * (`agent_spawn`, `orchestrate`).
 *
 * A spawned subagent's system prompt is assembled from:
 *   1. A "you are a subagent" preamble (or the profile's own SOUL).
 *   2. An env footer with cwd / date / platform so the child has the same
 *      situational grounding the parent had.
 *
 * One home for this so both delegation surfaces build identical, grounded
 * child prompts.
 */

/**
 * Fallback role preamble used when a subagent profile doesn't specify
 * its own system prompt. Tells the child it's a subagent, not the
 * user-facing agent, and shapes its final report.
 */
export function defaultSubagentPreamble(subagentType: string | undefined): string {
  const role = subagentType
    ? `You are the "${subagentType}" subagent.`
    : 'You are a subagent.'
  return `${role} You were spawned by another agent to handle a specific task and report back. The caller cannot see your intermediate steps; only your final response reaches them, and they will relay its essentials to the user.

Work the task to completion — don't gold-plate, but don't leave it half-done. When you're done, respond with a concise report: what you did, key findings, any open questions the caller needs to resolve. No preamble, no filler.

You cannot see the caller's conversation. Everything you need has been passed in this prompt; if critical context is missing, say so in your response instead of guessing.`
}

/**
 * Env footer appended to every subagent system prompt. Mirrors the
 * parent's context fragment so the child knows where it is, when it
 * is, and what environment it's operating in.
 */
export function subagentEnvFooter(cwd?: string): string {
  const date = new Date().toISOString().split('T')[0]
  // The parent's workspacePath threads through here. Without it the
  // sub-agent would inherit the host process's cwd — which for the
  // Cortex gateway is the repo the gateway was launched from, not the
  // user's selected workspace. Sub-agents that trust this footer would
  // then fabricate absolute paths into the wrong tree, which the
  // filesystem tool's boundary check would reject — visible to the
  // user as red error rows before each retry.
  const resolvedCwd = cwd ?? process.cwd()
  const platform = `${process.platform} (${process.arch})`
  const lines = [
    '# Environment',
    `- Date: ${date}`,
    `- Platform: ${platform}`,
    `- Working directory: ${resolvedCwd}`,
  ]
  return lines.join('\n')
}

/**
 * Assemble the final system prompt a subagent will see. Order matches
 * the parent's slot order: identity → context.
 */
export function assembleSubagentSystemPrompt(
  profileSystemPrompt: string | undefined,
  subagentType: string | undefined,
  cwd?: string,
): string {
  const identity = profileSystemPrompt?.trim()
    ? profileSystemPrompt.trim()
    : defaultSubagentPreamble(subagentType)
  return [identity, subagentEnvFooter(cwd)].join('\n\n')
}
