import { describe, it, expect } from 'vitest'
import {
  encodeFontUrl,
  decodeFontUrl,
  parseAllowedFontUrl,
  rewriteDesignFonts,
  rewriteFontCss,
  FONT_CSS_HOST,
  FONT_FILE_HOST,
} from '../rewrite.js'

const ORIGIN = 'http://127.0.0.1:3011'
const CSS_URL =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap'

describe('encode/decode font url', () => {
  it('round-trips a googleapis css url', () => {
    expect(decodeFontUrl(encodeFontUrl(CSS_URL))).toBe(CSS_URL)
  })

  it('produces a URL-safe token (no + / =)', () => {
    expect(encodeFontUrl(CSS_URL)).not.toMatch(/[+/=]/)
  })

  it('returns null for a malformed token', () => {
    // atob rejects characters outside the base64 alphabet.
    expect(decodeFontUrl('not valid base64 !!!')).toBeNull()
  })
})

describe('parseAllowedFontUrl — SSRF gate', () => {
  it('accepts an https googleapis url when css host expected', () => {
    expect(parseAllowedFontUrl(CSS_URL, FONT_CSS_HOST)?.hostname).toBe(FONT_CSS_HOST)
  })

  it('accepts an https gstatic url when file host expected', () => {
    const u = 'https://fonts.gstatic.com/s/inter/v13/abc.woff2'
    expect(parseAllowedFontUrl(u, FONT_FILE_HOST)?.hostname).toBe(FONT_FILE_HOST)
  })

  it('rejects a host mismatch (gstatic url asked as css)', () => {
    const u = 'https://fonts.gstatic.com/s/inter/v13/abc.woff2'
    expect(parseAllowedFontUrl(u, FONT_CSS_HOST)).toBeNull()
  })

  it('rejects a non-https scheme', () => {
    expect(parseAllowedFontUrl('http://fonts.googleapis.com/css2', FONT_CSS_HOST)).toBeNull()
  })

  it('rejects an arbitrary attacker host (SSRF attempt)', () => {
    expect(parseAllowedFontUrl('https://evil.example.com/x', FONT_CSS_HOST)).toBeNull()
    expect(parseAllowedFontUrl('https://169.254.169.254/latest/meta-data', FONT_FILE_HOST)).toBeNull()
  })

  it('rejects a subdomain-spoof host', () => {
    expect(
      parseAllowedFontUrl('https://fonts.googleapis.com.evil.com/css2', FONT_CSS_HOST),
    ).toBeNull()
  })

  it('rejects garbage', () => {
    expect(parseAllowedFontUrl('not a url', FONT_CSS_HOST)).toBeNull()
  })
})

describe('rewriteDesignFonts', () => {
  it('repoints a googleapis stylesheet link at the local css proxy', () => {
    const html = `<head><link href="${CSS_URL}" rel="stylesheet"></head>`
    const out = rewriteDesignFonts(html, ORIGIN)
    expect(out).not.toContain('fonts.googleapis.com')
    expect(out).toContain(`${ORIGIN}/api/v1/fonts/css?u=`)
    // The original url survives, recoverable, inside ?u=.
    const token = /u=([A-Za-z0-9_-]+)/.exec(out)?.[1]
    expect(token && decodeFontUrl(token)).toBe(CSS_URL)
  })

  it('strips preconnect + dns-prefetch hints to Google font hosts', () => {
    const html = [
      `<link rel="preconnect" href="https://fonts.googleapis.com">`,
      `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
      `<link rel="dns-prefetch" href="https://fonts.gstatic.com">`,
      `<link href="${CSS_URL}" rel="stylesheet">`,
    ].join('\n')
    const out = rewriteDesignFonts(html, ORIGIN)
    expect(out).not.toContain('preconnect')
    expect(out).not.toContain('dns-prefetch')
    expect(out).not.toContain('fonts.gstatic.com')
  })

  it('handles single-quoted href + rel-before-href order', () => {
    const html = `<link rel='stylesheet' href='${CSS_URL}' />`
    const out = rewriteDesignFonts(html, ORIGIN)
    expect(out).toContain('/api/v1/fonts/css?u=')
    expect(out).not.toContain('fonts.googleapis.com')
  })

  it('leaves html without Google fonts untouched', () => {
    const html = `<head><link href="/styles.css" rel="stylesheet"></head>`
    expect(rewriteDesignFonts(html, ORIGIN)).toBe(html)
  })

  it('is idempotent (re-running does not double-rewrite)', () => {
    const html = `<link href="${CSS_URL}" rel="stylesheet">`
    const once = rewriteDesignFonts(html, ORIGIN)
    expect(rewriteDesignFonts(once, ORIGIN)).toBe(once)
  })

  it('tolerates a trailing slash on origin', () => {
    const html = `<link href="${CSS_URL}" rel="stylesheet">`
    expect(rewriteDesignFonts(html, ORIGIN + '/')).toContain(`${ORIGIN}/api/v1/fonts/css?u=`)
  })
})

describe('rewriteFontCss', () => {
  it('repoints every gstatic url(...) at the local file proxy', () => {
    const css = `@font-face{font-family:'Inter';src:url(https://fonts.gstatic.com/s/inter/v13/a.woff2) format('woff2')}`
    const out = rewriteFontCss(css, ORIGIN)
    expect(out).not.toContain('fonts.gstatic.com')
    expect(out).toContain(`${ORIGIN}/api/v1/fonts/file?u=`)
    const token = /file\?u=([A-Za-z0-9_-]+)/.exec(out)?.[1]
    expect(token && decodeFontUrl(token)).toBe(
      'https://fonts.gstatic.com/s/inter/v13/a.woff2',
    )
  })
})
