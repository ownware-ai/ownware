import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Resolve an untrusted profile-relative reference without allowing lexical or
 * symlink escape. The returned path stays in the caller's original namespace;
 * realpath is used only for the containment decision.
 */
export async function resolveContainedProfilePath(
  profileRoot: string,
  suppliedPath: string,
  label: string,
): Promise<string> {
  if (suppliedPath.length === 0 || suppliedPath.includes('\0')) {
    throw new Error(`${label} must be a valid relative path inside the profile directory.`)
  }
  if (isAbsolute(suppliedPath) || suppliedPath.split(/[/\\]/).includes('..')) {
    throw new Error(`${label} must be relative and stay inside the profile directory.`)
  }

  const root = resolve(profileRoot)
  const candidate = resolve(root, suppliedPath)
  if (!isInside(root, candidate)) {
    throw new Error(`${label} must stay inside the profile directory.`)
  }

  try {
    const [realRoot, realCandidate] = await Promise.all([
      realpath(root),
      realpath(candidate),
    ])
    if (!isInside(realRoot, realCandidate)) {
      throw new Error(`${label} symlink target must stay inside the profile directory.`)
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('inside the profile directory')) {
      throw err
    }
    if (!isNodeError(err) || err.code !== 'ENOENT') throw err
    // Missing optional paths are handled by their caller. The lexical checks
    // above still prevent an absent reference from escaping if later created.
  }

  return candidate
}

export function isPathInside(parent: string, child: string): boolean {
  return isInside(resolve(parent), resolve(child))
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}
