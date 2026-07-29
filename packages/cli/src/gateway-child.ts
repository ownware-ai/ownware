/**
 * Child-process gateway runner.
 *
 * The OpenTUI shell runs under Bun, but the gateway kernel needs Node
 * (cortex uses `better-sqlite3`, a Node native addon Bun doesn't load).
 * So a Bun-hosted CLI spawns THIS module under `node`: it boots a
 * loopback gateway, routes every console line to the gateway log file
 * (BUGS #1 — same policy as the in-process path), prints exactly one
 * JSON handshake line `{"port":…,"token":…}` on stdout, then serves
 * until SIGTERM/SIGINT.
 *
 * Config via env (no argv parsing to get wrong):
 *   OWNWARE_CHILD_PROFILES_DIR  required
 *   OWNWARE_CHILD_DATA_DIR      required
 *   OWNWARE_CHILD_LOG_FILE      required
 */

import { redirectConsoleToFile } from './gateway-log.js'

async function main(): Promise<void> {
  const profilesDir = process.env['OWNWARE_CHILD_PROFILES_DIR']
  const dataDir = process.env['OWNWARE_CHILD_DATA_DIR']
  const logFile = process.env['OWNWARE_CHILD_LOG_FILE']
  if (!profilesDir || !dataDir || !logFile) {
    process.stderr.write('gateway-child: missing OWNWARE_CHILD_* env\n')
    process.exit(2)
  }

  redirectConsoleToFile(logFile)
  const { OwnwareGateway } = await import('@ownware/cortex')
  const gateway = new OwnwareGateway({
    port: 0,
    profilesDir,
    dataDir,
    tls: false,
  })
  await gateway.start()

  // The single handshake line the parent waits for. stdout carries
  // nothing else — the console redirect owns every log line.
  process.stdout.write(JSON.stringify({ port: gateway.port, token: gateway.token }) + '\n')

  const stop = () => {
    void gateway.stop().finally(() => process.exit(0))
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

void main().catch((err: unknown) => {
  process.stderr.write(
    `gateway-child: ${err instanceof Error ? err.message : String(err)}\n`,
  )
  process.exit(1)
})
