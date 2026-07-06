/**
 * Read-only update check.
 *
 * For a `kind: 'github'` profile dir:
 *   1. Read its sidecar → get `repoUrl` + `ref` + `commit` + maybe `installedHash`
 *   2. Run `git ls-remote <repoUrl> <ref>` to get the current remote head
 *   3. Compare to `commit`
 *   4. If different, also run `detectLocalEdits` to flag user changes
 *
 * Never clones. Never writes. Network failure / repo deleted / repo
 * went private map cleanly to `'source-unavailable'` so the UI can
 * surface a calm message instead of a stack trace.
 *
 * Sidecars of `kind: 'fork'` or `'builtin-bundle'` return `'not-trackable'`
 * — the registry's existing fork/hash machinery handles forks; builtins
 * update via app releases.
 *
 * No-sidecar dirs return `'not-trackable'` too; the registry doesn't
 * speak for dirs we don't recognise.
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ORIGIN_SIDECAR_FILE,
  parseOriginSidecar,
  type OriginSidecar,
} from '../registry.js'
import { detectLocalEdits, type LocalEditsState } from './local-edits.js'

export type UpdateState =
  | { readonly state: 'up-to-date'; readonly sidecar: OriginSidecar }
  | {
      readonly state: 'update-available'
      readonly sidecar: OriginSidecar
      readonly localEdits: LocalEditsState
      /** Where the user can read what changed (GitHub compare URL).
       *  Built from `repoUrl` + `commit` + remote head. */
      readonly compareUrl: string
      /** The new remote head sha. Used by apply-update to short-circuit
       *  re-clones if it matches the install attempt. */
      readonly remoteCommit: string
    }
  | { readonly state: 'source-unavailable'; readonly sidecar: OriginSidecar; readonly reason: string }
  | { readonly state: 'not-trackable' }

export interface CheckUpdateOptions {
  readonly profileDir: string
  /** Override the `git` binary (test hook). */
  readonly gitBinary?: string
  /** ls-remote timeout. Default 15s. */
  readonly timeoutMs?: number
}

export async function checkProfileUpdate(opts: CheckUpdateOptions): Promise<UpdateState> {
  const sidecar = await readSidecar(opts.profileDir)
  if (sidecar === null) return { state: 'not-trackable' }
  if (sidecar.kind !== 'github') return { state: 'not-trackable' }

  const remote = await lsRemote({
    repoUrl: sidecar.repoUrl,
    ref: sidecar.ref,
    gitBinary: opts.gitBinary ?? 'git',
    timeoutMs: opts.timeoutMs ?? 15_000,
  })

  if (remote.kind === 'unavailable') {
    return { state: 'source-unavailable', sidecar, reason: remote.reason }
  }

  if (remote.commit === sidecar.commit) {
    return { state: 'up-to-date', sidecar }
  }

  const localEdits = await detectLocalEdits(opts.profileDir, sidecar)
  return {
    state: 'update-available',
    sidecar,
    localEdits,
    remoteCommit: remote.commit,
    compareUrl: buildCompareUrl(sidecar.repoUrl, sidecar.commit, remote.commit),
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function readSidecar(profileDir: string): Promise<OriginSidecar | null> {
  let raw: string
  try {
    raw = await readFile(join(profileDir, ORIGIN_SIDECAR_FILE), 'utf-8')
  } catch {
    return null
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  return parseOriginSidecar(parsed)
}

interface LsRemoteResult {
  readonly kind: 'ok'
  readonly commit: string
}
interface LsRemoteUnavailable {
  readonly kind: 'unavailable'
  readonly reason: string
}

async function lsRemote(args: {
  repoUrl: string
  ref: string
  gitBinary: string
  timeoutMs: number
}): Promise<LsRemoteResult | LsRemoteUnavailable> {
  return new Promise((resolveP) => {
    const child = spawn(
      args.gitBinary,
      ['ls-remote', '--heads', '--tags', '--exit-code', '--', args.repoUrl, args.ref],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: 'echo',
          SSH_ASKPASS: 'echo',
          LC_ALL: 'C',
          LANG: 'C',
        },
      },
    )

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, args.timeoutMs)

    child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf-8') })
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf-8') })

    child.on('error', (err) => {
      clearTimeout(timer)
      resolveP({ kind: 'unavailable', reason: err.message })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        resolveP({ kind: 'unavailable', reason: 'ls-remote timed out' })
        return
      }
      // exit code 2 from --exit-code means "ref not found"
      // exit code 128 typically means "auth required" / "not found"
      if (code !== 0) {
        resolveP({ kind: 'unavailable', reason: stderr.trim().split('\n')[0] ?? `git exit ${code}` })
        return
      }
      // ls-remote line: "<sha>\t<refname>". The ref we asked for might
      // resolve to multiple lines (e.g., "main" matching both heads/main
      // and tags/main); take the first.
      const firstLine = stdout.split('\n').find((l) => l.trim().length > 0) ?? ''
      const [sha] = firstLine.split('\t')
      if (sha === undefined || sha.length === 0) {
        resolveP({ kind: 'unavailable', reason: 'empty ls-remote output' })
        return
      }
      resolveP({ kind: 'ok', commit: sha.trim() })
    })
  })
}

/**
 * GitHub compare URL for a UI "What changed" link. Falls back to a plain
 * commit URL if the repoUrl shape is unfamiliar (still useful — the user
 * can navigate from there).
 */
function buildCompareUrl(repoUrl: string, fromCommit: string, toCommit: string): string {
  // Strip ".git" if present, and translate `https://github.com/<owner>/<repo>.git`
  // → `https://github.com/<owner>/<repo>/compare/<from>...<to>`
  const trimmed = repoUrl.endsWith('.git') ? repoUrl.slice(0, -4) : repoUrl
  return `${trimmed}/compare/${fromCommit}...${toCommit}`
}
