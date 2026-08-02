import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const CORTEX_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const SOURCE_ROOT = join(CORTEX_ROOT, 'src')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : []
  })
}

function moduleReference(node: ts.Node): string | null {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      ? node.moduleSpecifier.text
      : null
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression &&
    ts.isStringLiteral(node.moduleReference.expression)
  ) {
    return node.moduleReference.expression.text
  }
  if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteral(node.argument.literal)
  ) {
    return node.argument.literal.text
  }
  if (
    ts.isCallExpression(node) &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0]!) &&
    (
      node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require')
    )
  ) {
    return node.arguments[0]!.text
  }
  return null
}

describe('SQLite storage architecture', () => {
  it('has exactly one production dependency edge to better-sqlite3', () => {
    const references: string[] = []
    for (const path of sourceFiles(SOURCE_ROOT)) {
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      )
      const visit = (node: ts.Node): void => {
        if (moduleReference(node) === 'better-sqlite3') {
          references.push(relative(CORTEX_ROOT, path))
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }

    expect(references).toEqual(['src/storage/sqlite-driver.ts'])
  })

  it('keeps raw compatibility accessors out of production callers', () => {
    const allowed = new Set([
      'src/gateway/db/database.ts',
      'src/gateway/state.ts',
      'src/storage/sqlite-adapter.ts',
    ])
    const escapes = new Set<string>()

    for (const path of sourceFiles(SOURCE_ROOT)) {
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      )
      const visit = (node: ts.Node): void => {
        if (
          ts.isIdentifier(node) &&
          ['rawDbHandle', 'rawDatabase', 'rawMainHandle'].includes(node.text)
        ) {
          escapes.add(relative(CORTEX_ROOT, path))
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }

    expect([...escapes].sort()).toEqual([...allowed].sort())
  })

  it('constructs the legacy database only inside the SQLite adapter', () => {
    const constructions: string[] = []
    for (const path of sourceFiles(SOURCE_ROOT)) {
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      )
      const visit = (node: ts.Node): void => {
        if (
          ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'CortexDatabase'
        ) {
          constructions.push(relative(CORTEX_ROOT, path))
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }

    expect(constructions).toEqual(['src/storage/sqlite-adapter.ts'])
  })
})
