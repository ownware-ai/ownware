/**
 * Modular description for the `readFile` builtin tool.
 *
 * Highest-frequency tool in coding profiles — used virtually every turn.
 * Description quality has outsized impact on agent reliability.
 */

import type { ToolDescription } from '../../descriptions/types.js'

export const readFileDescription: ToolDescription = {
  name: 'readFile',
  sections: {
    overview:
      'Read a file from the local filesystem. Returns its contents (text, base64-encoded image, or PDF page text depending on file type).',

    usage: [
      '- The `file_path` parameter must be an absolute path. Relative paths are not supported.',
      '- Read a file in this turn before editing it. `editFile` matches `old_string` literally against the file\'s current contents — stale memory of the file produces a not-found error that\'s annoying to debug. A fresh `readFile` is the cheapest way to avoid that.',
      '- For very large files, use `offset` and `limit` to read a specific range. Default reads from the start up to the engine\'s line cap.',
      '- Reading a non-existent file returns an error — that is normal; don\'t treat it as a fatal condition.',
      '- For binary content (images, PDFs), the result is rendered visually to the model where supported, or returned as base64 / page text where not.',
    ].join('\n'),

    safety: [
      '- Reading is local and side-effect-free; safe to issue freely.',
      '- Empty files return a system reminder noting the file exists but is empty — this is informational, not an error.',
      '- A file may have been modified externally since a prior read (linter, user edit). If a `<system-reminder>` indicates a file was modified, re-read before editing.',
    ].join('\n'),

    parallel:
      'Read-only — multiple `readFile` calls in one turn are run in parallel by the loop. Use this. Reading three related files in one turn is faster than serializing three turns.',

    alternatives: [
      '- For files matching a pattern → use `glob` to discover paths first, then `readFile` for the ones you need.',
      '- For searching content across many files → use `grep`. Don\'t read files just to scan them.',
      '- For listing a directory\'s contents → use `listFiles`, not `readFile`.',
      '- Never use `shell_execute` with `cat`/`head`/`tail` for reading files — `readFile` is faster, gives structured output the user can review, and respects permission rules.',
    ].join('\n'),

    examples: [
      '1. Read a config: `readFile({ file_path: "/work/repo/package.json" })`.',
      '2. Read a slice: `readFile({ file_path: "/work/repo/src/big.ts", offset: 200, limit: 100 })`.',
      '3. Re-read after a `fs.modified` reminder so you have the linter-formatted version before another edit.',
    ].join('\n'),
  },
}
