/**
 * `write_page` — create or update a screen (`<name>.html` at the workspace
 * root). The gated replacement for a raw `writeFile` of a page.
 *
 * A page is a full HTML document that links `styles.css` and composes the UI
 * from reusable parts via `<!-- cx:include parts/<x>.html -->`. Upsert by name;
 * `index` → `index.html` (the client shows it as "Home"). Runs the gate first —
 * inline styles and raw colours (outside any :root) are rejected.
 *
 * The client shows every `.html` as a page in the Pages strip and
 * renders it live from disk — no build step.
 *
 * `.ts` (not `.js`): profile tools load as SOURCE via Node type-strip. CT-10.
 */

import { defineTool } from '@ownware/loom'
import { z } from 'zod'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { validateHtml, formatViolations } from '../helpers/gate.ts'
import { autoSnapHtml, parseRootColorTokens, upsertTokensIntoRoot } from '../helpers/auto-snap.ts'

const DESCRIPTION = `Create or update a screen — a full HTML document written to \`<name>.html\` at the workspace root. Calling it again with the same name overwrites that screen. The screen links \`styles.css\` and composes reusable parts via include comments.

## When to use
- Building or rewriting a screen (landing, dashboard, settings, …). Use \`index\` for the home screen.

## When NOT to use
- A piece that's shared across pages (sidebar, top-bar, card) → \`write_component\`, then include it with \`<!-- cx:include parts/<name>.html -->\`. Don't inline shared structure into every page.

## Inputs
- \`name\` (required): lowercase kebab-case screen name, or \`index\` for the home screen. Becomes \`<name>.html\`. No number prefixes.
- \`html\` (required): the FULL HTML document. Link the stylesheet (\`<link rel="stylesheet" href="styles.css">\`). Pull in shared markup with \`<!-- cx:include parts/<name>.html -->\`. Put \`data-cx-id\` on each meaningful region. Reference tokens via \`var(--…)\`; NO inline \`style="…"\` and NO raw colours in any \`<style>\` block (those live in :root via set_tokens).

## Gate
Inline styles and raw colours are REJECTED with exact locations; fix and retry. A note is added if a referenced part file does not exist yet — create it with write_component.`

const InputSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, 'name must be lowercase kebab-case (e.g. "index", "pricing", "dashboard")'),
  html: z.string().min(1, 'html must not be empty'),
})

const INCLUDE_RE = /<!--\s*cx:include\s+([^>\s][^>]*?)\s*-->/g

export const WRITE_PAGE_TOOL = defineTool({
  name: 'write_page',
  description: DESCRIPTION,
  category: 'custom',
  isReadOnly: false,
  requiresPermission: false,
  uiDescriptor: {
    kind: 'file-write',
    summary: { verb: 'Wrote page', primaryField: 'name' },
    preview: { contentField: 'html', format: 'code', truncateAtLines: 10 },
  },
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Lowercase kebab-case screen name, or "index" for the home screen. Becomes <name>.html. No number prefixes.',
      },
      html: {
        type: 'string',
        description:
          'Full HTML document. Link styles.css; pull shared markup via <!-- cx:include parts/<name>.html -->; data-cx-id on regions; tokens via var(--…); no inline style="…".',
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
    const { name, html } = parsed.data
    const stylesPath = path.join(context.workspacePath, 'styles.css')

    // Read the current stylesheet so auto-snap can REUSE an existing token
    // when the page repeats a colour already defined (e.g. the page uses a
    // raw `#0d1117` that `--video-bg-start` already holds), and so minted
    // tokens append to the real :root.
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

    // Auto-snap: hoist raw colours in the page's <style> blocks into tokens
    // (reuse-by-value or mint --color-<hex>) so a hardcoded colour never
    // fails the write. Deterministic — it can't miss one the way a model
    // regenerating the whole page does. Inline style="…" is still gated.
    const snap = autoSnapHtml(html, parseRootColorTokens(stylesCss))
    const finalHtml = snap.out

    // Gate the cleaned document — colours are now var(--…); this still
    // rejects inline styles (a structural fix the model must make).
    const violations = validateHtml(finalHtml)
    if (violations.length > 0) {
      return { content: formatViolations(violations), isError: true }
    }

    const pagePath = path.join(context.workspacePath, `${name}.html`)

    // Soft check: warn about included parts that don't exist yet (don't block).
    const missing: string[] = []
    for (const m of finalHtml.matchAll(INCLUDE_RE)) {
      const rel = (m[1] ?? '').trim()
      if (!rel) continue
      try {
        await fs.access(path.join(context.workspacePath, rel))
      } catch {
        missing.push(rel)
      }
    }

    try {
      // Write the minted tokens into :root FIRST so the page's var(--…)
      // references resolve the moment the canvas reloads from disk.
      if (snap.newTokens.length > 0) {
        await fs.writeFile(stylesPath, upsertTokensIntoRoot(stylesCss, snap.newTokens), 'utf-8')
      }
      await fs.writeFile(pagePath, finalHtml.trimEnd() + '\n', 'utf-8')
    } catch (e) {
      return {
        content: `Failed to write page "${name}": ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      }
    }

    const snapNote =
      snap.newTokens.length > 0
        ? ` Auto-tokenized ${snap.newTokens.length} raw colour${snap.newTokens.length === 1 ? '' : 's'} into ${snap.newTokens.map((t) => `--${t.name}`).join(', ')} — reference those (or rename them), not literals, next time.`
        : ''
    const note =
      missing.length > 0
        ? ` Note: includes not found yet — create with write_component: ${missing.join(', ')}.`
        : ''
    return {
      content: `Wrote ${name}.html — the canvas renders it live from disk.${snapNote}${note}`,
      isError: false,
      metadata: {
        page: name,
        path: `${name}.html`,
        missingIncludes: missing,
        autoSnapped: snap.newTokens.map((t) => t.name),
      },
    }
  },
})
