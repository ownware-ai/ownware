/**
 * Modular description for the `shell_execute` builtin tool.
 *
 * The high-leverage example: shell is the most dangerous tool, has the
 * most failure modes, and has the most alternatives. decomposes its
 * Bash docs into 45+ separate files; we collapse the same surface into
 * one structured description with six sections.
 */

import type { ToolDescription } from '../../descriptions/types.js'

export const shellDescription: ToolDescription = {
  name: 'shell_execute',
  sections: {
    overview:
      'Execute a shell command and return its stdout/stderr. ' +
      'Use for system operations the dedicated tools don\'t cover: running tests, build commands, package installs, read-only git inspection, OS-level scripting. ' +
      'Working directory persists between commands within a session, but shell state (exported variables, sourced scripts) does not.',

    usage: [
      '- Quote any path containing spaces. Always.',
      '- Set a sensible `timeout` for commands that could hang (network calls, long builds). Default is reasonable for one-shot commands.',
      '- Avoid bash-only constructs when targeting non-bash environments. Stick to POSIX shell where portability matters.',
      '- Capture exit codes via the result, not via inline `echo $?`.',
      '- Maintain the current working directory by using absolute paths or `cd <path> && <cmd>` rather than persistent `cd` (state does not persist between commands).',
      '- Do NOT use newlines inside the command string — chain with `&&` (sequential, fail-fast), `||` (fallback), `;` (sequential, ignore failures), or `|` (pipeline) instead.',
    ].join('\n'),

    safety: [
      '- Destructive operations require explicit user confirmation: `rm -rf`, `git push --force`, `git reset --hard`, dropping database tables, killing system processes.',
      '- Never bypass safety hooks (`--no-verify`, `--no-gpg-sign`) to silence a failure — fix the underlying issue or surface it to the user.',
      '- Do not pipe sensitive output (env vars, credentials, generated tokens) to third-party services or pastebins.',
      '- Treat unfamiliar files, branches, or lockfiles as the user\'s in-progress work — investigate before deleting or overwriting.',
      '- Never run `rm -rf /`, `rm -rf ~`, `chmod -R 777 /`, or other commands whose target is "everything" — these are almost always typos and there is no benign use case.',
      '- For `git`: prefer creating new commits over amending; never push to `main`/`master` without explicit instruction; do not skip pre-commit hooks; stage specific files (`git add path/to/file`) rather than `git add .` or `git add -A`.',
    ].join('\n'),

    parallel:
      'NOT read-only. Shell commands run serially after any read-only tools in the same turn. ' +
      'Independent shell commands within one turn can be issued in parallel only if they\'re known to be side-effect-free (e.g. multiple `git status` calls); when in doubt, serialize.',

    alternatives: [
      '- Read a file → use the dedicated `readFile` (not `cat`, `head`, `tail`).',
      '- Edit a file → use `editFile` (not `sed`, `awk`, `>>` redirects).',
      '- Create a file → use `writeFile` (not `echo >`, `cat <<EOF`).',
      '- Find files by pattern → use `glob` (not `find`).',
      '- Search file contents → use `grep` (not the `grep` or `rg` shell command).',
      '- Reserve `shell_execute` for system commands and tooling: tests, builds, installs, git operations, environment inspection. Dedicated tools produce structured output the user can review; shell hides what you did inside a stdout blob.',
    ].join('\n'),

    examples: [
      '1. Run tests: `shell_execute({ command: "npm test" })`.',
      '2. Read git state: `shell_execute({ command: "git status && git log -5" })`.',
      '3. Install a package the user authorized: `shell_execute({ command: "npm install zod" })`.',
      '4. Long-running build with explicit timeout: `shell_execute({ command: "npm run build", timeout: 300000 })`.',
      '5. Quoted path: `shell_execute({ command: "ls -la \\"path with spaces/sub\\"" })`.',
    ].join('\n'),
  },
}
