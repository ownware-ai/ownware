/**
 * `write_component` — create or update a reusable piece (a `parts/*.html`
 * fragment + its token-bound CSS in `styles.css`). The gated replacement for
 * a raw `writeFile` of a component.
 *
 * Upsert by name: writes `parts/<name>.html` (fresh or overwrite) and, when
 * `css` is given, upserts that component's CSS between marker comments in
 * `styles.css` so a later call updates IN PLACE (one definition, every page
 * that `cx:include`s it re-flows). Runs the gate first — inline styles and raw
 * colours are rejected before anything lands.
 *
 * The client shows the result automatically: a `parts/*.html` file referenced via
 * `<!-- cx:include parts/<name>.html -->` appears in the Advanced drawer with
 * a ×N "used by" badge.
 *
 * `.ts` (not `.js`): profile tools load as SOURCE via Node type-strip. CT-10.
 */

import { defineTool } from '@ownware/loom'
import { z } from 'zod'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { validateHtml, validateCss, formatViolations } from '../helpers/gate.ts'
import { autoSnapColors, parseRootColorTokens, upsertTokensIntoRoot } from '../helpers/auto-snap.ts'

const DESCRIPTION = `Create or update a reusable component — a \`parts/<name>.html\` fragment plus its CSS in \`styles.css\`. This is how you make a piece you reuse across pages (sidebar, top-bar, card). Calling it again with the same name UPDATES it in place, and every page that includes it re-flows.

## When to use
- The same structure appears on two or more pages — extract it once, include it everywhere via \`<!-- cx:include parts/<name>.html -->\`.
- Updating an existing component's markup or styles (same name = in-place update).

## When NOT to use
- A block that lives on exactly one page — keep it inline in that page (\`write_page\`). Don't pre-factor markup that doesn't repeat.

## Inputs
- \`name\` (required): lowercase kebab-case role name (e.g. \`sidebar\`, \`top-bar\`, \`stat-card\`). Becomes \`parts/<name>.html\`.
- \`html\` (required): the fragment markup ONLY — no \`<!doctype>\`, no \`<head>\`/\`<body>\`, no \`<style>\`. Put a \`data-cx-id="<name>"\` on the top element. Reference tokens via \`var(--…)\`; NO inline \`style="…"\`.
- \`css\` (optional): the component's CSS rules. Every value must be a token reference (\`var(--…)\`) or a structural keyword — NO raw hex/rgb/hsl (those live in :root via set_tokens).

## Gate
Inline styles and raw colours are REJECTED with exact locations; fix and retry. Only \`:root\` (via set_tokens) may hold raw values.`

const InputSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, 'name must be lowercase kebab-case (e.g. "sidebar", "stat-card")'),
  html: z.string().min(1, 'html must not be empty'),
  css: z.string().optional(),
})

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Upsert a component's CSS between marker comments in styles.css. */
function upsertComponentCss(styles: string, name: string, css: string): string {
  const start = `/* >>> component:${name} */`
  const end = `/* <<< component:${name} */`
  const block = `${start}\n${css.trim()}\n${end}`
  const blockRe = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`)
  if (blockRe.test(styles)) {
    return styles.replace(blockRe, block)
  }
  const base = styles.replace(/\s*$/, '')
  return `${base}${base ? '\n\n' : ''}${block}\n`
}

export const WRITE_COMPONENT_TOOL = defineTool({
  name: 'write_component',
  description: DESCRIPTION,
  category: 'custom',
  isReadOnly: false,
  requiresPermission: false,
  uiDescriptor: {
    kind: 'file-write',
    summary: { verb: 'Wrote component', primaryField: 'name' },
    preview: { contentField: 'html', format: 'code', truncateAtLines: 10 },
  },
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Lowercase kebab-case role name (e.g. "sidebar", "top-bar", "stat-card"). Becomes parts/<name>.html.',
      },
      html: {
        type: 'string',
        description:
          'Fragment markup ONLY — no doctype/head/body/style. data-cx-id="<name>" on the top element. Tokens via var(--…); no inline style="…".',
      },
      css: {
        type: 'string',
        description:
          'Optional component CSS. Every value is a var(--…) token reference or a structural keyword — no raw hex/rgb/hsl.',
      },
    },
    required: ['name', 'html'],
  },
  async execute(input, context) {
    const parsed = InputSchema.safeParse(input)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return {
        content: `Invalid input: ${issue?.path.join('.') ?? 'input'}: ${issue?.message ?? 'unknown'}`,
        isError: true,
      }
    }
    const { name, html, css } = parsed.data
    const stylesPath = path.join(context.workspacePath, 'styles.css')

    // Read the stylesheet up front so auto-snap reuses existing tokens and
    // minted tokens land in the real :root.
    let stylesCss = ''
    try {
      stylesCss = await fs.readFile(stylesPath, 'utf-8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        return {
          content: `Failed to read styles.css: ${e instanceof Error ? e.message : String(e)}`,
          isError: true,
        }
      }
    }

    // Auto-snap raw colours in the component CSS into tokens (reuse or mint)
    // so a hardcoded colour never fails the write. Inline style="…" in the
    // fragment is still gated.
    const snap = css != null && css.length > 0
      ? autoSnapColors(css, parseRootColorTokens(stylesCss))
      : { out: css ?? '', newTokens: [] as ReturnType<typeof autoSnapColors>['newTokens'] }
    const finalCss = css != null && css.length > 0 ? snap.out : css

    const violations = [...validateHtml(html), ...(finalCss ? validateCss(finalCss) : [])]
    if (violations.length > 0) {
      return { content: formatViolations(violations), isError: true }
    }

    const partPath = path.join(context.workspacePath, 'parts', `${name}.html`)

    try {
      await fs.mkdir(path.dirname(partPath), { recursive: true })
      await fs.writeFile(partPath, html.trimEnd() + '\n', 'utf-8')

      const writingCss = Boolean(finalCss && finalCss.trim())
      if (writingCss || snap.newTokens.length > 0) {
        let styles = stylesCss
        if (snap.newTokens.length > 0) styles = upsertTokensIntoRoot(styles, snap.newTokens)
        if (writingCss) styles = upsertComponentCss(styles, name, finalCss as string)
        await fs.writeFile(stylesPath, styles, 'utf-8')
      }
    } catch (e) {
      return {
        content: `Failed to write component "${name}": ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      }
    }

    const snapNote =
      snap.newTokens.length > 0
        ? ` Auto-tokenized ${snap.newTokens.length} raw colour${snap.newTokens.length === 1 ? '' : 's'} into ${snap.newTokens.map((t) => `--${t.name}`).join(', ')}.`
        : ''
    return {
      content:
        `Wrote parts/${name}.html${css ? ' + its CSS in styles.css' : ''}.${snapNote} ` +
        `Include it on a page with <!-- cx:include parts/${name}.html -->.`,
      isError: false,
      metadata: {
        component: name,
        hasCss: Boolean(finalCss && finalCss.trim()),
        path: `parts/${name}.html`,
        autoSnapped: snap.newTokens.map((t) => t.name),
      },
    }
  },
})
