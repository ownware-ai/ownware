---
"@ownware/cortex": minor
"@ownware/client": minor
"@ownware/ui": minor
---

Add the cross-run activity ledger and per-run job receipts to the public
contract (revision 0.47). `GET /api/v1/activity-receipts` pages one
install-wide, gap-free index over effect, egress, skill-activation, reversal
and permission-decision receipts, scoped by principal and honest about
backfilled ordering. `GET /api/v1/runs/{runId}/job-receipt` aggregates what a
run was observed to do per tool action — counts are recomputed from receipts,
never narrated, and no absence claims are made. The client validates both at
the untrusted-JSON boundary (including recomputing job-receipt totals), and
`@ownware/ui` gains `selectActivityTrail` with per-row ordering provenance and
open-world family handling. Permission decisions now leave an immutable
receipt that survives expiry, and approvals record the exact tool call they
were spent on.

`GET /api/v1/threads` also enters the public contract as `threads.list`:
validated pagination, per-profile filtering, no-store, and fail-closed
delegation — a delegated principal is refused enumeration rather than handed
a filtered page that reads as "no threads exist". Cron schedules are now
rejected at create and update with a clear reason instead of being accepted
and silently never firing, and weekly re-arm (including across DST) is
verified by tests.

The schedules family (list, create, read, update, delete, pause, resume,
run-now, per-routine runs, occurrences, preview) also enters the public
contract as `schedules.read` + `schedules.manage`. Every schedule route is
owner-only: a delegated principal is refused outright, because routines run
unattended under their own safety envelope. The published `Schedule` shape
carries `safetyLevel` and `toolEnvelope` so surfaces can show the routine's
ACTUAL unattended envelope instead of a blanket safety claim.

The memory family joins too: memories (list/pin/edit/forget), the proposal
queue (accept/reject, atomically linked to the memory it creates) and the
About You identity record, as `memories.read`/`memories.manage` and
`user_identity.read`/`user_identity.manage`. All owner-only — what an agent
knows about its owner is never a delegated surface — and the published
`Memory` shape carries its real origin (`user_pinned`, `agent_proposed`,
`reflection`, `legacy_import`) so surfaces render provenance instead of
collapsing unlike sources.

The approvals inbox (list, count, get, approve, discard) is public as
`approvals.read`/`approvals.decide`, owner-only — rows carry the held call
verbatim because reviewing the draft is the point, which is exactly why no
delegated principal may see one. The published status vocabulary keeps the
honest states: `executing` and `indeterminate` are real outcomes, never
collapsed into success or failure.

Profile skills go public as `skills.read`/`skills.manage`: a new dedicated
list endpoint (name, description, playbook content, active flag), install from
URL / inline content / GitHub folder, toggle and remove — all owner-only.
`active` is documented as a configuration fact, never use evidence; per-run
activation receipts remain the only activation proof.

Workspaces (list, create/adopt, read, update, delete, threads) are public as
`workspaces.read`/`workspaces.manage`, owner-only — a workspace is a directory
on the owner's machine. Deleting the row never deletes the directory, and the
spec says so.

The stored-credential inventory is public read-only as `credentials.read`:
metadata and a masked hint, never a value — verified by a canary test that the
plaintext appears nowhere in the listing. Management routes and `reveal`
remain internal, and the whole family is owner-only.

