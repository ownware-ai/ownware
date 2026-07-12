// serve.mjs — your agent as a live service. This whole file is the "deploy".
//
//   node serve.mjs
//
// Your agent (profiles/assistant/) is now an HTTP+SSE service: POST /run,
// streaming events, threads, connectors, schedules. Talk to it with
// `node chat.mjs`, or from any HTTP client — Slack bots, web widgets,
// your own app. One process; you host it; your keys never leave.

import { OwnwareGateway } from 'ownware'
import { chmodSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

const ownware = new OwnwareGateway({
  profilesDir: join(here, 'profiles'),
  port: 4000,
  // Plain HTTP on loopback keeps first contact copy-paste simple.
  // Exposing beyond localhost? Turn TLS back on — see docs/gateway/exposing.md.
  tls: false,
})

await ownware.start()

// Hand the connection details to chat.mjs (and to you).
const conn = { url: `http://localhost:${ownware.port}`, token: ownware.token }
const connectionPath = join(here, '.ownware-connection.json')
writeFileSync(connectionPath, JSON.stringify(conn, null, 2), { mode: 0o600 })
chmodSync(connectionPath, 0o600)

console.log()
console.log(`  Your agent is live: ${conn.url}`)
console.log()
console.log('  Talk to it:   node chat.mjs')
console.log('  Raw HTTP token: read .ownware-connection.json (0600); never paste it into shared logs.')
console.log(`  Or raw HTTP:  curl -X POST ${conn.url}/api/v1/run \\`)
console.log('                  -H "Authorization: Bearer <token>" \\')
console.log('                  -H "Content-Type: application/json" \\')
console.log(`                  -d '{"profileId":"assistant","prompt":"hello"}'`)
console.log()
