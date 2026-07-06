/**
 * `apply_design_system` — load full data for one design system by id.
 *
 * Returns the DESIGN.md prose, the tokens.css contents, and the
 * pre-extracted `:root { ... }` block ready to paste into the artifact's
 * first `<style>` tag.
 *
 * Loaded by Cortex via `agent.json.tools.custom`; the file's top-level
 * export is the `Tool` instance Cortex registers.
 */

import { defineTool } from '@ownware/loom'
import { z } from 'zod'
import { getDesignSystemsService } from '../helpers/service.js'

const DESCRIPTION = `Load full data for one design system by id: the DESIGN.md prose, the tokens.css contents, and the pre-extracted \`:root { ... }\` block ready to paste into the artifact's first \`<style>\` tag.

## When to use
- You've picked a design system (either you knew the id or confirmed it with the user after \`list_design_systems\`).
- You're about to write or rewrite the canonical artifact and need the tokens + design prose in context.

## How to use the output
1. Read \`designMd\` to understand the system's palette logic, type discipline, density, signature moves, and avoid list. Treat it as authoritative.
2. Paste \`rootBlock\` verbatim into the artifact's first \`<style>\` tag, on its own line, before any component CSS.
3. Every component CSS rule below the \`:root\` block must reference colors and shapes via \`var(--…)\`. A hardcoded hex outside the \`:root\` block is a smell — see the \`artifact\` skill.
4. If \`attribution\` is present, include a one-line HTML comment near the top of the artifact crediting the upstream.

## Inputs
- \`id\` (required): kebab-case design-system id. Use \`list_design_systems\` first if you don't know it.

## Output
JSON: \`{ id, name, category, surface, designMd, tokensCss, rootBlock, attribution? }\`. Returns an error when the id is unknown — call \`list_design_systems\` to find a valid one.`

const InputSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'id must be lowercase kebab-case'),
})

export const APPLY_DESIGN_SYSTEM_TOOL = defineTool({
  name: 'apply_design_system',
  description: DESCRIPTION,
  category: 'custom',
  isReadOnly: true,
  requiresPermission: false,
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'The design system id. Lowercase kebab-case (matches ^[a-z0-9-]+$), exactly matching a catalog folder name. Use list_design_systems first if you do not know the id.',
      },
    },
    required: ['id'],
  },
  async execute(input) {
    const parsed = InputSchema.safeParse(input)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return {
        content: `Invalid input: ${issue?.path.join('.') ?? 'input'}: ${issue?.message ?? 'unknown'}`,
        isError: true,
      }
    }

    const service = getDesignSystemsService()

    if (service.getCatalogDir() === null) {
      return {
        content:
          'Design-system catalog is not configured. Set OWNWARE_DESIGN_CATALOG_DIR or ensure the profile install includes a design-systems/ subdirectory.',
        isError: true,
      }
    }

    const entry = await service.apply(parsed.data.id)
    if (!entry) {
      return {
        content: `Unknown design system id "${parsed.data.id}". Call list_design_systems to see valid ids.`,
        isError: true,
      }
    }

    const { manifest } = entry
    const attribution =
      manifest.source.type === 'imported'
        ? {
            upstream: manifest.source.upstream,
            license: manifest.source.license,
          }
        : manifest.source.type === 'community'
          ? {
              contributor: manifest.source.contributor,
              license: manifest.source.license,
            }
          : undefined

    return {
      content: JSON.stringify(
        {
          id: manifest.id,
          name: manifest.name,
          category: manifest.category,
          surface: manifest.surface,
          designMd: entry.designMd,
          tokensCss: entry.tokensCss,
          rootBlock: entry.rootBlock,
          ...(attribution ? { attribution } : {}),
        },
        null,
        2,
      ),
      isError: false,
    }
  },
})
