/**
 * Unit tests — minimal dotenv parser.
 *
 * Locks in every shape rule the runtime `.env` importer relies on so
 * subtle behaviour changes (escape handling, trailing comment boundary,
 * unterminated quote recovery) can't slip through silently.
 */

import { describe, it, expect } from 'vitest'
import { parseDotenv } from '../../../src/credential/dotenv.js'

describe('parseDotenv — basic shape', () => {
  it('parses KEY=value', () => {
    const { entries } = parseDotenv('FOO=bar')
    expect(entries).toEqual([{ key: 'FOO', value: 'bar', line: 1 }])
  })

  it('parses multiple lines', () => {
    const { entries } = parseDotenv('A=1\nB=2\nC=3')
    expect(entries.map(e => [e.key, e.value])).toEqual([
      ['A', '1'], ['B', '2'], ['C', '3'],
    ])
  })

  it('ignores blank lines and comment lines', () => {
    const { entries } = parseDotenv('\n\n# a comment\nKEY=value\n  \n')
    expect(entries).toEqual([{ key: 'KEY', value: 'value', line: 4 }])
  })

  it('handles CRLF input', () => {
    const { entries } = parseDotenv('A=1\r\nB=2\r\n')
    expect(entries.map(e => [e.key, e.value])).toEqual([['A', '1'], ['B', '2']])
  })

  it('allows empty values', () => {
    const { entries } = parseDotenv('EMPTY=\nBLANK=   ')
    expect(entries.map(e => [e.key, e.value])).toEqual([
      ['EMPTY', ''],
      ['BLANK', ''],
    ])
  })
})

describe('parseDotenv — quoting', () => {
  it('parses double-quoted values with escapes', () => {
    const { entries } = parseDotenv('KEY="a\\nb\\tc\\"d\\\\e"')
    expect(entries[0]!.value).toBe('a\nb\tc"d\\e')
  })

  it('parses single-quoted values as literals (no escapes)', () => {
    const { entries } = parseDotenv("KEY='a\\nb ${FOO}'")
    expect(entries[0]!.value).toBe('a\\nb ${FOO}')
  })

  it('preserves leading/trailing spaces inside quotes', () => {
    const { entries } = parseDotenv('KEY="  spaces  "')
    expect(entries[0]!.value).toBe('  spaces  ')
  })

  it('strips trailing inline comment from unquoted values only', () => {
    const { entries } = parseDotenv(
      'UNQUOTED=bar # comment\nQUOTED="bar # literal"\nHASHED=bar#notcomment',
    )
    expect(entries.map(e => [e.key, e.value])).toEqual([
      ['UNQUOTED', 'bar'],
      ['QUOTED', 'bar # literal'],
      ['HASHED', 'bar#notcomment'],
    ])
  })

  it('rejects unterminated double-quoted value', () => {
    const { entries, skippedLines } = parseDotenv('KEY="unterminated')
    expect(entries).toEqual([])
    expect(skippedLines).toEqual([1])
  })

  it('rejects unterminated single-quoted value', () => {
    const { entries, skippedLines } = parseDotenv("KEY='unterminated")
    expect(entries).toEqual([])
    expect(skippedLines).toEqual([1])
  })
})

describe('parseDotenv — decorations + malformed lines', () => {
  it('strips the `export ` prefix', () => {
    const { entries } = parseDotenv('export PATH=/usr/bin\nexport KEY="foo"')
    expect(entries.map(e => [e.key, e.value])).toEqual([
      ['PATH', '/usr/bin'],
      ['KEY', 'foo'],
    ])
  })

  it('preserves `=` chars inside the value', () => {
    const { entries } = parseDotenv('DATABASE_URL=postgres://u:p=asd@host/db')
    expect(entries[0]!.value).toBe('postgres://u:p=asd@host/db')
  })

  it('skips lines without an = sign', () => {
    const { entries, skippedLines } = parseDotenv('no_equals_here\nKEY=ok')
    expect(entries.map(e => e.key)).toEqual(['KEY'])
    expect(skippedLines).toEqual([1])
  })

  it('skips lines with an invalid KEY', () => {
    const { entries, skippedLines } = parseDotenv(
      '1BAD_KEY=value\nBAD-KEY=value\nGOOD_KEY=value\n',
    )
    expect(entries.map(e => e.key)).toEqual(['GOOD_KEY'])
    expect(skippedLines).toEqual([1, 2])
  })

  it('reports line numbers 1-based and contiguous', () => {
    const source = '# comment\nKEY=a\n\nOTHER=b\n'
    const { entries } = parseDotenv(source)
    expect(entries.map(e => [e.key, e.line])).toEqual([
      ['KEY', 2],
      ['OTHER', 4],
    ])
  })
})

describe('parseDotenv — realistic workspace .env', () => {
  it('parses a representative file end-to-end', () => {
    const source = [
      '# App config',
      'NODE_ENV=development',
      'PORT=3000',
      '',
      '# Secrets',
      'DATABASE_URL="postgres://user:pw@host:5432/db?sslmode=require"',
      'JWT_SECRET=\'very-literal-value\'',
      'API_KEY=sk_live_abcdef # do not commit',
      '',
      'export SENDGRID_KEY="key-abc-123"',
    ].join('\n')

    const { entries, skippedLines } = parseDotenv(source)
    expect(skippedLines).toEqual([])
    const map = new Map(entries.map(e => [e.key, e.value]))
    expect(map.get('NODE_ENV')).toBe('development')
    expect(map.get('PORT')).toBe('3000')
    expect(map.get('DATABASE_URL')).toBe('postgres://user:pw@host:5432/db?sslmode=require')
    expect(map.get('JWT_SECRET')).toBe('very-literal-value')
    expect(map.get('API_KEY')).toBe('sk_live_abcdef')
    expect(map.get('SENDGRID_KEY')).toBe('key-abc-123')
  })
})
