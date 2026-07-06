/**
 * Test Sandbox
 *
 * Creates an isolated temporary workspace directory for tests that need
 * filesystem operations. Auto-cleanup on dispose.
 *
 * Every test that uses file tools (readFile, writeFile, editFile, glob, grep)
 * should create a sandbox to avoid polluting the real filesystem.
 */

import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Sandbox {
  /** Absolute path to the sandbox root directory. */
  readonly path: string

  /** Write a file relative to the sandbox root. Creates parent dirs. */
  writeFile(relativePath: string, content: string): Promise<void>

  /** Read a file relative to the sandbox root. */
  readFile(relativePath: string): Promise<string>

  /** Check if a file exists relative to the sandbox root. */
  exists(relativePath: string): boolean

  /** Create a directory relative to the sandbox root. */
  mkdir(relativePath: string): Promise<void>

  /** Create a realistic project structure for tool testing. */
  seedProject(): Promise<void>

  /** Remove the sandbox directory and all contents. */
  cleanup(): Promise<void>
}

// ---------------------------------------------------------------------------
// createSandbox
// ---------------------------------------------------------------------------

/**
 * Create an isolated temporary directory for test file operations.
 *
 * @param prefix - Optional prefix for the temp directory name.
 * @returns Sandbox instance with helper methods.
 */
export async function createSandbox(prefix = 'loom-test-'): Promise<Sandbox> {
  const path = await mkdtemp(join(tmpdir(), prefix))

  return {
    path,

    async writeFile(relativePath: string, content: string): Promise<void> {
      const fullPath = join(path, relativePath)
      const dir = fullPath.substring(0, fullPath.lastIndexOf('/'))
      if (dir && dir !== path) {
        await mkdir(dir, { recursive: true })
      }
      await writeFile(fullPath, content, 'utf-8')
    },

    async readFile(relativePath: string): Promise<string> {
      return readFile(join(path, relativePath), 'utf-8')
    },

    exists(relativePath: string): boolean {
      return existsSync(join(path, relativePath))
    },

    async mkdir(relativePath: string): Promise<void> {
      await mkdir(join(path, relativePath), { recursive: true })
    },

    async seedProject(): Promise<void> {
      // A minimal but realistic TypeScript project
      await this.writeFile('package.json', JSON.stringify({
        name: 'test-project',
        version: '1.0.0',
        type: 'module',
      }, null, 2))

      await this.writeFile('tsconfig.json', JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext' },
      }, null, 2))

      await this.writeFile('src/index.ts', [
        'export function greet(name: string): string {',
        '  return `Hello, ${name}!`',
        '}',
        '',
        'export function add(a: number, b: number): number {',
        '  return a + b',
        '}',
      ].join('\n'))

      await this.writeFile('src/utils.ts', [
        'export const VERSION = "1.0.0"',
        '',
        'export function capitalize(s: string): string {',
        '  return s.charAt(0).toUpperCase() + s.slice(1)',
        '}',
      ].join('\n'))

      await this.writeFile('tests/index.test.ts', [
        'import { greet, add } from "../src/index.js"',
        '',
        'test("greet", () => {',
        '  expect(greet("World")).toBe("Hello, World!")',
        '})',
        '',
        'test("add", () => {',
        '  expect(add(2, 3)).toBe(5)',
        '})',
      ].join('\n'))

      await this.writeFile('README.md', '# Test Project\n\nA minimal test project for Loom framework tests.\n')

      await this.writeFile('data/sample.txt', 'Line 1: The quick brown fox\nLine 2: jumps over the lazy dog\nLine 3: 42 is the answer\n')
    },

    async cleanup(): Promise<void> {
      await rm(path, { recursive: true, force: true })
    },
  }
}
