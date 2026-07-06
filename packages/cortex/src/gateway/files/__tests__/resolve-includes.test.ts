import { describe, it, expect } from 'vitest'
import { hasIncludes, resolveIncludes, type LoadPart } from '../resolve-includes.js'

/** A loader backed by an in-memory map (no filesystem). */
function loaderFrom(parts: Record<string, string | null>): LoadPart {
  return async (p: string) => (p in parts ? parts[p] : null)
}

describe('hasIncludes', () => {
  it('detects a cx:include directive', () => {
    expect(hasIncludes('<!-- cx:include parts/sidebar.html -->')).toBe(true)
    expect(hasIncludes('<div>no includes</div>')).toBe(false)
  })
})

describe('resolveIncludes', () => {
  it('stitches a part in place of the directive', async () => {
    const html = '<body><!-- cx:include parts/sidebar.html --><main>x</main></body>'
    const out = await resolveIncludes(
      html,
      loaderFrom({ 'parts/sidebar.html': '<nav>SIDE</nav>' }),
    )
    expect(out).toBe('<body><nav>SIDE</nav><main>x</main></body>')
  })

  it('replaces EVERY occurrence of the same include', async () => {
    const html = '<!-- cx:include p.html -->|<!-- cx:include p.html -->'
    const out = await resolveIncludes(html, loaderFrom({ 'p.html': 'X' }))
    expect(out).toBe('X|X')
  })

  it('tolerates flexible whitespace in the directive', async () => {
    const out = await resolveIncludes(
      '<!--cx:include   parts/h.html   -->',
      loaderFrom({ 'parts/h.html': 'H' }),
    )
    expect(out).toBe('H')
  })

  it('renders a VISIBLE error for a missing part (never blank, never dropped)', async () => {
    const out = await resolveIncludes('<!-- cx:include nope.html -->', loaderFrom({}))
    expect(out).toContain('data-cx-include-error')
    expect(out).toContain('part not found')
    expect(out).toContain('nope.html')
  })

  it('resolves nested includes (a part that includes a part)', async () => {
    const out = await resolveIncludes(
      '<!-- cx:include a.html -->',
      loaderFrom({
        'a.html': 'A[<!-- cx:include b.html -->]',
        'b.html': 'B',
      }),
    )
    expect(out).toBe('A[B]')
  })

  it('detects a circular include and renders an error instead of looping', async () => {
    const out = await resolveIncludes(
      '<!-- cx:include a.html -->',
      loaderFrom({
        'a.html': '<!-- cx:include b.html -->',
        'b.html': '<!-- cx:include a.html -->',
      }),
    )
    expect(out).toContain('data-cx-include-error')
    expect(out).toContain('circular include')
  })

  it('an empty include directive is not treated as an include (stays literal)', async () => {
    // The path must start with a real char, so `<!-- cx:include  -->` is
    // just an HTML comment — left untouched, never crashes, never an error
    // box for what isn't a real directive.
    const html = '<!-- cx:include  -->'
    expect(hasIncludes(html)).toBe(false)
    expect(await resolveIncludes(html, loaderFrom({}))).toBe(html)
  })

  it('a path containing `>` is not a valid directive (stays literal — no parse, no injection)', async () => {
    // The directive path stops at the first `>`, so `<script>` can never be
    // captured as a path — the whole thing is just an HTML comment.
    const html = '<!-- cx:include <script>evil.html -->'
    expect(hasIncludes(html)).toBe(false)
    expect(await resolveIncludes(html, loaderFrom({}))).toBe(html)
  })

  it('escapes HTML in the error message for a missing part (no injection)', async () => {
    // A valid-but-missing path that contains markup chars (no `>`) reaches
    // the error block; those chars must be escaped, not rendered.
    const out = await resolveIncludes(
      '<!-- cx:include a"onerror=x.html -->',
      loaderFrom({}),
    )
    expect(out).toContain('data-cx-include-error')
    expect(out).toContain('part not found')
    // the raw quote/markup is escaped inside the error text
    expect(out).toContain('&quot;')
  })

  it('leaves include-free HTML untouched', async () => {
    const html = '<html><body><h1>hi</h1></body></html>'
    expect(await resolveIncludes(html, loaderFrom({}))).toBe(html)
  })
})
