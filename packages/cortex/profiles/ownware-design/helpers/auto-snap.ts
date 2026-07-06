/**
 * auto-snap — turn raw colours into tokens automatically, so a write
 * never FAILS on a hardcoded colour.
 *
 * The gate makes hardcoded values structurally impossible by REJECTING
 * them. That's correct, but rejecting a 500-line page because it has 5
 * raw colours forces the model to regenerate the whole document — and it
 * often misses one and loops. Colour tokenization is mechanical, not a
 * judgement call, so the tool can just DO it:
 *
 *   - find each raw colour outside `:root` (#hex / rgb()/rgba()/hsl()/hsla())
 *   - if an existing `:root` token already holds that colour, reuse its
 *     name (so `#0d1117` becomes `var(--video-bg-start)` when that token
 *     exists) — no duplicate token
 *   - otherwise mint a deterministic `--color-<hex>` token (identical
 *     colours always map to the same name → idempotent across rewrites)
 *   - replace the literal with `var(--…)` and queue the new tokens for
 *     `:root`
 *
 * Scope: COLOUR only — the gate's safe axis. Inline `style="…"` is NOT
 * auto-fixed (converting a style attribute to a class is a structural
 * change the model should make); those still fail the gate.
 *
 * `.ts` imports throughout — profile code loads as SOURCE via Node
 * type-strip (CT-10).
 */

const HEX = /#[0-9a-fA-F]{3,8}\b/
const COLOR_FN = /\b(?:rgb|rgba|hsl|hsla)\s*\([^)]*\)/i
const STYLE_BLOCK = /<style[^>]*>([\s\S]*?)<\/style>/gi
const ROOT_BLOCK_G = /:root\s*\{[\s\S]*?\}/g
const ROOT_TOKEN = /--([a-z][a-z0-9-]*)\s*:\s*([^;]+);/gi

export interface SnapToken {
  readonly name: string
  readonly value: string
}

export interface SnapResult {
  /** The input with raw colours replaced by `var(--…)`. */
  readonly out: string
  /** Tokens to upsert into `:root` (deduped, only genuinely new colours). */
  readonly newTokens: readonly SnapToken[]
}

// ── Colour normalization ────────────────────────────────────────────────

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

function toHex2(n: number): string {
  return clampByte(n).toString(16).padStart(2, '0')
}

/** "47" → 47, "50%" → 127.5. Null if not a number/percent. */
function parseChannel(raw: string): number | null {
  const s = raw.trim()
  if (s.endsWith('%')) {
    const p = Number.parseFloat(s.slice(0, -1))
    return Number.isFinite(p) ? (p / 100) * 255 : null
  }
  const n = Number.parseFloat(s)
  return Number.isFinite(n) ? n : null
}

/** ".15" → 0.15, "15%" → 0.15, "1" → 1. */
function parseAlpha(raw: string): number {
  const s = raw.trim()
  if (s.endsWith('%')) {
    const p = Number.parseFloat(s.slice(0, -1))
    return Number.isFinite(p) ? Math.max(0, Math.min(1, p / 100)) : 1
  }
  const n = Number.parseFloat(s)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1
}

function rgbaToCanonical(r: number, g: number, b: number, a: number): string {
  const base = `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`
  if (a >= 1) return base
  return `${base}${toHex2(a * 255)}`
}

function hslToCanonical(h: number, s: number, l: number, a: number): string {
  // h in degrees, s/l in 0..1
  const hh = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (hh < 60) [r, g, b] = [c, x, 0]
  else if (hh < 120) [r, g, b] = [x, c, 0]
  else if (hh < 180) [r, g, b] = [0, c, x]
  else if (hh < 240) [r, g, b] = [0, x, c]
  else if (hh < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return rgbaToCanonical((r + m) * 255, (g + m) * 255, (b + m) * 255, a)
}

/** Canonicalize a colour literal to lowercase `#rrggbb` / `#rrggbbaa` so
 *  equal colours written different ways share one token. Null if not a
 *  parseable single colour. */
export function normalizeColor(raw: string): string | null {
  const v = raw.trim().toLowerCase()

  const hex = /^#([0-9a-f]{3,8})$/.exec(v)
  if (hex != null) {
    let h = hex[1] ?? ''
    if (h.length === 3 || h.length === 4) {
      h = h.split('').map((ch) => ch + ch).join('')
    }
    if (h.length !== 6 && h.length !== 8) return null
    if (h.length === 8 && h.slice(6) === 'ff') h = h.slice(0, 6)
    return `#${h}`
  }

  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(v)
  if (fn != null) {
    const kind = fn[1] ?? ''
    // Accept both comma and modern space/slash syntax.
    const parts = (fn[2] ?? '')
      .replace(/\//g, ' ')
      .split(/[\s,]+/)
      .filter((p) => p.length > 0)
    if (parts.length < 3) return null
    const a = parts.length >= 4 ? parseAlpha(parts[3] ?? '1') : 1
    if (kind.startsWith('rgb')) {
      const r = parseChannel(parts[0] ?? '')
      const g = parseChannel(parts[1] ?? '')
      const b = parseChannel(parts[2] ?? '')
      if (r == null || g == null || b == null) return null
      return rgbaToCanonical(r, g, b, a)
    }
    // hsl
    const h = Number.parseFloat((parts[0] ?? '').replace('deg', ''))
    const s = Number.parseFloat((parts[1] ?? '').replace('%', ''))
    const l = Number.parseFloat((parts[2] ?? '').replace('%', ''))
    if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l)) return null
    return hslToCanonical(h, s / 100, l / 100, a)
  }

  return null
}

