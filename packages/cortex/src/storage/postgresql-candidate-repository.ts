import {
  DEPLOYMENT_HEALTH_FRESH_MS,
  type ActiveCandidateRecord,
  type CandidateActivationResult,
  type CandidateDeploymentState,
  type CandidateDeletionClaim,
  type CandidateDeletionEligibility,
  type CandidateDeletionRecord,
  type CandidateRecord,
  type CandidateUndeploymentResult,
  type DeploymentRoutingResult,
} from "../gateway/candidate-store.js";
import type { PostgreSqlRootRepositoryContext } from "./postgresql-adapter.js";
import type { CandidateRepository } from "./platform-repositories.js";
import {
  repositoryCall,
  safeInteger,
  withPostgreSqlTransaction,
} from "./postgresql-repository.js";

interface CandidateRow {
  readonly candidate_id: string;
  readonly profile_id: string;
  readonly state: CandidateRecord["state"];
  readonly attempt_id: string | null;
  readonly file_count: unknown;
  readonly total_bytes: unknown;
  readonly code: string | null;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}
interface ActiveRow {
  readonly profile_id: string;
  readonly candidate_id: string;
  readonly deployment_revision: unknown;
  readonly routing_state: ActiveCandidateRecord["routingState"];
  readonly health: ActiveCandidateRecord["health"];
  readonly health_observed_at: unknown | null;
  readonly updated_at: unknown;
}
interface DeploymentStateRow {
  readonly state: "active" | "undeployed";
  readonly profile_id: string;
  readonly candidate_id: string | null;
  readonly previous_candidate_id: string | null;
  readonly deployment_revision: unknown;
  readonly routing_state: ActiveCandidateRecord["routingState"] | null;
  readonly health: ActiveCandidateRecord["health"] | null;
  readonly health_observed_at: unknown | null;
  readonly undeployed_at: unknown | null;
  readonly updated_at: unknown;
}
interface DeletionRow {
  readonly candidate_id: string;
  readonly state: CandidateDeletionRecord["state"];
  readonly code: string | null;
  readonly started_at: unknown;
  readonly updated_at: unknown;
  readonly deleted_at: unknown | null;
}
type Client = Parameters<Parameters<typeof repositoryCall<unknown>>[4]>[0];
const ni = (value: unknown | null) =>
  value === null ? null : safeInteger(value);
