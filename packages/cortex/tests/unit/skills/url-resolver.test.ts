/**
 * Unit tests for the skill URL resolver.
 */

import { describe, it, expect } from 'vitest'
import {
  resolveSkillUrl,
  SkillUrlError,
  type SkillUrlErrorCode,
} from '../../../src/profile/skills/url-resolver.js'

function expectError(
  fn: () => unknown,
  code: SkillUrlErrorCode,
): void {
  try {
    fn()
    throw new Error('expected SkillUrlError to be thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(SkillUrlError)
    expect((err as SkillUrlError).code).toBe(code)
  }
}

// ---------------------------------------------------------------------------
// GitHub blob URLs
// ---------------------------------------------------------------------------

describe('resolveSkillUrl — GitHub blob', () => {
  it('converts a github.com blob URL to a raw URL', () => {
    const result = resolveSkillUrl(
      'https://github.com/foo/bar/blob/main/skills/x.md',
    )
    expect(result.canonical).toBe(
      'https://raw.githubusercontent.com/foo/bar/main/skills/x.md',
    )
    expect(result.origin).toBe('github')
    expect(result.displayHint).toBe('github.com/foo/bar')
  })

  it('preserves nested paths and branch names with slashes', () => {
    const result = resolveSkillUrl(
      'https://github.com/foo/bar/blob/release/v1/deep/skills/x.md',
    )
    expect(result.canonical).toBe(
      'https://raw.githubusercontent.com/foo/bar/release/v1/deep/skills/x.md',
    )
  })

  it('rejects a blob URL that does not point to a .md file', () => {
    expectError(
      () => resolveSkillUrl('https://github.com/foo/bar/blob/main/README.txt'),
      'UNSUPPORTED_HOST',
    )
  })

  it('rejects a github.com URL that is neither blob, tree, nor repo', () => {
    expectError(
      () => resolveSkillUrl('https://github.com/foo/bar/issues/42'),
      'UNSUPPORTED_HOST',
    )
    expectError(
      () => resolveSkillUrl('https://github.com/foo/bar/pulls'),
      'UNSUPPORTED_HOST',
    )
  })
})

// ---------------------------------------------------------------------------
// GitHub raw URLs
// ---------------------------------------------------------------------------

describe('resolveSkillUrl — GitHub raw', () => {
  it('passes through a raw.githubusercontent.com URL ending in .md', () => {
    const url = 'https://raw.githubusercontent.com/foo/bar/main/skills/x.md'
    const result = resolveSkillUrl(url)
    expect(result.canonical).toBe(url)
    expect(result.origin).toBe('github')
    expect(result.displayHint).toBe('github.com/foo/bar')
  })

  it('rejects a raw URL that is not a .md file', () => {
    expectError(
      () =>
        resolveSkillUrl(
          'https://raw.githubusercontent.com/foo/bar/main/README.txt',
        ),
      'UNSUPPORTED_HOST',
    )
  })
})

// ---------------------------------------------------------------------------
// Gist URLs
// ---------------------------------------------------------------------------

describe('resolveSkillUrl — gist', () => {
  it('passes through a gist.githubusercontent.com raw URL', () => {
    const url =
      'https://gist.githubusercontent.com/alice/abc123def/raw/0011/skill.md'
    const result = resolveSkillUrl(url)
    expect(result.canonical).toBe(url)
    expect(result.origin).toBe('gist-raw')
    expect(result.displayHint).toBe('gist.github.com')
  })

  it('rejects a gist raw URL that is not a .md file', () => {
    expectError(
      () =>
        resolveSkillUrl(
          'https://gist.githubusercontent.com/alice/abc/raw/00/x.txt',
        ),
      'UNSUPPORTED_HOST',
    )
  })

  it('converts a gist.github.com page URL to the API URL', () => {
    const result = resolveSkillUrl('https://gist.github.com/alice/abc123def')
    expect(result.canonical).toBe('https://api.github.com/gists/abc123def')
    expect(result.origin).toBe('gist-page')
    expect(result.gistId).toBe('abc123def')
    expect(result.gistFileHint).toBeUndefined()
  })

  it('captures the file anchor on a gist page URL', () => {
    const result = resolveSkillUrl(
      'https://gist.github.com/alice/abc123def#file-skill-md',
    )
    expect(result.gistFileHint).toBe('skill-md')
  })

  it('rejects a malformed gist URL', () => {
    expectError(
      () => resolveSkillUrl('https://gist.github.com/'),
      'UNSUPPORTED_HOST',
    )
  })
})

// ---------------------------------------------------------------------------
// Plain raw .md URLs
// ---------------------------------------------------------------------------

describe('resolveSkillUrl — plain raw .md', () => {
  it('accepts a plain HTTPS URL ending in .md', () => {
    const url = 'https://example.com/path/to/skill.md'
    const result = resolveSkillUrl(url)
    expect(result.canonical).toBe(url)
    expect(result.origin).toBe('raw')
    expect(result.displayHint).toBe('example.com')
  })

  it('rejects a URL that does not end in .md', () => {
    expectError(
      () => resolveSkillUrl('https://example.com/path/to/skill.txt'),
      'UNSUPPORTED_HOST',
    )
  })
})

// ---------------------------------------------------------------------------
// Scheme + host rejection
// ---------------------------------------------------------------------------

describe('resolveSkillUrl — rejection', () => {
  it('rejects empty input', () => {
    expectError(() => resolveSkillUrl(''), 'INVALID_URL')
    expectError(() => resolveSkillUrl('   '), 'INVALID_URL')
  })

  it('rejects malformed URLs', () => {
    expectError(() => resolveSkillUrl('not a url'), 'INVALID_URL')
    expectError(() => resolveSkillUrl('https://'), 'INVALID_URL')
  })

  it('rejects non-HTTPS schemes', () => {
    expectError(
      () => resolveSkillUrl('http://example.com/skill.md'),
      'UNSUPPORTED_SCHEME',
    )
    expectError(
      () => resolveSkillUrl('ftp://example.com/skill.md'),
      'UNSUPPORTED_SCHEME',
    )
    expectError(
      () => resolveSkillUrl('file:///etc/passwd'),
      'UNSUPPORTED_SCHEME',
    )
  })

  it('rejects localhost', () => {
    expectError(
      () => resolveSkillUrl('https://localhost/skill.md'),
      'PRIVATE_HOST',
    )
    expectError(
      () => resolveSkillUrl('https://foo.localhost/skill.md'),
      'PRIVATE_HOST',
    )
  })

  it('rejects RFC 1918 private IPv4 addresses', () => {
    expectError(
      () => resolveSkillUrl('https://10.0.0.1/skill.md'),
      'PRIVATE_HOST',
    )
    expectError(
      () => resolveSkillUrl('https://172.16.5.4/skill.md'),
      'PRIVATE_HOST',
    )
    expectError(
      () => resolveSkillUrl('https://172.31.0.1/skill.md'),
      'PRIVATE_HOST',
    )
    expectError(
      () => resolveSkillUrl('https://192.168.1.1/skill.md'),
      'PRIVATE_HOST',
    )
  })

  it('rejects link-local + loopback IPv4', () => {
    expectError(
      () => resolveSkillUrl('https://127.0.0.1/skill.md'),
      'PRIVATE_HOST',
    )
    expectError(
      () => resolveSkillUrl('https://169.254.169.254/skill.md'),
      'PRIVATE_HOST',
    )
  })

  it('allows public IPv4 addresses outside the private ranges', () => {
    const result = resolveSkillUrl('https://8.8.8.8/skill.md')
    expect(result.origin).toBe('raw')
  })

  it('rejects multicast and reserved IPv4 ranges', () => {
    expectError(
      () => resolveSkillUrl('https://224.0.0.1/skill.md'),
      'PRIVATE_HOST',
    )
    expectError(
      () => resolveSkillUrl('https://0.0.0.0/skill.md'),
      'PRIVATE_HOST',
    )
  })

  it('rejects IPv6 loopback + unique-local + link-local', () => {
    expectError(
      () => resolveSkillUrl('https://[::1]/skill.md'),
      'PRIVATE_HOST',
    )
    expectError(
      () => resolveSkillUrl('https://[fc00::1]/skill.md'),
      'PRIVATE_HOST',
    )
    expectError(
      () => resolveSkillUrl('https://[fe80::1]/skill.md'),
      'PRIVATE_HOST',
    )
  })
})

// ---------------------------------------------------------------------------
// GitHub repo / tree (list mode)
// ---------------------------------------------------------------------------

describe('resolveSkillUrl — github repo (list mode)', () => {
  it('accepts a bare repo URL and points at the tree API', () => {
    const result = resolveSkillUrl('https://github.com/foo/bar')
    expect(result.origin).toBe('github-repo')
    expect(result.canonical).toBe(
      'https://api.github.com/repos/foo/bar/git/trees/HEAD?recursive=1',
    )
    expect(result.owner).toBe('foo')
    expect(result.repo).toBe('bar')
    expect(result.ref).toBe('HEAD')
    expect(result.subpath).toBeUndefined()
  })

  it('accepts a repo URL with trailing slash', () => {
    const result = resolveSkillUrl('https://github.com/foo/bar/')
    expect(result.origin).toBe('github-repo')
  })

  it('rejects reserved UI surfaces masquerading as a repo', () => {
    expectError(
      () => resolveSkillUrl('https://github.com/orgs/foo'),
      'UNSUPPORTED_HOST',
    )
    expectError(
      () => resolveSkillUrl('https://github.com/marketplace/widget'),
      'UNSUPPORTED_HOST',
    )
  })
})

describe('resolveSkillUrl — github tree (list mode w/ subpath)', () => {
  it('captures branch and subpath', () => {
    const result = resolveSkillUrl(
      'https://github.com/foo/bar/tree/main/finance',
    )
    expect(result.origin).toBe('github-tree')
    expect(result.canonical).toBe(
      'https://api.github.com/repos/foo/bar/git/trees/main?recursive=1',
    )
    expect(result.owner).toBe('foo')
    expect(result.repo).toBe('bar')
    expect(result.ref).toBe('main')
    expect(result.subpath).toBe('finance')
  })

  it('handles deep subpaths', () => {
    const result = resolveSkillUrl(
      'https://github.com/foo/bar/tree/main/finance/compliance',
    )
    expect(result.subpath).toBe('finance/compliance')
  })

  it('handles tree at branch root (no subpath)', () => {
    const result = resolveSkillUrl('https://github.com/foo/bar/tree/release-1.2')
    expect(result.origin).toBe('github-tree')
    expect(result.ref).toBe('release-1.2')
    expect(result.subpath).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Hygiene
// ---------------------------------------------------------------------------

describe('resolveSkillUrl — hygiene', () => {
  it('trims leading/trailing whitespace', () => {
    const result = resolveSkillUrl(
      '  https://github.com/foo/bar/blob/main/x.md  ',
    )
    expect(result.canonical).toBe(
      'https://raw.githubusercontent.com/foo/bar/main/x.md',
    )
  })

  it('treats hostnames case-insensitively', () => {
    const result = resolveSkillUrl(
      'https://GitHub.com/foo/bar/blob/main/x.md',
    )
    expect(result.origin).toBe('github')
  })
})