// ── Existing :root tokens (for value reuse) ──────────────────────────────

/** Map canonical-colour → token name from a stylesheet's `:root` block(s),
 *  so an already-defined colour is reused instead of minting a duplicate.
 *  First definition of a value wins. */
export function parseRootColorTokens(stylesCss: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const block of stylesCss.matchAll(ROOT_BLOCK_G)) {
    const inner = block[0]
    for (const m of inner.matchAll(ROOT_TOKEN)) {
      const name = m[1]
      const value = m[2]
      if (name == null || value == null) continue
      const norm = normalizeColor(value)
      if (norm != null && !out.has(norm)) out.set(norm, name)
    }
  }
  return out
}

// ── The snap ─────────────────────────────────────────────────────────────

/**
 * Replace raw colours in a CSS string with `var(--…)`, reusing existing
 * `:root` tokens by value and minting `--color-<hex>` for new ones.
 * Colours inside a `:root { … }` block in the input are left untouched
 * (that's where raw values legitimately live). Pass the stylesheet's
 * current root via `existing` for cross-file reuse.
 */
export function autoSnapColors(
  css: string,
  existing: ReadonlyMap<string, string>,
): SnapResult {
  const minted = new Map<string, string>() // canonical → minted name
  const newTokens: SnapToken[] = []

  const resolve = (literal: string): string => {
    const norm = normalizeColor(literal)
    if (norm == null) return literal // unparseable → leave (gate may still flag)
    const reused = existing.get(norm)
    if (reused != null) return `var(--${reused})`
    const already = minted.get(norm)
    if (already != null) return `var(--${already})`
    const name = `color-${norm.slice(1)}` // drop the '#'
    minted.set(norm, name)
    newTokens.push({ name, value: norm })
    return `var(--${name})`
  }

  // One pass: a :root block is matched whole and passed through verbatim;
  // otherwise a colour literal is resolved to a token reference.
  const combined = new RegExp(
    `(:root\\s*\\{[\\s\\S]*?\\})|(${HEX.source})|(${COLOR_FN.source})`,
    'gi',
  )
  const out = css.replace(combined, (match, rootBlock: string | undefined) => {
    if (rootBlock != null) return rootBlock
    return resolve(match)
  })

  return { out, newTokens }
}

/** Auto-snap colours inside every `<style>` block of an HTML document. */
export function autoSnapHtml(
  html: string,
  existing: ReadonlyMap<string, string>,
): SnapResult {
  const newTokens: SnapToken[] = []
  const seen = new Set<string>()
  const merged = new Map(existing)

  const out = html.replace(STYLE_BLOCK, (block, inner: string) => {
    const snapped = autoSnapColors(inner, merged)
    for (const t of snapped.newTokens) {
      if (seen.has(t.name)) continue
      seen.add(t.name)
      newTokens.push(t)
      // Later style blocks reuse tokens minted by earlier ones.
      merged.set(`#${t.name.slice('color-'.length)}`, t.name)
    }
    return block.replace(inner, snapped.out)
  })

  return { out, newTokens }
}

// ── Writing the minted tokens into :root ─────────────────────────────────

/** Upsert tokens into the first `:root { … }` block of `stylesCss`,
 *  creating the block (and file content) if absent. Mirrors set_tokens'
 *  upsert so a minted token lands exactly where a hand-set one would. */
export function upsertTokensIntoRoot(
  stylesCss: string,
  tokens: readonly SnapToken[],
): string {
  let css = stylesCss
  for (const { name, value } of tokens) {
    const decl = `  --${name}: ${value};`
    const rootRe = /:root\s*\{([\s\S]*?)\}/
    const match = rootRe.exec(css)
    if (match == null) {
      css = `:root {\n${decl}\n}\n\n${css}`
      continue
    }
    const inner = match[1] ?? ''
    const propRe = new RegExp(`(^|\\n)\\s*--${name}\\s*:[^;\\n]*;?`)
    if (propRe.test(inner)) {
      const nextInner = inner.replace(propRe, `$1${decl}`)
      css = css.replace(match[0], match[0].replace(inner, nextInner))
    } else {
      const trimmed = inner.replace(/\s*$/, '')
      const nextInner = `${trimmed}\n${decl}\n`
      css = css.replace(match[0], match[0].replace(inner, nextInner))
    }
  }
  return css
}