const candidate = (row: CandidateRow): CandidateRecord => ({
  candidateId: row.candidate_id,
  profileId: row.profile_id,
  state: row.state,
  attemptId: row.attempt_id,
  fileCount: safeInteger(row.file_count),
  totalBytes: safeInteger(row.total_bytes),
  code: row.code,
  createdAt: safeInteger(row.created_at),
  updatedAt: safeInteger(row.updated_at),
});
const deletion = (row: DeletionRow): CandidateDeletionRecord => ({
  candidateId: row.candidate_id,
  state: row.state,
  code: row.code,
  startedAt: safeInteger(row.started_at),
  updatedAt: safeInteger(row.updated_at),
  deletedAt: ni(row.deleted_at),
});
function active(row: ActiveRow, now: number): ActiveCandidateRecord {
  const observed = ni(row.health_observed_at),
    stale =
      row.health !== "unknown" &&
      (observed === null || now - observed > DEPLOYMENT_HEALTH_FRESH_MS);
  return {
    profileId: row.profile_id,
    candidateId: row.candidate_id,
    deploymentRevision: safeInteger(row.deployment_revision),
    routingState: row.routing_state,
    health: stale ? "unknown" : row.health,
    healthObservedAt: observed,
    updatedAt: safeInteger(row.updated_at),
  };
}
async function getCandidate(client: Client, id: string) {
  const row = (
    await client.query<CandidateRow>(
      "SELECT * FROM ownware.profile_candidates WHERE candidate_id=$1",
      [id],
    )
  ).rows[0];
  return row === undefined ? null : candidate(row);
}
async function getDeletion(client: Client, id: string) {
  const row = (
    await client.query<DeletionRow>(
      "SELECT * FROM ownware.profile_candidate_deletions WHERE candidate_id=$1",
      [id],
    )
  ).rows[0];
  return row === undefined ? null : deletion(row);
}
async function getActive(client: Client, profileId: string, now: number) {
  const row = (
    await client.query<ActiveRow>(
      "SELECT * FROM ownware.profile_candidate_activations WHERE profile_id=$1",
      [profileId],
    )
  ).rows[0];
  return row === undefined ? null : active(row, now);
}
async function getDeploymentState(
  client: Client,
  profileId: string,
  now: number,
): Promise<CandidateDeploymentState | null> {
  // A single statement uses one MVCC snapshot. Two separate reads could see
  // the activation before a concurrent swap and its tombstone afterward.
  const rows = (
    await client.query<DeploymentStateRow>(
      `SELECT 'active'::text AS state, profile_id, candidate_id,
         NULL::text AS previous_candidate_id, deployment_revision,
         routing_state, health, health_observed_at,
         NULL::bigint AS undeployed_at, updated_at
       FROM ownware.profile_candidate_activations WHERE profile_id=$1
       UNION ALL
       SELECT 'undeployed'::text AS state, profile_id, NULL::text AS candidate_id,
         previous_candidate_id, deployment_revision, NULL::text AS routing_state,
         NULL::text AS health, NULL::bigint AS health_observed_at,
         undeployed_at, updated_at
       FROM ownware.profile_candidate_deployment_tombstones WHERE profile_id=$1`,
      [profileId],
    )
  ).rows;
  if (rows.length > 1) throw new Error("Candidate deployment state conflict");
  const row = rows[0];
  if (row === undefined) return null;
  if (row.state === "active") {
    if (
      row.candidate_id === null ||
      row.routing_state === null ||
      row.health === null
    )
      throw new Error("Candidate deployment state invalid");
    return {
      state: "active",
      ...active(
        {
          profile_id: row.profile_id,
          candidate_id: row.candidate_id,
          deployment_revision: row.deployment_revision,
          routing_state: row.routing_state,
          health: row.health,
          health_observed_at: row.health_observed_at,
          updated_at: row.updated_at,
        },
        now,
      ),
    };
  }
  if (row.previous_candidate_id === null || row.undeployed_at === null)
    throw new Error("Candidate deployment state invalid");
  return {
    state: "undeployed",
    profileId: row.profile_id,
    previousCandidateId: row.previous_candidate_id,
    deploymentRevision: safeInteger(row.deployment_revision),
    undeployedAt: safeInteger(row.undeployed_at),
    updatedAt: safeInteger(row.updated_at),
  };
}
const routing = (
  status: Exclude<DeploymentRoutingResult["status"], "not_deployed">,
  row: ActiveCandidateRecord,
): DeploymentRoutingResult => ({
  status,
  activeCandidateId: row.candidateId,
  deploymentRevision: row.deploymentRevision,
  routingState: row.routingState,
  health: row.health,
  healthObservedAt: row.healthObservedAt,
});
const empty = (): DeploymentRoutingResult => ({
  status: "not_deployed",
  activeCandidateId: null,
  deploymentRevision: null,
  routingState: null,
  health: null,
  healthObservedAt: null,
});

