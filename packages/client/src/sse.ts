/**
 * SSE parsing over fetch + ReadableStream — NOT EventSource.
 *
 * EventSource can't set an `Authorization` header, which the gateway's
 * bearer auth requires; fetch can. Promoted verbatim from
 * `@ownware/shuttle`'s gateway client (the original consumer).
 */

/**
 * Parse an SSE byte stream into `{ event, data }` frames. `data` is JSON-parsed
 * when possible, else the raw string. Comment lines (`:keepalive`) are skipped.
 * Cancels the underlying stream on early exit so a still-open root SSE socket
 * closes when the consumer stops reading.
 */
export async function* parseSseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<{ event: string; data: unknown }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = 'message'
  let dataLines: string[] = []

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)

        if (line === '') {
          if (dataLines.length > 0) {
            const raw = dataLines.join('\n')
            let data: unknown = raw
            try {
              data = JSON.parse(raw)
            } catch {
              /* keep the raw string */
            }
            yield { event: eventName, data }
          }
          eventName = 'message'
          dataLines = []
          continue
        }
        if (line.startsWith(':')) continue // comment / keepalive

        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        let val = colon === -1 ? '' : line.slice(colon + 1)
        if (val.startsWith(' ')) val = val.slice(1)
        if (field === 'event') eventName = val
        else if (field === 'data') dataLines.push(val)
        // id/retry ignored
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* already closed */
    }
  }
}
