/**
 * Modular description for the `writeFile` builtin tool.
 *
 * The executor uses an atomic create-only flag (`wx`) and rejects
 * writes to paths that already exist. This description must match
 * that behaviour so the model never plans an overwrite that the
 * tool will refuse. For changes to existing files, the model uses
 * `editFile`, which sends a diff and avoids re-streaming the whole
 * file.
 */

import type { ToolDescription } from '../../descriptions/types.js'

export const writeFileDescription: ToolDescription = {
  name: 'writeFile',
  sections: {
    overview:
      'Create a new file with the given content. Fails if the file already exists at the path — use `editFile` for changes to existing files. Use writeFile only when the path is new.',

    usage: [
      '- The `file_path` parameter must be an absolute path.',
      '- If the file already exists, the tool returns an error. Do not retry with the same path — switch to `editFile`, or pick a different path if a fresh file is what you want.',
      '- Parent directories are created automatically.',
      '- Do not write a Markdown file (*.md) or README unless the user explicitly asked for one. Documentation files often outlive the change they were created for and rot.',
      '- Do not add emojis to files unless the user explicitly asks.',
    ].join('\n'),

    safety: [
      '- Never write secrets, credentials, or tokens to files — even as placeholder defaults. Use the credential resolver.',
      '- writeFile is for new files only. For any change to an existing file, use `editFile`, which sends a diff instead of the whole file.',
    ].join('\n'),

    parallel:
      'NOT read-only. Runs serially after read-only tools.',

    alternatives: [
      '- Change to an existing file → `editFile`. Always.',
      '- Append to an existing file → `editFile` with a unique anchor near the end of the file.',
      '- Create a directory → `shell_execute({ command: "mkdir -p path" })`. writeFile writes files, not directories.',
      '- Never use `shell_execute` with `echo >`, `cat <<EOF`, or shell redirection to create files — they bypass the tool surface and produce no structured output.',
    ].join('\n'),

    examples: [
      '1. Create a new test file: `writeFile({ file_path: "/work/repo/src/foo.test.ts", content: "..." })`.',
      '2. Create a config the user just asked for. Confirm the path first if you don\'t know where it should live — don\'t guess.',
      '3. If writeFile errors with "already exists", do NOT retry the same path — switch to `editFile`.',
    ].join('\n'),
  },
}
