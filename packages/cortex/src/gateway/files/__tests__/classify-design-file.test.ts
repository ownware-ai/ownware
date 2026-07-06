import { describe, it, expect } from 'vitest'
import {
  classifyDesignFile,
  htmlIsCompleteDocument,
} from '../classify-design-file.js'

describe('classifyDesignFile', () => {
  describe('stylesheet — by type, not by name or folder', () => {
    it('classifies styles.css as a stylesheet', () => {
      expect(classifyDesignFile('styles.css', ':root { --bg: #fff; }')).toBe('stylesheet')
    })
    it('classifies any .css anywhere as a stylesheet', () => {
      expect(classifyDesignFile('theme/dark.css', 'body{}')).toBe('stylesheet')
      expect(classifyDesignFile('a/b/c/whatever.css', '')).toBe('stylesheet')
    })
  })

  describe('page — a complete HTML document', () => {
    it('classifies a <!doctype> document as a page', () => {
      expect(classifyDesignFile('index.html', '<!doctype html>\n<html><head></head><body></body></html>')).toBe('page')
    })
    it('classifies an <html>-rooted document (no doctype) as a page', () => {
      expect(classifyDesignFile('pricing.html', '<html lang="en"><body>x</body></html>')).toBe('page')
    })
    it('sees through a leading license comment', () => {
      expect(classifyDesignFile('index.html', '<!-- (c) 2026 -->\n<!doctype html><html></html>')).toBe('page')
    })
    it('sees through a BOM + whitespace', () => {
      expect(classifyDesignFile('index.html', '﻿   \n<!DOCTYPE HTML><html></html>')).toBe('page')
    })
    it('is case-insensitive on the doctype', () => {
      expect(classifyDesignFile('index.html', '<!DOCTYPE html><HTML></HTML>')).toBe('page')
    })
  })

  describe('component — an HTML fragment', () => {
    it('classifies a <header> fragment as a component', () => {
      expect(classifyDesignFile('parts/top-bar.html', '<header class="top-bar"><nav></nav></header>')).toBe('component')
    })
    it('classifies a bare <div> fragment as a component', () => {
      expect(classifyDesignFile('parts/footer.html', '<div class="footer"></div>')).toBe('component')
    })
    it('classifies a fragment that opens with a comment as a component', () => {
      expect(classifyDesignFile('parts/x.html', '<!-- shared piece -->\n<section></section>')).toBe('component')
    })
    it('does not depend on the parts/ folder — a fragment at the root is still a component', () => {
      expect(classifyDesignFile('sidebar.html', '<aside></aside>')).toBe('component')
    })
  })

  describe('asset — passive static resources', () => {
    it.each([
      ['app.js', 'asset'],
      ['vendor.mjs', 'asset'],
      ['logo.svg', 'asset'],
      ['hero.png', 'asset'],
      ['photo.jpg', 'asset'],
      ['font.woff2', 'asset'],
      ['data.json', 'asset'],
      ['LICENSE', 'asset'],
    ] as const)('classifies %s as %s', (path, role) => {
      expect(classifyDesignFile(path, undefined)).toBe(role)
    })
  })

  describe('unknown — honest fallback for unreadable HTML', () => {
    it('returns unknown for an HTML file with no inlined content', () => {
      expect(classifyDesignFile('mystery.html', undefined)).toBe('unknown')
    })
    it('returns unknown for an empty HTML file', () => {
      expect(classifyDesignFile('blank.html', '   \n  ')).toBe('unknown')
    })
  })

  // Exact shapes from the real `build-a-2-page-site-for` workspace, so a
  // regression here is caught against production output, not just synthetic
  // strings. (index/pricing open with `<!doctype html>`; parts open with a
  // bare element; styles.css is CSS.)
  describe('real product-design output', () => {
    it('labels the six files exactly', () => {
      expect(classifyDesignFile('index.html', '<!doctype html>\n<html lang="en"><head><link rel="stylesheet" href="styles.css"></head><body></body></html>')).toBe('page')
      expect(classifyDesignFile('pricing.html', '<!doctype html>\n<html lang="en"><body></body></html>')).toBe('page')
      expect(classifyDesignFile('parts/top-bar.html', '<header class="top-bar" data-cx-id="top-bar"></header>')).toBe('component')
      expect(classifyDesignFile('parts/footer.html', '<footer class="site-footer"></footer>')).toBe('component')
      expect(classifyDesignFile('parts/site-basics.html', '<div class="site-basics" data-cx-id="site-basics" aria-hidden="true"></div>')).toBe('component')
      expect(classifyDesignFile('styles.css', ':root { --bg: #f4f0e6; }')).toBe('stylesheet')
    })
  })
})

describe('htmlIsCompleteDocument', () => {
  it('is true for doctype/html roots, false for fragments', () => {
    expect(htmlIsCompleteDocument('<!doctype html><html></html>')).toBe(true)
    expect(htmlIsCompleteDocument('<html></html>')).toBe(true)
    expect(htmlIsCompleteDocument('<header></header>')).toBe(false)
    expect(htmlIsCompleteDocument('<div></div>')).toBe(false)
  })
})
