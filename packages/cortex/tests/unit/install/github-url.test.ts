/**
 * Unit tests for the GitHub URL parser + safety allowlist.
 *
 * These tests are the security gate for accepting external URLs into the
 * install pipeline. Any new URL form that should be accepted MUST land
 * here before the parser changes; any new rejection MUST also land here.
 */

import { describe, it, expect } from 'vitest'
import {
  parseGithubUrl,
  toCloneUrl,
  namespacedDirPrefix,
  displayName,
} from '../../../src/profile/install/github-url.js'
import { InstallError, isInstallError } from '../../../src/profile/install/errors.js'

describe('parseGithubUrl: accepted forms', () => {
  it('parses bare https URL', () => {
    const got = parseGithubUrl('https://github.com/acme/finance')
    expect(got).toEqual({ owner: 'acme', repo: 'finance' })
  })

  it('strips .git suffix', () => {
    const got = parseGithubUrl('https://github.com/acme/finance.git')
    expect(got).toEqual({ owner: 'acme', repo: 'finance' })
  })

  it('tolerates trailing slash', () => {
    const got = parseGithubUrl('https://github.com/acme/finance/')
    expect(got).toEqual({ owner: 'acme', repo: 'finance' })
  })

  it('parses /tree/<ref> form', () => {
    const got = parseGithubUrl('https://github.com/acme/finance/tree/v1.0.0')
    expect(got).toEqual({ owner: 'acme', repo: 'finance', ref: 'v1.0.0' })
  })

  it('parses ?ref=<ref> form', () => {
    const got = parseGithubUrl('https://github.com/acme/finance?ref=develop')
    expect(got).toEqual({ owner: 'acme', repo: 'finance', ref: 'develop' })
  })

  it('prefers /tree/ over ?ref= when both present', () => {
    const got = parseGithubUrl('https://github.com/acme/finance/tree/v1?ref=develop')
    expect(got.ref).toBe('v1')
  })

  it('accepts dotted owner', () => {
    const got = parseGithubUrl('https://github.com/anth.ropic/cortex')
    expect(got.owner).toBe('anth.ropic')
  })

  it('accepts hyphenated repo', () => {
    const got = parseGithubUrl('https://github.com/ownware/profiles-index')
    expect(got.repo).toBe('profiles-index')
  })

  it('accepts underscore repo', () => {
    const got = parseGithubUrl('https://github.com/ownware/some_repo')
    expect(got.repo).toBe('some_repo')
  })

  it('case-insensitive host matching', () => {
    const got = parseGithubUrl('https://GitHub.com/acme/finance')
    expect(got).toEqual({ owner: 'acme', repo: 'finance' })
  })
})

describe('parseGithubUrl: rejected forms (security gate)', () => {
  function assertInvalid(url: string): void {
    let caught: unknown
    try {
      parseGithubUrl(url)
    } catch (err) {
      caught = err
    }
    expect(isInstallError(caught)).toBe(true)
    expect((caught as InstallError).code).toBe('invalid_url')
  }

  it('rejects empty string', () => assertInvalid(''))
  it('rejects whitespace-only', () => assertInvalid('   '))
  it('rejects garbage', () => assertInvalid('not a url'))

  // Scheme allowlist
  it('rejects http (downgrade)', () => assertInvalid('http://github.com/acme/finance'))
  it('rejects ssh', () => assertInvalid('ssh://git@github.com/acme/finance'))
  it('rejects git protocol', () => assertInvalid('git://github.com/acme/finance.git'))
  it('rejects file scheme', () => assertInvalid('file:///etc/passwd'))
  it('rejects javascript scheme', () => assertInvalid('javascript:alert(1)'))
  it('rejects data scheme', () => assertInvalid('data:text/plain,foo'))

  // Userinfo
  it('rejects userinfo embedded in URL', () => {
    assertInvalid('https://user:token@github.com/acme/finance')
  })

  // Host allowlist
  it('rejects raw IP', () => assertInvalid('https://1.2.3.4/acme/finance'))
  it('rejects gitlab', () => assertInvalid('https://gitlab.com/acme/finance'))
  it('rejects gist.github.com', () => assertInvalid('https://gist.github.com/acme/abc'))
  it('rejects raw.githubusercontent', () => {
    assertInvalid('https://raw.githubusercontent.com/acme/finance/main/agent.json')
  })
  it('rejects api.github.com', () => assertInvalid('https://api.github.com/repos/acme/finance'))
  it('rejects github.com.evil.test', () => {
    assertInvalid('https://github.com.evil.test/acme/finance')
  })
  it('rejects evil.github.com (subdomain attack)', () => {
    assertInvalid('https://evil.github.com/acme/finance')
  })

  // Port
  it('rejects custom port', () => assertInvalid('https://github.com:8443/acme/finance'))

  // Path shape
  it('rejects path with only owner', () => assertInvalid('https://github.com/acme'))
  it('rejects empty path', () => assertInvalid('https://github.com'))
  it('rejects deeper path that is not /tree/<ref>', () => {
    assertInvalid('https://github.com/acme/finance/blob/main/file')
  })
  it('rejects /enterprise/<host>/<owner>/<repo>', () => {
    assertInvalid('https://github.com/enterprise/internal/acme/finance')
  })

  // Names
  it('rejects owner starting with hyphen', () => assertInvalid('https://github.com/-evil/finance'))
  it('rejects repo containing ..', () => assertInvalid('https://github.com/acme/fi..nance'))
  it('rejects owner containing space (URL-encoded)', () => {
    assertInvalid('https://github.com/some%20owner/finance')
  })
  it('rejects very long owner', () => {
    assertInvalid(`https://github.com/${'a'.repeat(40)}/finance`)
  })

  // Refs
  it('rejects ref starting with hyphen (CLI flag injection guard)', () => {
    assertInvalid('https://github.com/acme/finance?ref=-rf')
  })
  it('rejects ref containing whitespace', () => {
    assertInvalid('https://github.com/acme/finance?ref=evil%20ref')
  })
  it('rejects ref containing ..', () => {
    assertInvalid('https://github.com/acme/finance?ref=v1..v2')
  })
  it('rejects /tree/ with empty ref', () => {
    assertInvalid('https://github.com/acme/finance/tree/')
  })
})

describe('toCloneUrl', () => {
  it('always emits canonical .git URL, no ref', () => {
    expect(toCloneUrl({ owner: 'acme', repo: 'finance', ref: 'v1' })).toBe(
      'https://github.com/acme/finance.git',
    )
  })
  it('strips no-op when input had no ref', () => {
    expect(toCloneUrl({ owner: 'a', repo: 'b' })).toBe('https://github.com/a/b.git')
  })
})

describe('namespacedDirPrefix and displayName', () => {
  it('produces filesystem-safe namespace', () => {
    expect(namespacedDirPrefix({ owner: 'acme', repo: 'finance' })).toBe('acme__finance')
  })
  it('display name is owner/repo', () => {
    expect(displayName({ owner: 'acme', repo: 'finance' })).toBe('acme/finance')
  })
})
