/**
 * `set_tokens` — the ONLY door through which raw design values enter a
 * design workspace.
 *
 * Everything else (components, pages) must reference tokens via `var(--…)`;
 * this tool is where the literal `#hex` / `16px` / shadow value is allowed to
 * live, exactly once, in `styles.css`'s `:root` block. It upserts ONE OR MANY
 * custom properties in a single call: creates `styles.css` (with a `:root {}`)
 * if absent, updates values in place if a token already exists, or appends
 * otherwise.
 *
 * Batched on purpose: establishing or re-theming a palette is many tokens at
 * once. One call writes them all (one disk read, one write) instead of a
 * round-trip per token. A one-off tweak is just a single-element array.
 *
 * Live-from-disk: the write lands in `styles.css` and the client's canvas re-flows
 * every screen that references the tokens — no build step, no renderer.
 *
 * Loaded by Cortex via `agent.json.tools.custom`. `.ts` (not `.js`): profile
 * tools load as SOURCE via Node type-strip — a `.js` specifier 500s. See CT-10.
 */

import { defineTool } from '@ownware/loom'
import { z } from 'zod'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const DESCRIPTION = `Set (create or update) ONE OR MORE design tokens in \`styles.css\`'s \`:root\` block, in a single call. This is the ONLY place a raw value (a hex colour, a px size, a shadow) is allowed to live — every component and page must reference tokens via \`var(--…)\`, never a literal.

## When to use
- Establishing the design system: pass the WHOLE palette/type-scale/spacing at once — one call, not one per token.
- Re-theming: change several tokens together; every screen that uses \`var(--…)\` re-flows live.
- A one-off change is just a single-element list (e.g. retheme the accent).

## When NOT to use
- Do NOT invent a one-off token to sneak a literal onto a single element — a token is for real system values that recur. Prefer an existing token.

## Inputs
- \`tokens\` (required): a non-empty array of \`{ name, value }\`.
  - \`name\`: WITHOUT the leading \`--\`, lowercase kebab-case (e.g. \`accent\`, \`bg\`, \`space-md\`, \`radius\`). The tool writes \`--<name>\`.
  - \`value\`: the raw CSS value (e.g. \`#635bff\`, \`16px\`, \`0 1px 2px rgba(16,24,40,.06)\`). A single declaration value — no \`;\`, \`{\`, \`}\`, or newlines.

## Output
A one-line confirmation of how many tokens were created/updated. The canonical vocabulary (\`--bg\`, \`--fg\`, \`--muted\`, \`--accent\`, \`--line\`, \`--radius\`, \`--container\`, \`--gap\`, \`--font\`, plus state colours) should always exist; seed it in one call with this tool.`

const TokenSchema = z.object({
  name: z
    .string()
    .regex(
      /^[a-z][a-z0-9-]*$/,
      'name must be lowercase kebab-case without the leading "--" (e.g. "accent", "space-md")',
    ),
  value: z
    .string()
    .min(1, 'value must not be empty')
    .refine(
      (v) => !/[;{}]/.test(v) && !/[\r\n]/.test(v),
      'value must be a single CSS declaration value — no ";", "{", "}", or newlines',
    ),
})

const InputSchema = z.object({
  tokens: z
    .array(TokenSchema)
    .min(1, 'provide at least one token in `tokens`'),
})

/** Upsert `--name: value;` inside the first `:root { … }` block of `css`.
 *  Returns the new stylesheet text and whether the token already existed. */
function upsertToken(
  css: string,
  name: string,
  value: string,
): { next: string; action: 'created' | 'updated' } {
  const decl = `  --${name}: ${value};`
  const rootRe = /:root\s*\{([\s\S]*?)\}/

  const match = rootRe.exec(css)
  if (!match) {
    // No :root block yet — prepend a fresh one.
    const block = `:root {\n${decl}\n}\n\n`
    return { next: block + css, action: 'created' }
  }

  const inner = match[1] ?? ''
  const propRe = new RegExp(`(^|\\n)\\s*--${name}\\s*:[^;\\n]*;?`)
  if (propRe.test(inner)) {
    // Update existing declaration in place.
    const nextInner = inner.replace(propRe, `$1${decl}`)
    const nextBlock = match[0].replace(inner, nextInner)
    return { next: css.replace(match[0], nextBlock), action: 'updated' }
  }

  // Append before the closing brace, preserving existing content.
  const trimmed = inner.replace(/\s*$/, '')
  const nextInner = `${trimmed}${trimmed ? '\n' : '\n'}${decl}\n`
  const nextBlock = match[0].replace(inner, nextInner)
  return { next: css.replace(match[0], nextBlock), action: 'created' }
}

export const SET_TOKENS_TOOL = defineTool({
  name: 'set_tokens',
  description: DESCRIPTION,
  category: 'custom',
  isReadOnly: false,
  requiresPermission: false,
  uiDescriptor: {
    kind: 'file-edit',
    summary: { verb: 'Set tokens', primaryField: 'tokens' },
  },
  inputSchema: {
    type: 'object',
    properties: {
      tokens: {
        type: 'array',
        minItems: 1,
        description:
          'One or more design tokens to upsert into styles.css :root, in a single call. Pass the whole palette at once.',
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description:
                'Token name WITHOUT the leading "--", lowercase kebab-case (e.g. "accent", "bg", "space-md", "radius"). The tool writes "--<name>".',
            },
            value: {
              type: 'string',
              description:
                'The raw CSS value (e.g. "#635bff", "16px", "0 1px 2px rgba(16,24,40,.06)"). A single declaration value — no ";", "{", "}", or newlines.',
            },
          },
          required: ['name', 'value'],
        },
      },
    },
    required: ['tokens'],
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

    const { tokens } = parsed.data
    const stylesPath = path.join(context.workspacePath, 'styles.css')

    let css = ''
    try {
      css = await fs.readFile(stylesPath, 'utf-8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        return {
          content: `Failed to read styles.css: ${e instanceof Error ? e.message : String(e)}`,
          isError: true,
        }
      }
      // ENOENT — first tokens in a fresh workspace; start from empty.
    }

    // Apply every token to the in-memory stylesheet, then write ONCE.
    let created = 0
    let updated = 0
    const names: string[] = []
    for (const { name, value } of tokens) {
      const res = upsertToken(css, name, value)
      css = res.next
      if (res.action === 'created') created += 1
      else updated += 1
      names.push(`--${name}`)
    }

    try {
      await fs.writeFile(stylesPath, css, 'utf-8')
    } catch (e) {
      return {
        content: `Failed to write styles.css: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      }
    }

    const summary =
      tokens.length === 1
        ? `${created === 1 ? 'Created' : 'Updated'} token ${names[0]} in styles.css. Every screen referencing var(${names[0]}) re-flows.`
        : `Wrote ${String(tokens.length)} tokens (${String(created)} created, ${String(updated)} updated) in styles.css: ${names.join(', ')}. Every screen referencing them re-flows.`

    return {
      content: summary,
      isError: false,
      metadata: { count: tokens.length, created, updated, names, path: 'styles.css' },
    }
  },
})
