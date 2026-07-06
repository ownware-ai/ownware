/**
 * Modular description for the `grep` builtin tool.
 *
 * Content search powered by ripgrep. The right tool when you know
 * roughly what to find but not where.
 */

import type { ToolDescription } from '../../descriptions/types.js'

export const grepDescription: ToolDescription = {
  name: 'grep',
  sections: {
    overview:
      'Search file contents using ripgrep regex. Returns matching files, lines, or counts depending on `output_mode`.',

    usage: [
      '- Pattern syntax is ripgrep regex (PCRE-flavored). Common patterns: `function\\\\s+\\\\w+`, `import .* from \\\'react\\\'`, `TODO:`.',
      '- Filter the search scope with `glob` (e.g. `**/*.ts`) or `type` (e.g. `js`, `py`, `rust`) to avoid noise from build artifacts.',
      '- `output_mode` controls the result shape: `files_with_matches` (default — paths only) is fastest; `content` shows the matching lines; `count` shows match counts per file.',
      '- Pass `-n` (line numbers) when you need to read a hit later via `readFile`.',
      '- For multi-line patterns (e.g. `interface Foo \\{[\\s\\S]*?bar`), set `multiline: true`.',
      '- Literal braces in regex need escaping: `interface\\\\{\\\\}` to match `interface{}` in Go code.',
    ].join('\n'),

    parallel:
      'Read-only. Fan out across naming conventions in one turn — `userAuth`, `user_auth`, `UserAuth` — rather than serializing three turns.',

    alternatives: [
      '- For finding files by name pattern → use `glob`.',
      '- For exploring an unfamiliar codebase across many rounds → consider spawning the `explore` helper via `agent_spawn` rather than running 20 greps yourself.',
      '- Never use `shell_execute` with `grep` or `rg` — the dedicated tool is faster, properly permissioned, and produces a structured tool card.',
    ].join('\n'),

    examples: [
      '1. Where is a function defined: `grep({ pattern: "function handleAuth\\\\(", glob: "**/*.ts" })`.',
      '2. Find all callers: `grep({ pattern: "handleAuth\\\\(", output_mode: "content", "-n": true })`.',
      '3. Count TODOs by file: `grep({ pattern: "TODO:", output_mode: "count" })`.',
    ].join('\n'),
  },
}
