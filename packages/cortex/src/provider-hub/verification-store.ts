import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  VerificationEvidenceBundleSchema,
  parseVerificationEvidenceBundleText,
  verificationEvidenceBundleText,
  type VerificationEvidenceBundle,
} from './verification.js'

export interface VerificationEvidenceStoreState {
  readonly bundle: VerificationEvidenceBundle | null
  readonly status: 'active' | 'missing' | 'error'
  readonly warning?: string
}

export type AtomicVerificationWriter = (path: string, text: string) => Promise<void>

const MAX_VERIFICATION_PAYLOAD_BYTES = 32 * 1_024 * 1_024

/** Validated, atomic last-known-good storage for secret-free verification evidence. */
export class VerificationEvidenceStore {
  private active: VerificationEvidenceBundle | null = null

  constructor(
    private readonly path: string,
    private readonly atomicWriter: AtomicVerificationWriter = atomicWrite,
  ) {}

  async load(): Promise<VerificationEvidenceStoreState> {
    if (this.active != null) return { bundle: this.active, status: 'active' }
    try {
      const metadata = await stat(this.path)
      if (metadata.size > MAX_VERIFICATION_PAYLOAD_BYTES) {
        throw new Error('Verification evidence exceeds the payload limit')
      }
      const bundle = parseVerificationEvidenceBundleText(await readFile(this.path, 'utf8'))
      this.active = bundle
      return { bundle, status: 'active' }
    } catch (error) {
      if (isMissing(error)) return { bundle: null, status: 'missing' }
      return {
        bundle: null,
        status: 'error',
        warning: 'Provider verification evidence is invalid; no verification claims were loaded.',
      }
    }
  }

  async replace(candidate: unknown): Promise<VerificationEvidenceBundle> {
    const bundle = VerificationEvidenceBundleSchema.parse(candidate)
    await this.atomicWriter(this.path, verificationEvidenceBundleText(bundle))
    this.active = bundle
    return bundle
  }
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(tempPath, 'wx', 0o600)
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await rename(tempPath, path)
  } catch (error) {
    await handle?.close().catch(() => {})
    await unlink(tempPath).catch(() => {})
    throw error
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object'
    && error != null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
}
