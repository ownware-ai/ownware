/**
 * `list_design_systems` — browse the profile's design-system catalog.
 *
 * Returns lightweight summaries (id, name, category, swatches, one-line
 * summary) for every matching entry. NO heavy file contents — use
 * `apply_design_system` once an id is chosen.
 *
 * Reads the catalog at `<profile-dir>/design-systems/` (or the
 * `OWNWARE_DESIGN_CATALOG_DIR` override). See `helpers/catalog-path.ts`.
 *
 * Loaded by Cortex via `agent.json.tools.custom`; the file's top-level
 * export is the `Tool` instance Cortex registers.
 */

import { defineTool } from '@ownware/loom'
import { z } from 'zod'
// `.ts` (not `.js`) is REQUIRED on these sibling imports: profile tools are
// loaded as SOURCE via the gateway's `loadCustomTools` → dynamic `import()`
// under Node's native type-stripping (profiles are never compiled — there is
// no `dist/profiles`). Type-stripping does NOT remap import specifiers, so a
// `.js` specifier resolves literally to a non-existent file and throws
// ERR_MODULE_NOT_FOUND, 500-ing every `/run`. The repo's `.js`-everywhere
// rule is for compiled `src/` code; it does not apply to source-loaded
// profile tools. See CT-10 in the design-context-tooling board.
import { getDesignSystemsService } from '../helpers/service.ts'
import {
  DesignSystemCategorySchema,
  DesignSystemSurfaceSchema,
} from '../helpers/manifest.schema.ts'

const DESCRIPTION = `Browse the design-system catalog by category, surface, or free-text search. Returns lightweight summaries (id, name, category, swatches, one-line summary) for every matching entry — NO heavy file contents.

## When to use
- The user names a brand or a feeling and you want to surface catalog candidates before picking one ("Linear-style", "warm and friendly", "B2B credibility").
- The user asks "what design systems are available?" — return a short curated list.
- You need to verify an id exists before calling \`apply_design_system\`.

## When NOT to use
- You already know the id you want — go straight to \`apply_design_system\`.
- The user is asking for an artifact, not for a catalog browse — don't pre-list candidates unprompted.

## Inputs
- \`category\` (optional): a lowercase-kebab label (e.g. minimal, marketing, editorial, premium). Open-ended — call with no filter first to see what's in the catalog.
- \`surface\` (optional): one of web | mobile | print | deck.
- \`search\` (optional): free-text. Case-insensitive substring over id, name, and summary.
- \`limit\` (optional, default 24, max 200): cap how many entries come back; the total is reported separately so you know if there are more.

## Output
JSON: \`{ total, results: [{ id, name, category, surface, summary, swatches }] }\`. When the catalog is not configured on this install, returns \`{ total: 0, results: [], catalogConfigured: false }\` — surface that to the user as a setup issue rather than retrying.`

const InputSchema = z.object({
  category: DesignSystemCategorySchema.optional(),
  surface: DesignSystemSurfaceSchema.optional(),
  search: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
})

export const LIST_DESIGN_SYSTEMS_TOOL = defineTool({
  name: 'list_design_systems',
  description: DESCRIPTION,
  category: 'custom',
  isReadOnly: true,
  requiresPermission: false,
  uiDescriptor: {
    kind: 'search',
    summary: { verb: 'Browsed systems', primaryField: 'search' },
  },
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description:
          'Filter to one category (a lowercase-kebab label, e.g. "minimal", "marketing", "editorial"). Categories are open-ended — call without a filter first to see what the catalog actually offers. Omit to search across every category.',
      },
      surface: {
        type: 'string',
        enum: ['web', 'mobile', 'print', 'deck'],
        description: 'Filter to systems tuned for a specific surface. Omit for no filter.',
      },
      search: {
        type: 'string',
        description:
          'Case-insensitive substring search over id, name, and summary. Use when the user names a brand ("linear", "stripe") or a feeling ("warm", "minimal").',
      },
      limit: {
        type: 'integer',
        description:
          'Maximum entries to return. Default 24. Bounded to 1..200; out-of-range values are rejected.',
      },
    },
    required: [],
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

    const { category, surface, search, limit = 24 } = parsed.data
    const service = getDesignSystemsService()
    const result = await service.list({ category, surface, search, limit })

    if (!result.catalogConfigured) {
      return {
        content: JSON.stringify(
          {
            total: 0,
            results: [],
            catalogConfigured: false,
            error:
              'Design-system catalog is not configured. Set OWNWARE_DESIGN_CATALOG_DIR or ensure the profile install includes a design-systems/ subdirectory.',
          },
          null,
          2,
        ),
        isError: false,
      }
    }

    return {
      content: JSON.stringify(
        {
          total: result.total,
          results: result.summaries.map((s) => ({
            id: s.id,
            name: s.name,
            category: s.category,
            surface: s.surface,
            summary: s.summary,
            swatches: s.swatches,
          })),
        },
        null,
        2,
      ),
      isError: false,
    }
  },
})
