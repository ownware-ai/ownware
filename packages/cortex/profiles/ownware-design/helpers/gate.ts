/**
 * gate — the validator that makes hardcoded values structurally impossible.
 *
 * Used by the write tools (`write_component`, `write_page`) BEFORE anything
 * lands on disk. The rule the whole product-design model rests on: a raw
 * value (colour, size) may live in exactly ONE place — `styles.css`'s `:root`
 * token block — and nowhere else. Components and pages reference tokens via
 * `var(--…)`.
 *
 * v1 scope (deliberately high-signal, near-zero false positives):
 *   - CSS: reject raw hex colours and rgb()/rgba()/hsl()/hsla() literals,
 *     EXCEPT inside a `:root { … }` block (that's where tokens are defined).
 *   - HTML: reject inline `style="…"` attributes (styling belongs in a class
 *     in styles.css), and run the CSS rules on any `<style>` block content.
 *
 * Deferred (needs a structural allowlist before it's safe to enforce):
 *   - raw lengths (px/rem/em) for spacing/radius. `0`, `1px` borders, `100%`,
 *     `50%`, `1fr`, `auto` are legitimate structural values, so length
 *     enforcement waits for the allowlist + auto-snap pass. Colour is the
 *     highest-value axis and is safe to enforce now.
 *
 * `.ts` (not `.js`) imports throughout — profile code loads as SOURCE via
 * Node type-strip. See CT-10.
 */

export interface GateViolation {
  /** Stable rule id, e.g. 'no-raw-color', 'no-inline-style'. */
  readonly rule: string
  /** The offending snippet. */
  readonly match: string
  /** One-line, actionable fix the agent can act on. */
  readonly hint: string
}

const HEX = /#[0-9a-fA-F]{3,8}\b/g
const COLOR_FN = /\b(?:rgb|rgba|hsl|hsla)\s*\([^)]*\)/gi
const INLINE_STYLE = /\sstyle\s*=\s*["'][^"']*["']/gi
const STYLE_BLOCK = /<style[^>]*>([\s\S]*?)<\/style>/gi
const ROOT_BLOCK = /:root\s*\{[\s\S]*?\}/g

/** Strip every `:root { … }` block so token definitions (the one place raw
 *  values are allowed) don't trip the colour checks. */
function withoutRoot(css: string): string {
  return css.replace(ROOT_BLOCK, '')
}

/** Validate a CSS string. Raw colours outside `:root` are violations. */
export function validateCss(css: string): GateViolation[] {
  const body = withoutRoot(css)
  const out: GateViolation[] = []
  for (const m of body.matchAll(HEX)) {
    out.push({
      rule: 'no-raw-color',
      match: m[0],
      hint: `Raw colour "${m[0]}" is not allowed outside :root. Define it with set_tokens, then use var(--your-token).`,
    })
  }
  for (const m of body.matchAll(COLOR_FN)) {
    out.push({
      rule: 'no-raw-color',
      match: m[0],
      hint: `Raw colour "${m[0]}" is not allowed outside :root. Define it with set_tokens, then use var(--your-token).`,
    })
  }
  return out
}

/** Validate an HTML fragment or document. Inline styles are violations; any
 *  `<style>` block content is held to the CSS rules. */
export function validateHtml(html: string): GateViolation[] {
  const out: GateViolation[] = []
  for (const m of html.matchAll(INLINE_STYLE)) {
    out.push({
      rule: 'no-inline-style',
      match: m[0].trim(),
      hint: 'No inline style="…". Move it to a class in styles.css and reference tokens via var(--…).',
    })
  }
  for (const block of html.matchAll(STYLE_BLOCK)) {
    out.push(...validateCss(block[1] ?? ''))
  }
  return out
}

/** Render violations as an agent-actionable error body. */
export function formatViolations(violations: readonly GateViolation[]): string {
  const lines = violations.map(
    (v, i) => `  ${i + 1}. [${v.rule}] ${v.match}\n     → ${v.hint}`,
  )
  return (
    `Rejected: ${violations.length} hardcoded value${violations.length === 1 ? '' : 's'} found. ` +
    `Fix and retry — only :root may hold raw values.\n${lines.join('\n')}`
  )
}
