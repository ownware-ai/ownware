/**
 * `apply_design_system` — load full data for one design system by id.
 *
 * Returns the DESIGN.md prose, the tokens.css contents, and the
 * pre-extracted `:root { ... }` block — feed those tokens into `styles.css`
 * via `set_tokens` (NOT a page `<style>` block; tokens live in styles.css).
 *
 * Loaded by Cortex via `agent.json.tools.custom`; the file's top-level
 * export is the `Tool` instance Cortex registers.
 */

import { defineTool } from '@ownware/loom'
import { z } from 'zod'
// `.ts` (not `.js`): profile tools load as SOURCE via Node type-strip, which
// doesn't remap specifiers — a `.js` here 500s every `/run`. See CT-10.
import { getDesignSystemsService } from '../helpers/service.ts'

const DESCRIPTION = `Load full data for one design system by id: the DESIGN.md prose, the tokens.css contents, and the pre-extracted \`:root { ... }\` block ready to paste into the artifact's first \`<style>\` tag.

## When to use
- You've picked a design system (either you knew the id or confirmed it with the user after \`list_design_systems\`).
- You're about to build or re-theme the design and need its tokens + design prose in context.

## When NOT to use
- You already loaded this system this session — its tokens are already in \`styles.css\`; don't reload.
- You only need to confirm an id exists — that's \`list_design_systems\`.

## How to use the output
1. Read \`designMd\` to understand the system's palette logic, type discipline, density, signature moves, and avoid list. Treat it as authoritative.
2. Seed the system into the design: turn \`rootBlock\`'s \`--name: value\` declarations into ONE \`set_tokens\` call so they land in \`styles.css\`'s \`:root\`. Do NOT paste a \`<style>\` block into a page — tokens live in \`styles.css\`, by construction.
3. From there, every component and page references colours and shapes via \`var(--…)\`; the gate rejects any raw value below \`:root\`.
4. If \`attribution\` is present, add a one-line HTML comment near the top of the home page crediting the upstream.

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
  uiDescriptor: {
    kind: 'external-action',
    summary: { verb: 'Applied system', primaryField: 'id' },
  },
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
