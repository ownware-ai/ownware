/**
 * Session persistence for `--resume`: remembers the last thread per
 * (cwd, profile) so tomorrow's `ownware-cli --resume` continues today's
 * conversation.
 *
 * Lives under the SAME dataDir the gateway uses (`<dataDir>/cli/
 * sessions.json`), so a test that isolates the gateway into a temp
 * dataDir automatically isolates the CLI's session state too — nothing
 * ever touches the real `~/.ownware` from a test (repo guardrail #4).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

interface SessionEntry {
  readonly threadId: string
  readonly updatedAt: string
}

type SessionFile = Record<string, SessionEntry>

export class SessionStore {
  private readonly file: string

  constructor(dataDir: string) {
    this.file = join(dataDir, 'cli', 'sessions.json')
  }

  private key(cwd: string, profileId: string): string {
    return `${cwd}::${profileId}`
  }

  private readAll(): SessionFile {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf-8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as SessionFile
      }
    } catch {
      // Missing or corrupt file — start fresh; resume is best-effort.
    }
    return {}
  }

  lastThread(cwd: string, profileId: string): string | null {
    return this.readAll()[this.key(cwd, profileId)]?.threadId ?? null
  }

  saveThread(cwd: string, profileId: string, threadId: string): void {
    const all = this.readAll()
    all[this.key(cwd, profileId)] = { threadId, updatedAt: new Date().toISOString() }
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(all, null, 2) + '\n', 'utf-8')
  }
}