export function createPostgreSqlCandidateRepository(
  context: PostgreSqlRootRepositoryContext,
): CandidateRepository {
  const call = <T>(
    op: string,
    write: boolean,
    fn: Parameters<typeof repositoryCall<T>>[4],
  ) =>
    repositoryCall(
      context,
      "profile_candidates",
      op,
      write ? "write_failed" : "read_failed",
      fn,
    );
  const eligibility = async (
    client: Client,
    input: { profileId: string; candidateId: string },
    now: number,
  ): Promise<CandidateDeletionEligibility> => {
    const value = await getCandidate(client, input.candidateId);
    if (value === null) return "not_found";
    if (value.profileId !== input.profileId) return "scope_mismatch";
    const gone = await getDeletion(client, input.candidateId);
    if (gone?.state === "deleted") return "already_deleted";
    if (gone?.state === "deleting") return "in_progress";
    if (value.state !== "ready") return "not_ready";
    const deployed = await getActive(client, input.profileId, now);
    if (deployed?.candidateId === input.candidateId) return "active";
    const uses = safeInteger(
      (
        await client.query<{ n: unknown }>(
          `SELECT COUNT(*) AS n FROM ownware.gateway_runs WHERE candidate_id=$1 AND status IN ('accepted','running','waiting','cancel_requested')`,
          [input.candidateId],
        )
      ).rows[0]!.n,
    );
    if (uses > 0) return "in_use";
    const prior = (
      await client.query<{ candidate_id: string }>(
        `SELECT candidate_id FROM ownware.profile_candidate_activation_history WHERE profile_id=$1 AND candidate_id<>$2 ORDER BY deployment_revision DESC LIMIT 1`,
        [input.profileId, deployed?.candidateId ?? ""],
      )
    ).rows[0]?.candidate_id;
    if (prior === input.candidateId) return "rollback_retained";
    return "eligible";
  };
  return {
    get(id) {
      return call("get", false, (client) => getCandidate(client, id));
    },
    list(profileId) {
      return call("list", false, async (client) =>
        (
          await client.query<CandidateRow>(
            "SELECT * FROM ownware.profile_candidates WHERE profile_id=$1 ORDER BY created_at DESC,candidate_id",
            [profileId],
          )
        ).rows.map(candidate),
      );
    },
    getDeletion(id) {
      return call("getDeletion", false, (client) => getDeletion(client, id));
    },
    getActive(profileId, now = Date.now()) {
      return call("getActive", false, (client) =>
        getActive(client, profileId, now),
      );
    },
    getDeploymentState(profileId, now = Date.now()) {
      return call("getDeploymentState", false, (client) =>
        getDeploymentState(client, profileId, now),
      );
    },
    compareAndSetActive(input, now = Date.now()) {
      return call("compareAndSetActive", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            input.profileId,
          ]);
          const deployment = await getDeploymentState(
              client,
              input.profileId,
              now,
            ),
            current = deployment?.state === "active" ? deployment : null,
            undeployed = deployment?.state === "undeployed" ? deployment : null,
            currentId = current?.candidateId ?? null,
            unchanged = {
              deploymentRevision:
                current?.deploymentRevision ??
                undeployed?.deploymentRevision ??
                null,
              routingState: current?.routingState ?? null,
              health: current?.health ?? null,
              healthObservedAt: current?.healthObservedAt ?? null,
            };
          const value = await getCandidate(client, input.candidateId),
            gone = await getDeletion(client, input.candidateId);
          if (value === null || value.state !== "ready" || gone !== null)
            return {
              status: "candidate_not_ready",
              previousCandidateId: currentId,
              activeCandidateId: currentId,
              ...unchanged,
            };
          if (value.profileId !== input.profileId)
            return {
              status: "candidate_scope_mismatch",
              previousCandidateId: currentId,
              activeCandidateId: currentId,
              ...unchanged,
            };
          const revisionMatches = current
            ? input.expectedDeploymentRevision === undefined ||
              input.expectedDeploymentRevision === current.deploymentRevision
            : undeployed
              ? input.expectedDeploymentRevision === undeployed.deploymentRevision
              : input.expectedDeploymentRevision === undefined ||
                input.expectedDeploymentRevision === null;
          if (
            currentId !== input.expectedActiveCandidateId ||
            !revisionMatches
          )
            return {
              status: "conflict",
              previousCandidateId: currentId,
              activeCandidateId: currentId,
              ...unchanged,
            };
          if (currentId === input.candidateId)
            return {
              status: "unchanged",
              previousCandidateId: currentId,
              activeCandidateId: currentId,
              ...unchanged,
            };
          if (current !== null) {
            const updated = await client.query(
              `UPDATE ownware.profile_candidate_activations
               SET candidate_id=$1,deployment_revision=deployment_revision+1,
                 health='starting',health_observed_at=$2,updated_at=$2
               WHERE profile_id=$3 AND candidate_id=$4
                 AND deployment_revision=$5`,
              [
                input.candidateId,
                now,
                input.profileId,
                current.candidateId,
                current.deploymentRevision,
              ],
            );
            if (updated.rowCount !== 1)
              throw new Error("Candidate activation state conflict");
          } else {
            const revision = (undeployed?.deploymentRevision ?? 0) + 1;
            if (undeployed !== null) {
              const removed = await client.query(
                `DELETE FROM ownware.profile_candidate_deployment_tombstones
                 WHERE profile_id=$1 AND deployment_revision=$2`,
                [input.profileId, undeployed.deploymentRevision],
              );
              if (removed.rowCount !== 1)
                throw new Error("Candidate deployment state conflict");
            }
            await client.query(
              `INSERT INTO ownware.profile_candidate_activations(
                 profile_id,candidate_id,deployment_revision,routing_state,
                 health,health_observed_at,updated_at
               ) VALUES($1,$2,$3,'active','starting',$4,$4)`,
              [input.profileId, input.candidateId, revision, now],
            );
          }
          const next = (await getActive(client, input.profileId, now))!;
          await client.query(
            "INSERT INTO ownware.profile_candidate_activation_history(profile_id,deployment_revision,candidate_id,activated_at) VALUES($1,$2,$3,$4)",
            [input.profileId, next.deploymentRevision, input.candidateId, now],
          );
          return {
            status: "activated",
            previousCandidateId: currentId,
            activeCandidateId: input.candidateId,
            deploymentRevision: next.deploymentRevision,
            routingState: next.routingState,
            health: next.health,
            healthObservedAt: next.healthObservedAt,
          } as CandidateActivationResult;
        }),
      );
    },
    compareAndSetUndeployed(input, now = Date.now()) {
      return call("compareAndSetUndeployed", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            input.profileId,
          ]);
          const deployment = await getDeploymentState(
            client,
            input.profileId,
            now,
          );
          const result = (
            status: CandidateUndeploymentResult["status"],
            activeRunCount: number,
          ): CandidateUndeploymentResult => ({
            status,
            previousCandidateId:
              deployment?.state === "active"
                ? deployment.candidateId
                : deployment?.state === "undeployed"
                  ? deployment.previousCandidateId
                  : null,
            activeCandidateId:
              deployment?.state === "active" ? deployment.candidateId : null,
            deploymentRevision: deployment?.deploymentRevision ?? null,
            activeRunCount,
            undeployedAt:
              deployment?.state === "undeployed"
                ? deployment.undeployedAt
                : null,
          });
          if (deployment === null || deployment.state === "undeployed")
            return result("not_deployed", 0);
          if (
            deployment.candidateId !== input.expectedActiveCandidateId ||
            deployment.deploymentRevision !== input.expectedDeploymentRevision
          )
            return result("conflict", 0);
          if (deployment.routingState !== "paused")
            return result("not_paused", 0);
          const activeRuns = safeInteger(
            (
              await client.query<{ count: unknown }>(
                `SELECT COUNT(*) AS count FROM ownware.gateway_runs
                 WHERE profile_id=$1
                   AND status IN ('accepted','running','waiting','cancel_requested')`,
                [input.profileId],
              )
            ).rows[0]!.count,
          );
          if (activeRuns > 0) return result("active_runs", activeRuns);

          const removed = await client.query(
            `DELETE FROM ownware.profile_candidate_activations
             WHERE profile_id=$1 AND candidate_id=$2
               AND deployment_revision=$3 AND routing_state='paused'`,
            [
              input.profileId,
              input.expectedActiveCandidateId,
              input.expectedDeploymentRevision,
            ],
          );
          if (removed.rowCount !== 1)
            throw new Error("Candidate undeployment state conflict");
          const revision = input.expectedDeploymentRevision + 1;
          await client.query(
            `INSERT INTO ownware.profile_candidate_deployment_tombstones(
               profile_id,previous_candidate_id,deployment_revision,
               undeployed_at,updated_at
             ) VALUES($1,$2,$3,$4,$4)`,
            [
              input.profileId,
              input.expectedActiveCandidateId,
              revision,
              now,
            ],
          );
          return {
            status: "undeployed",
            previousCandidateId: input.expectedActiveCandidateId,
            activeCandidateId: null,
            deploymentRevision: revision,
            activeRunCount: 0,
            undeployedAt: now,
          };
        }),
      );
    },
    compareAndSetRouting(input, now = Date.now()) {
      return call("compareAndSetRouting", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            input.profileId,
          ]);
          const result = await client.query(
            `UPDATE ownware.profile_candidate_activations SET routing_state=$1,deployment_revision=deployment_revision+1,updated_at=$2 WHERE profile_id=$3 AND deployment_revision=$4 AND routing_state<>$1`,
            [input.routingState, now, input.profileId, input.expectedRevision],
          );
          const current = await getActive(client, input.profileId, now);
          if (current === null) return empty();
          if (result.rowCount === 1) return routing("changed", current);
          if (current.deploymentRevision !== input.expectedRevision)
            return routing("conflict", current);
          return routing("unchanged", current);
        }),
      );
    },
    recordHealth(input) {
      return call(
        "recordHealth",
        true,
        async (client) =>
          (
            await client.query(
              `UPDATE ownware.profile_candidate_activations SET health=$1,health_observed_at=$2,updated_at=GREATEST(updated_at,$2) WHERE profile_id=$3 AND candidate_id=$4 AND (health_observed_at IS NULL OR health_observed_at<=$2)`,
              [
                input.health,
                input.observedAt,
                input.profileId,
                input.candidateId,
              ],
            )
          ).rowCount === 1,
      );
    },
    beginDeletion(input, now = Date.now()) {
      return call("beginDeletion", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            input.candidateId,
          ]);
          const result = (
            status: CandidateDeletionClaim["status"],
          ): CandidateDeletionClaim => ({
            status,
            candidateId: input.candidateId,
            profileId: input.profileId,
          });
          const state = await eligibility(client, input, now);
          if (state !== "eligible") return result(state);
          const current = await getDeletion(client, input.candidateId);
          if (current?.state === "delete_failed")
            await client.query(
              `UPDATE ownware.profile_candidate_deletions SET state='deleting',code=NULL,updated_at=$1,deleted_at=NULL WHERE candidate_id=$2 AND state='delete_failed'`,
              [now, input.candidateId],
            );
          else
            await client.query(
              `INSERT INTO ownware.profile_candidate_deletions(candidate_id,state,code,started_at,updated_at,deleted_at) VALUES($1,'deleting',NULL,$2,$2,NULL)`,
              [input.candidateId, now],
            );
          return result("started");
        }),
      );
    },
    deletionEligibility(input, now = Date.now()) {
      return call("deletionEligibility", false, (client) =>
        eligibility(client, input, now),
      );
    },
    markDeleteFailed(id, code, now = Date.now()) {
      return call("markDeleteFailed", true, async (client) => {
        const result = await client.query(
          `UPDATE ownware.profile_candidate_deletions SET state='delete_failed',code=$1,updated_at=$2 WHERE candidate_id=$3 AND state='deleting'`,
          [code, now, id],
        );
        if (result.rowCount !== 1)
          throw new Error("Candidate deletion state conflict");
      });
    },
    markDeleted(id, now = Date.now()) {
      return call("markDeleted", true, async (client) => {
        const result = await client.query(
          `UPDATE ownware.profile_candidate_deletions SET state='deleted',code=NULL,updated_at=$1,deleted_at=$1 WHERE candidate_id=$2 AND state='deleting'`,
          [now, id],
        );
        if (result.rowCount !== 1)
          throw new Error("Candidate deletion state conflict");
      });
    },
    begin(input, now = Date.now()) {
      return call("begin", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            input.candidateId,
          ]);
          const current = await getCandidate(client, input.candidateId);
          if (current !== null) {
            if (
              current.profileId !== input.profileId ||
              current.fileCount !== input.fileCount ||
              current.totalBytes !== input.totalBytes
            )
              throw new Error("Candidate identity metadata conflict");
            if (current.state === "ready") return "ready";
            if (current.state === "placing") return "in_progress";
            await client.query(
              `UPDATE ownware.profile_candidates SET state='placing',attempt_id=$1,code=NULL,updated_at=$2 WHERE candidate_id=$3 AND state IN ('placement_failed','cleanup_failed')`,
              [input.attemptId, now, input.candidateId],
            );
            return "started";
          }
          await client.query(
            `INSERT INTO ownware.profile_candidates(candidate_id,profile_id,state,attempt_id,file_count,total_bytes,code,created_at,updated_at) VALUES($1,$2,'placing',$3,$4,$5,NULL,$6,$6)`,
            [
              input.candidateId,
              input.profileId,
              input.attemptId,
              input.fileCount,
              input.totalBytes,
              now,
            ],
          );
          return "started";
        }),
      );
    },
    markReady(id, attempt, now = Date.now()) {
      return call("markReady", true, async (client) => {
        if (
          (
            await client.query(
              `UPDATE ownware.profile_candidates SET state='ready',attempt_id=NULL,code=NULL,updated_at=$1 WHERE candidate_id=$2 AND state='placing' AND attempt_id=$3`,
              [now, id, attempt],
            )
          ).rowCount !== 1
        )
          throw new Error("Candidate placement state conflict");
      });
    },
    markFailed(id, attempt, state, code, now = Date.now()) {
      return call("markFailed", true, async (client) => {
        if (
          (
            await client.query(
              `UPDATE ownware.profile_candidates SET state=$1,code=$2,updated_at=$3 WHERE candidate_id=$4 AND state='placing' AND attempt_id=$5`,
              [state, code, now, id, attempt],
            )
          ).rowCount !== 1
        )
          throw new Error("Candidate placement state conflict");
      });
    },
    markCleanupFailed(id, attempt, now = Date.now()) {
      return call("markCleanupFailed", true, async (client) => {
        if (
          (
            await client.query(
              `UPDATE ownware.profile_candidates SET state='cleanup_failed',code='cleanup_failed',updated_at=$1 WHERE candidate_id=$2 AND attempt_id=$3 AND state IN ('placing','placement_failed','cleanup_failed')`,
              [now, id, attempt],
            )
          ).rowCount !== 1
        )
          throw new Error("Candidate placement state conflict");
      });
    },
    markCleanupResolved(id, attempt, now = Date.now()) {
      return call("markCleanupResolved", true, async (client) => {
        if (
          (
            await client.query(
              `UPDATE ownware.profile_candidates SET state='placement_failed',code='cleanup_recovered',updated_at=$1 WHERE candidate_id=$2 AND state='cleanup_failed' AND attempt_id=$3`,
              [now, id, attempt],
            )
          ).rowCount !== 1
        )
          throw new Error("Candidate placement state conflict");
      });
    },
    recoverInterrupted(now = Date.now()) {
      return call(
        "recoverInterrupted",
        true,
        async (client) =>
          (
            await client.query(
              `UPDATE ownware.profile_candidates SET state='placement_failed',code='gateway_restarted',updated_at=$1 WHERE state='placing'`,
              [now],
            )
          ).rowCount ?? 0,
      );
    },
  };
}
