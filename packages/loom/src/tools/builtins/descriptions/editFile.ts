/**
 * Modular description for the `editFile` builtin tool.
 *
 * High-stakes — wrong edits silently corrupt files. Description focuses
 * on the unique-old-string contract, indentation preservation, and the
 * read-before-edit requirement.
 */

import type { ToolDescription } from '../../descriptions/types.js'

export const editFileDescription: ToolDescription = {
  name: 'editFile',
  sections: {
    overview:
      'Perform an exact string replacement in a file. Replace `old_string` with `new_string`. The match must be unique within the file unless `replace_all` is set.',

    usage: [
      '- Read the file in this turn before editing. The tool reads the file fresh to perform the replacement, so an `old_string` you remembered from earlier — or guessed — will not match if the file has moved underneath you.',
      '- `old_string` must match the file content EXACTLY — whitespace, indentation, and all. Copy from the `readFile` output rather than retyping from memory.',
      '- When the file content shows line-number prefixes (read-tool format `<line>\\t<text>`), match only the text after the tab. Never include line numbers in `old_string` or `new_string`.',
      '- The match must be unique. If `old_string` appears more than once, include enough surrounding lines to disambiguate, or use `replace_all` to update every occurrence.',
      '- Prefer editing existing files over creating new ones. Only create a new file when the goal genuinely requires it.',
      '- Never add emojis to files unless the user explicitly asks.',
    ].join('\n'),

    safety: [
      '- Linters, the user, or background watchers can change a file between turns. If a `<system-reminder>` notes external modification, re-read before editing.',
      '- For deletions, include 2-3 lines BEFORE and AFTER the removed code in `old_string` (lines you keep) so the edit is unambiguous and you cannot orphan a closing brace or a caller.',
      '- After a non-trivial edit, re-read the edited region to confirm the change applied correctly and nothing adjacent was corrupted.',
      '- Do not use `editFile` to wholesale rewrite a file — use `writeFile` for new files or complete rewrites.',
    ].join('\n'),

    parallel:
      'NOT read-only. `editFile` calls run serially after read-only tools in the same turn. Independent edits to different files in one turn ARE safe to issue together — the loop serializes them.',

    alternatives: [
      '- New file → `writeFile`.',
      '- Bulk find-and-replace across many files → invoke `editFile` per file with `replace_all: true`. Don\'t shell-pipe `sed`.',
      '- Renaming a symbol across the file → `replace_all: true` is the right primitive.',
      '- Never use `shell_execute` with `sed`/`awk`/redirection (`>`/`>>`) to edit files — they bypass safety and the user can\'t see structured output.',
    ].join('\n'),

    examples: [
      '1. Single edit: `editFile({ file_path: "/work/foo.ts", old_string: "const x = 1", new_string: "const x = 2" })`.',
      '2. Rename a variable: `editFile({ file_path: "/work/foo.ts", old_string: "userId", new_string: "accountId", replace_all: true })`.',
      '3. Delete a block — include surrounding context in `old_string` so the match is unique and the framing lines are preserved.',
    ].join('\n'),
  },
}
