import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

describe('public gateway storage option types', () => {
  it('compile valid options and reject conflicting or unknown selections', () => {
    const directory = dirname(fileURLToPath(import.meta.url))
    const packageRoot = resolve(directory, '../../..')
    const configPath = resolve(packageRoot, 'tsconfig.json')
    const fixturePath = resolve(directory, 'gateway-public-storage-options.compile.ts')
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile)
    expect(loaded.error).toBeUndefined()
    const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, packageRoot)
    const program = ts.createProgram({
      rootNames: [fixturePath],
      options: {
        ...parsed.options,
        baseUrl: packageRoot,
        paths: {
          ...parsed.options.paths,
          '@ownware/cortex': ['./src/index.ts'],
        },
        rootDir: undefined,
        outDir: undefined,
        declaration: false,
        declarationMap: false,
        sourceMap: false,
        noEmit: true,
      },
    })
    const diagnostics = ts.getPreEmitDiagnostics(program)
    const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => packageRoot,
      getNewLine: () => '\n',
    })

    expect(formatted).toBe('')
  })
})
