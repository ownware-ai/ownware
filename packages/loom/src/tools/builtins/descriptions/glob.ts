/**
 * Modular description for the `glob` builtin tool.
 *
 * Pattern-based file discovery. The fast path before reading anything.
 */

import type { ToolDescription } from '../../descriptions/types.js'

export const globDescription: ToolDescription = {
  name: 'glob',
  sections: {
    overview:
      'Find files by glob pattern (e.g. `**/*.ts`, `src/**/*.test.tsx`, `packages/*/package.json`). Returns absolute paths sorted by modification time, most-recently-modified first.',

    usage: [
      '- Use globstar `**` to recurse into subdirectories.',
      '- Filter by extension with `*.ts`, `*.{ts,tsx}`, etc.',
      '- Combine with relative-from-root paths: `packages/*/src/**/*.ts` finds source in every package.',
      '- The result list is sorted by mtime — newer files come first, which is usually what the user wants.',
      '- An empty result is informational — the pattern matched nothing. Do not treat it as an error.',
    ].join('\n'),

    parallel:
      'Read-only. Multiple `glob` calls in one turn run in parallel — fan out across naming conventions if the user\'s phrasing is ambiguous (`userAuth` / `user_auth` / `UserAuth`).',

    alternatives: [
      '- For finding files by content match → use `grep` with the `glob` parameter to filter the search scope.',
      '- For listing a single known directory → use `listFiles`.',
      '- Never use `shell_execute` with `find` or `ls` for file discovery — `glob` is faster, returns absolute paths, and gives the user a structured tool card.',
    ].join('\n'),

    examples: [
      '1. All TypeScript sources: `glob({ pattern: "**/*.ts" })`.',
      '2. Test files in a package: `glob({ pattern: "packages/loom/**/*.test.ts" })`.',
      '3. Config files at any depth: `glob({ pattern: "**/*.config.{ts,js,json}" })`.',
    ].join('\n'),
  },
}
