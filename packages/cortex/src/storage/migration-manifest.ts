/** Logical point at which PostgreSQL became a supported storage dialect. */
export const STORAGE_ADAPTER_BASELINE_VERSION = 82 as const

export interface StorageMigrationIdentity {
  readonly version: number
  readonly name: string
}

/**
 * One shared identity for every schema change after the PostgreSQL baseline.
 *
 * Each adapter still owns its dialect SQL and physical postcondition. Adding a
 * migration here makes omission from either dialect a test/runtime failure; it
 * does not pretend that the SQL itself is portable.
 */
export const STORAGE_LOGICAL_MIGRATIONS = Object.freeze(
  [
    { version: 83, name: '083_message_sequence' },
  ] satisfies readonly StorageMigrationIdentity[],
)

function validateIdentities(
  identities: readonly StorageMigrationIdentity[],
  firstVersion: number,
): void {
  const names = new Set<string>()
  for (let index = 0; index < identities.length; index += 1) {
    const identity = identities[index]!
    if (
      !Number.isSafeInteger(identity.version) ||
      identity.version !== firstVersion + index ||
      identity.name.trim().length === 0 ||
      names.has(identity.name)
    ) {
      throw new TypeError('Storage migration identities are invalid.')
    }
    names.add(identity.name)
  }
}

function sameIdentities(
  left: readonly StorageMigrationIdentity[],
  right: readonly StorageMigrationIdentity[],
): boolean {
  return left.length === right.length && left.every((identity, index) => (
    identity.version === right[index]?.version && identity.name === right[index]?.name
  ))
}

/**
 * Prove that both physical manifests implement the exact shared post-baseline
 * identity sequence. This is structural alignment, not proof that either SQL
 * implementation has the claimed effect; adapter postconditions provide that.
 */
export function assertStorageMigrationAlignment(
  logical: readonly StorageMigrationIdentity[],
  sqlite: readonly StorageMigrationIdentity[],
  postgresql: readonly StorageMigrationIdentity[],
): void {
  const firstVersion = STORAGE_ADAPTER_BASELINE_VERSION + 1
  validateIdentities(logical, firstVersion)
  validateIdentities(sqlite, firstVersion)
  validateIdentities(postgresql, firstVersion)
  if (!sameIdentities(logical, sqlite) || !sameIdentities(logical, postgresql)) {
    throw new TypeError('Storage adapter migration manifests are not aligned.')
  }
}
