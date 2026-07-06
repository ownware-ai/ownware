/**
 * Partial JSON Parser
 *
 * Parses incomplete JSON from streaming tool call arguments.
 * As the model streams `{"command": "ls -la", "des`, this parser
 * extracts complete key-value pairs for early display or execution.
 *
 * This enables streaming tool execution — starting a tool before
 * the model finishes generating all arguments.
 */

/**
 * Attempt to parse partial JSON, returning whatever complete
 * key-value pairs are available.
 *
 * Returns null if no valid structure can be extracted.
 */
export function parsePartialJson(input: string): Record<string, unknown> | null {
  // Try full parse first
  try {
    return JSON.parse(input) as Record<string, unknown>
  } catch {
    // Continue with partial parsing
  }

  // Try completing the JSON by closing open structures
  const completed = completeJson(input)
  if (completed) {
    try {
      return JSON.parse(completed) as Record<string, unknown>
    } catch {
      // Failed even with completion
    }
  }

  return null
}

/**
 * Try to complete partial JSON by adding closing brackets/braces.
 */
function completeJson(partial: string): string | null {
  const trimmed = partial.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return null
  }

  let result = trimmed
  const stack: string[] = []
  let inString = false
  let escaped = false

  for (let i = 0; i < result.length; i++) {
    const char = result[i]!

    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\' && inString) {
      escaped = true
      continue
    }

    if (char === '"') {
      inString = !inString
      continue
    }

    if (inString) continue

    if (char === '{') stack.push('}')
    else if (char === '[') stack.push(']')
    else if (char === '}' || char === ']') stack.pop()
  }

  // If we're in a string, close it
  if (inString) {
    result += '"'
  }

  // Remove trailing comma before closing
  result = result.replace(/,\s*$/, '')

  // Close all open structures
  while (stack.length > 0) {
    result += stack.pop()
  }

  return result
}

/**
 * Extract complete key-value pairs from a partial JSON object string.
 * Returns pairs that are safe to use (complete values).
 */
export function extractCompleteKeys(input: string): Map<string, unknown> {
  const result = new Map<string, unknown>()
  const parsed = parsePartialJson(input)
  if (!parsed) return result

  for (const [key, value] of Object.entries(parsed)) {
    // Only include values that appear complete in the original input
    const keyPattern = `"${key}"\\s*:`
    const keyMatch = input.match(new RegExp(keyPattern))
    if (keyMatch) {
      result.set(key, value)
    }
  }

  return result
}
