/**
 * Resolve the gateway workspace for the directory the user launched in.
 *
 * Without a workspace on the run, the zone system has no boundary to
 * judge against, so EVERY file access classifies as "outside workspace"
 * (Zone 5) and demands approval — reads included. That is the "why does
 * everything need approval" bug: the answer is a missing workspace, not
 * a chatty policy. Registering the cwd restores the intended contract:
 * reads inside the project flow (Zone 0), writes/shell ask.
 *
 * Find-or-create by exact path; best-effort — a `null` return leaves the
 * run workspaceless (the old behavior) rather than blocking the prompt.
 */

export async function ensureWorkspace(
  baseUrl: string,
  token: string | undefined,
  cwd: string,
): Promise<string | null> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== undefined) headers['Authorization'] = `Bearer ${token}`

  try {
    const listRes = await fetch(`${baseUrl}/api/v1/workspaces`, { headers })
    if (listRes.ok) {
      const body = (await listRes.json()) as unknown
      const rows = Array.isArray(body)
        ? body
        : Array.isArray((body as { workspaces?: unknown[] }).workspaces)
          ? (body as { workspaces: unknown[] }).workspaces
          : []
      for (const row of rows) {
        const ws = row as { id?: string; path?: string }
        if (ws.path === cwd && typeof ws.id === 'string') return ws.id
      }
    }

    const createRes = await fetch(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: cwd }),
    })
    if (!createRes.ok) return null
    const created = (await createRes.json()) as { id?: string }
    return typeof created.id === 'string' ? created.id : null
  } catch {
    return null
  }
}
