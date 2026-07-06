/**
 * Gateway TLS — self-signed loopback certificate provisioning.
 *
 * Why this exists
 * ---------------------------------------------------------------------
 * HTTP/2 in browsers — and Chromium, which is Electron's renderer —
 * requires TLS. There is no cleartext-h2 path a browser will accept.
 * The gateway serves HTTP/2 (gateway-perf-2026-06-13) to escape the
 * browser's 6-connection-per-origin HTTP/1.1 cap that was stalling
 * local data loads for ~18s during a heavy run. So we need a cert.
 *
 * Security posture (the cert is a formality, not a network defense)
 * ---------------------------------------------------------------------
 * The gateway binds ONLY to 127.0.0.1 (loopback). There is no network
 * peer to authenticate and no wire to eavesdrop — TLS here exists solely
 * to unlock HTTP/2 multiplexing. The cert is therefore self-signed.
 *
 *   - PER-INSTALL: a unique private key is generated on first run, so no
 *     secret is shipped in the app bundle.
 *   - ON-DEVICE ONLY: key + cert live under <dataDir>/tls/ with 0600
 *     perms and are NEVER transmitted.
 *   - PINNED TRUST: Electron trusts ONLY this cert (by SHA-256
 *     fingerprint) for ONLY 127.0.0.1; every other origin keeps
 *     Chromium's normal verification (pinning lives in the desktop
 *     client's Electron main process).
 *
 * Desktop-only: the future BYO-cloud packaging is network-exposed and
 * MUST use a real CA cert / platform TLS termination — not this module.
 */

import forge from 'node-forge'
import { X509Certificate, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface GatewayTls {
  /** PEM-encoded RSA private key. */
  readonly key: string
  /** PEM-encoded self-signed certificate. */
  readonly cert: string
  /**
   * SHA-256 fingerprint in colon-hex form (e.g. "AB:CD:…") — the exact
   * shape Chromium reports to Electron's `setCertificateVerifyProc`, so
   * the main process can pin-compare without reformatting.
   */
  readonly fingerprint256: string
}

const VALIDITY_YEARS = 2
/** Rotate when the existing cert is missing or within 30 days of expiry. */
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Return a usable loopback cert for the gateway, generating + persisting
 * one on first run (or when the existing pair is missing, unreadable, or
 * near expiry). Synchronous: it runs once at startup before listen().
 *
 * `tlsDir` is the directory the key + cert pair lives in (the gateway passes
 * `<dataDir>/tls`, which is also where Electron reads the cert to pin-trust).
 */
export function ensureGatewayCert(tlsDir: string): GatewayTls {
  const keyPath = join(tlsDir, 'gateway-key.pem')
  const certPath = join(tlsDir, 'gateway-cert.pem')

  const existing = readExisting(keyPath, certPath)
  if (existing) return existing

  const fresh = generate()
  mkdirSync(tlsDir, { recursive: true })
  // 0600: readable only by the owning user. The directory is created
  // with default perms; the key file is the secret and gets locked down.
  writeFileSync(keyPath, fresh.key, { mode: 0o600 })
  writeFileSync(certPath, fresh.cert, { mode: 0o600 })
  return fresh
}

function readExisting(keyPath: string, certPath: string): GatewayTls | null {
  if (!existsSync(keyPath) || !existsSync(certPath)) return null
  try {
    const key = readFileSync(keyPath, 'utf8')
    const cert = readFileSync(certPath, 'utf8')
    const x509 = new X509Certificate(cert)
    const notAfter = Date.parse(x509.validTo)
    if (Number.isNaN(notAfter) || notAfter - Date.now() < RENEW_BEFORE_MS) {
      return null // expired / near-expiry → caller regenerates
    }
    return { key, cert, fingerprint256: x509.fingerprint256 }
  } catch {
    // Unreadable or corrupt PEM → regenerate rather than crash the gateway.
    return null
  }
}

function generate(): GatewayTls {
  // Generate the RSA key with Node's NATIVE crypto (~7ms) — node-forge's
  // pure-JS keygen takes 1–4s and would hang first launch + bloat tests.
  // node-forge is used only to assemble + sign the X.509 structure, which
  // it does in milliseconds.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string
  const forgePriv = forge.pki.privateKeyFromPem(keyPem)
  const forgePub = forge.pki.setRsaPublicKey(forgePriv.n, forgePriv.e)

  const cert = forge.pki.createCertificate()
  cert.publicKey = forgePub
  cert.serialNumber = randomSerial()
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.validity.notAfter.setFullYear(
    cert.validity.notBefore.getFullYear() + VALIDITY_YEARS,
  )
  const attrs = [{ name: 'commonName', value: 'localhost' }]
  cert.setSubject(attrs)
  cert.setIssuer(attrs) // self-signed: issuer == subject
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' }, // type 2 = DNS name
        { type: 7, ip: '127.0.0.1' }, // type 7 = IP address
      ],
    },
  ])
  cert.sign(forgePriv, forge.md.sha256.create())

  const certPem = forge.pki.certificateToPem(cert)
  const fingerprint256 = new X509Certificate(certPem).fingerprint256
  return { key: keyPem, cert: certPem, fingerprint256 }
}

function randomSerial(): string {
  // 16 random bytes. The leading "00" keeps the high bit clear so the
  // serial is parsed as a positive integer (some strict X.509 parsers
  // reject negative serials).
  return '00' + forge.util.bytesToHex(forge.random.getBytesSync(16))
}
