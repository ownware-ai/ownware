import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  POSTGRESQL_BASELINE_DDL_HASH,
  POSTGRESQL_BASELINE_MANIFEST,
  POSTGRESQL_BASELINE_SQL,
  POSTGRESQL_BASELINE_SUMMARY,
} from '../../../src/storage/postgresql-baseline.js'
import { isSupportedPostgreSqlVersion } from '../../../src/storage/postgresql-adapter.js'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const SOURCE_ROOT = join(TEST_DIR, '../../../src')

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

async function sourceFiles(root: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && path.endsWith('.ts') ? [path] : []
  }))
  return nested.flat()
}

describe('PostgreSQL generated baseline', () => {
  it('has deterministic generated hashes and the full logical authority cardinality', () => {
    expect(sha256(POSTGRESQL_BASELINE_SQL)).toBe(POSTGRESQL_BASELINE_DDL_HASH)
    expect(POSTGRESQL_BASELINE_SUMMARY).toEqual({
      tableCount: 59,
      columnCount: 689,
      foreignKeyCount: 50,
      uniqueConstraintCount: 19,
      explicitIndexCount: 91,
      triggerCount: 6,
    })
    expect(POSTGRESQL_BASELINE_MANIFEST.columns).toHaveLength(689)
    expect(new Set(POSTGRESQL_BASELINE_MANIFEST.columns.map((column) => column.table)).size)
      .toBe(59)
  })

  it('contains PostgreSQL-native types and checks without leaked SQLite dialect', () => {
    expect(POSTGRESQL_BASELINE_SQL).toContain('DOUBLE PRECISION')
    expect(POSTGRESQL_BASELINE_SQL).toContain(' IS JSON')
    expect(POSTGRESQL_BASELINE_SQL).not.toMatch(/\bGLOB\b|json_valid\(|datetime\('now'\)|AUTOINCREMENT/i)
    expect(POSTGRESQL_BASELINE_SQL).not.toContain('better-sqlite3')
    expect(POSTGRESQL_BASELINE_SQL).not.toContain('postgresql://')
  })

  it('pins the certified current-minor floor and rejects unknown majors', () => {
    expect(isSupportedPostgreSqlVersion(160_013)).toBe(false)
    expect(isSupportedPostgreSqlVersion(160_014)).toBe(true)
    expect(isSupportedPostgreSqlVersion(170_009)).toBe(false)
    expect(isSupportedPostgreSqlVersion(170_010)).toBe(true)
    expect(isSupportedPostgreSqlVersion(180_003)).toBe(false)
    expect(isSupportedPostgreSqlVersion(180_004)).toBe(true)
    expect(isSupportedPostgreSqlVersion(190_000)).toBe(false)
    expect(isSupportedPostgreSqlVersion(Number.NaN)).toBe(false)
  })

  it('keeps the optional pg import in one lazy driver module', async () => {
    const edges: Array<{ readonly file: string; readonly kind: string }> = []
    for (const file of await sourceFiles(SOURCE_ROOT)) {
      const source = await readFile(file, 'utf8')
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node): void => {
        if (
          ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text === 'pg'
        ) {
          edges.push({ file, kind: node.importClause?.isTypeOnly === true ? 'type' : 'static' })
        }
        if (
          ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) &&
          ts.isStringLiteral(node.argument.literal) && node.argument.literal.text === 'pg'
        ) {
          edges.push({ file, kind: 'type' })
        }
        if (
          ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments[0] !== undefined && ts.isStringLiteral(node.arguments[0]) &&
          node.arguments[0].text === 'pg'
        ) {
          edges.push({ file, kind: 'dynamic' })
        }
        ts.forEachChild(node, visit)
      }
      visit(parsed)
    }

    expect(new Set(edges.map((edge) => edge.file))).toEqual(new Set([
      join(SOURCE_ROOT, 'storage/postgresql-driver.ts'),
    ]))
    expect(edges.some((edge) => edge.kind === 'static')).toBe(false)
    expect(edges.filter((edge) => edge.kind === 'dynamic')).toHaveLength(1)
  })
})
