/**
 * Builtin Tool Descriptions
 *
 * Modular descriptions shipped with Loom for high-leverage builtin tools.
 * Cortex's profile assembler can register these in a
 * `ToolDescriptionRegistry` to get richer, section-segmented prompt docs;
 * tools without an entry here fall through to their flat
 * `description: string`.
 *
 * Migration is opportunistic — adding a new tool here is one small file
 * + one line in `BUILTIN_DESCRIPTIONS` below; no other code changes.
 */

import type { ToolDescription } from '../../descriptions/types.js'
import { ToolDescriptionRegistry } from '../../descriptions/registry.js'
import { skillDescription } from './skill.js'
import { shellDescription } from './shell.js'
import { readFileDescription } from './readFile.js'
import { editFileDescription } from './editFile.js'
import { writeFileDescription } from './writeFile.js'
import { globDescription } from './glob.js'
import { grepDescription } from './grep.js'

export { skillDescription } from './skill.js'
export { shellDescription } from './shell.js'
export { readFileDescription } from './readFile.js'
export { editFileDescription } from './editFile.js'
export { writeFileDescription } from './writeFile.js'
export { globDescription } from './glob.js'
export { grepDescription } from './grep.js'

/** All engine-shipped builtin descriptions, in registration order. */
export const BUILTIN_DESCRIPTIONS: readonly ToolDescription[] = [
  skillDescription,
  shellDescription,
  readFileDescription,
  editFileDescription,
  writeFileDescription,
  globDescription,
  grepDescription,
]

/**
 * Build a `ToolDescriptionRegistry` pre-populated with every builtin
 * description. Cortex calls this when assembling a session whose
 * profile uses Loom's default tool surface.
 */
export function createBuiltinDescriptionRegistry(): ToolDescriptionRegistry {
  const registry = new ToolDescriptionRegistry()
  registry.registerAll(BUILTIN_DESCRIPTIONS)
  return registry
}
