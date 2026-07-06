/**
 * Param guard middleware — rejects path parameters with unsafe characters.
 *
 * Prevents path traversal, injection, and encoded bypass attempts.
 */

import { RequestError } from '../router.js'

/**
 * Unsafe patterns in path parameters:
 * - Path traversal: .., %2e%2e, %2E%2E
 * - Shell injection: ;, |, &, `, $, (, ), {, }
 * - Null bytes: \0, %00
 * - Encoded slashes: %2f, %2F, %5c, %5C
 */
const UNSAFE_PATTERN = /(\.\.|%2[eE]%2[eE]|[;|&`$(){}\[\]]|%00|\x00|%2[fF]|%5[cC])/

/**
 * Validate all path parameters. Throws RequestError(400) if any contain unsafe characters.
 */
export function validateParams(params: Record<string, string>): void {
  for (const [key, value] of Object.entries(params)) {
    if (UNSAFE_PATTERN.test(value)) {
      throw new RequestError(400, `Invalid path parameter "${key}": contains unsafe characters`)
    }
  }
}
