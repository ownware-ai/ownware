import { randomUUID } from "node:crypto";
import {
  CHANNEL_JOB_LEASE_MS,
  CHANNEL_JOB_MAX_ATTEMPTS,
  CHANNEL_JOB_MAX_WORK_LINES,
  ChannelJobConflictError,
  assertNoSecretShapedKeys,
  type ChannelGateDecisionInput,
  type ChannelGateResponse,
  type ChannelJob,
  type ChannelJobClaim,
  type ChannelJobRecoveryResult,
  type ChannelJobState,
  type ChannelReceipt,
  type ChannelReceiptInput,
  type ChannelWorkLine,
  type EnqueueChannelJobInput,
  type StoredChannelGate,
} from "../gateway/channel-job-store.js";
import type { ChannelGateSpec } from "../gateway/channel-procedures.js";
import type { PostgreSqlRootRepositoryContext } from "./postgresql-adapter.js";
import type { ChannelJobRepository } from "./platform-repositories.js";
import {
  repositoryCall,
  safeInteger,
  withPostgreSqlTransaction,
} from "./postgresql-repository.js";

const NAME = /^[a-z0-9_]{1,64}$/,
  KIND = /^[a-z0-9_]{1,32}$/;
interface Row {
  readonly job_id: string;
  readonly profile_id: string;
  readonly operation: string;
  readonly channel_kind: string;
  readonly channel_id: string | null;
  readonly params_json: string;
  readonly state_json: string;
  readonly step_count: unknown;
  readonly state: ChannelJobState;
  readonly attempt: unknown;
  readonly max_attempts: unknown;
  readonly checkpoint: unknown;
  readonly gate_json: string | null;
  readonly gate_response_json: string | null;
  readonly claim_token: string | null;
  readonly claimed_by: string | null;
  readonly lease_expires_at: unknown | null;
  readonly retry_after: unknown | null;
  readonly cancel_requested_at: unknown | null;
  readonly outcome_code: string | null;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly terminal_at: unknown | null;
}
interface ReceiptRow {
  readonly receipt_id: string;
  readonly job_id: string | null;
  readonly profile_id: string;
  readonly channel_kind: string | null;
  readonly channel_id: string | null;
  readonly kind: string;
  readonly title: string;
  readonly body_json: string;
  readonly created_at: unknown;
}
type Client = Parameters<Parameters<typeof repositoryCall<unknown>>[4]>[0];
const ni = (v: unknown | null) => (v === null ? null : safeInteger(v));
const project = (r: Row): ChannelJob => ({
  jobId: r.job_id,
  profileId: r.profile_id,
  operation: r.operation,
  channelKind: r.channel_kind,
  channelId: r.channel_id,
  state: r.state,
  attempt: safeInteger(r.attempt),
  maxAttempts: safeInteger(r.max_attempts) as typeof CHANNEL_JOB_MAX_ATTEMPTS,
  checkpoint: safeInteger(r.checkpoint),
  stepCount: safeInteger(r.step_count),
  gate:
    r.gate_json === null
      ? null
      : (JSON.parse(r.gate_json) as StoredChannelGate),
  cancelRequestedAt: ni(r.cancel_requested_at),
  outcomeCode: r.outcome_code,
  createdAt: safeInteger(r.created_at),
  updatedAt: safeInteger(r.updated_at),
  terminalAt: ni(r.terminal_at),
});
const receipt = (r: ReceiptRow): ChannelReceipt => ({
  receiptId: r.receipt_id,
  jobId: r.job_id,
  profileId: r.profile_id,
  channelKind: r.channel_kind,
  channelId: r.channel_id,
  kind: r.kind,
  title: r.title,
  body: JSON.parse(r.body_json) as Record<string, unknown>,
  createdAt: safeInteger(r.created_at),
});
async function getRow(client: Client, id: string, lock = false) {
  const row = (
    await client.query<Row>(
      `SELECT * FROM ownware.channel_jobs WHERE job_id=$1${lock ? " FOR UPDATE" : ""}`,
      [id],
    )
  ).rows[0];
  return row ?? null;
}
async function insertReceipt(
  client: Client,
  input: ChannelReceiptInput,
  at: number,
) {
  if (!NAME.test(input.kind))
    throw new TypeError("Channel receipt kind is invalid");
  if (!input.title.trim() || input.title.length > 200)
    throw new RangeError("Channel receipt title must be 1–200 characters");
  assertNoSecretShapedKeys(input.body, "receipt");
  const value = randomUUID();
  await client.query(
    `INSERT INTO ownware.channel_receipts(receipt_id,job_id,profile_id,channel_kind,channel_id,kind,title,body_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      value,
      input.jobId ?? null,
      input.profileId,
      input.channelKind ?? null,
      input.channelId ?? null,
      input.kind,
      input.title,
      JSON.stringify(input.body),
      at,
    ],
  );
  return {
    receiptId: value,
    jobId: input.jobId ?? null,
    profileId: input.profileId,
    channelKind: input.channelKind ?? null,
    channelId: input.channelId ?? null,
    kind: input.kind,
    title: input.title,
    body: { ...input.body },
    createdAt: at,
  };
}
const terminal = (s: ChannelJobState) =>
  s === "succeeded" || s === "failed" || s === "cancelled";

export function createPostgreSqlChannelJobRepository(
  context: PostgreSqlRootRepositoryContext,
): ChannelJobRepository {
  const call = <T>(
    op: string,
    write: boolean,
    fn: Parameters<typeof repositoryCall<T>>[4],
  ) =>
    repositoryCall(
      context,
      "channel_jobs",
      op,
      write ? "write_failed" : "read_failed",
      fn,
    );
  const claimed = async (
    client: Client,
    jobId: string,
    claimToken: string,
    at: number,
  ) => {
    const row = await getRow(client, jobId, true);
    if (
      row === null ||
      row.state !== "running" ||
      row.claim_token !== claimToken
    )
      return { row, result: "stale_claim" as const };
    if (row.lease_expires_at === null || safeInteger(row.lease_expires_at) < at)
      return { row, result: "lease_expired" as const };
    return { row, result: null };
  };
  return {
    enqueue(input: EnqueueChannelJobInput, at = Date.now()) {
      if (!NAME.test(input.operation))
        return Promise.reject(
          new TypeError("Channel job operation is invalid"),
        );
      if (!KIND.test(input.channelKind))
        return Promise.reject(new TypeError("Channel kind is invalid"));
      if (
        !Number.isInteger(input.stepCount) ||
        input.stepCount < 1 ||
        input.stepCount > 64
      )
        return Promise.reject(
          new RangeError("Channel job step count must be 1–64"),
        );
      assertNoSecretShapedKeys(input.params, "params");
      return call("enqueue", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",
            [input.profileId, input.operation],
          );
          const existing = (
            await client.query<{ job_id: string }>(
              `SELECT job_id FROM ownware.channel_jobs WHERE profile_id=$1 AND operation=$2 AND terminal_at IS NULL`,
              [input.profileId, input.operation],
            )
          ).rows[0];
          if (existing !== undefined)
            throw new ChannelJobConflictError(existing.job_id);
          const jobId = randomUUID();
          await client.query(
            `INSERT INTO ownware.channel_jobs(job_id,profile_id,operation,channel_kind,channel_id,params_json,state_json,step_count,state,attempt,max_attempts,checkpoint,gate_json,gate_response_json,claim_token,claimed_by,lease_expires_at,retry_after,cancel_requested_at,outcome_code,created_at,updated_at,terminal_at) VALUES($1,$2,$3,$4,$5,$6,'{}',$7,'queued',0,$8,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,$9,$9,NULL)`,
            [
              jobId,
              input.profileId,
              input.operation,
              input.channelKind,
              input.channelId ?? null,
              JSON.stringify(input.params),
              input.stepCount,
              CHANNEL_JOB_MAX_ATTEMPTS,
              at,
            ],
          );
          return project((await getRow(client, jobId))!);
        }),
      );
    },
    get(jobId) {
      return call("get", false, async (client) => {
        const row = await getRow(client, jobId);
        return row === null ? null : project(row);
      });
    },
    listForProfile(profileId, limit = 50) {
      return call("listForProfile", false, async (client) =>
        (
          await client.query<Row>(
            "SELECT * FROM ownware.channel_jobs WHERE profile_id=$1 ORDER BY created_at DESC,job_id DESC LIMIT $2",
            [profileId, limit],
          )
        ).rows.map(project),
      );
    },
    claimNext(workerId, at = Date.now()) {
      return call("claimNext", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const row = (
            await client.query<Row>(
              `SELECT * FROM ownware.channel_jobs WHERE state='queued' OR (state='waiting_for_retry' AND retry_after<=$1) ORDER BY created_at,job_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
              [at],
            )
          ).rows[0];
          if (row === undefined) return null;
          const token = randomUUID(),
            expiry = at + CHANNEL_JOB_LEASE_MS;
          const changed = await client.query(
            `UPDATE ownware.channel_jobs SET state='running',claim_token=$1,claimed_by=$2,lease_expires_at=$3,retry_after=NULL,updated_at=$4 WHERE job_id=$5 AND (state='queued' OR (state='waiting_for_retry' AND retry_after<=$4)) RETURNING *`,
            [token, workerId, expiry, at, row.job_id],
          );
          const value = changed.rows[0] as Row | undefined;
          if (value === undefined) return null;
          return {
            jobId: value.job_id,
            profileId: value.profile_id,
            operation: value.operation,
            channelKind: value.channel_kind,
            channelId: value.channel_id,
            params: JSON.parse(value.params_json) as Record<string, unknown>,
            state: JSON.parse(value.state_json) as Record<string, unknown>,
            stepCount: safeInteger(value.step_count),
            checkpoint: safeInteger(value.checkpoint),
            attempt: safeInteger(value.attempt),
            maxAttempts: safeInteger(
              value.max_attempts,
            ) as typeof CHANNEL_JOB_MAX_ATTEMPTS,
            gateResponse:
              value.gate_response_json === null
                ? null
                : (JSON.parse(value.gate_response_json) as ChannelGateResponse),
            claimToken: token,
            leaseExpiresAt: expiry,
          } as ChannelJobClaim;
        }),
      );
    },
    renewLease(jobId, token, at = Date.now()) {
      return call("renewLease", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const state = await claimed(client, jobId, token, at);
          if (state.result !== null) return state.result;
          await client.query(
            `UPDATE ownware.channel_jobs SET lease_expires_at=$1,updated_at=$2 WHERE job_id=$3 AND state='running' AND claim_token=$4`,
            [at + CHANNEL_JOB_LEASE_MS, at, jobId, token],
          );
          return "ok";
        }),
      );
    },
    advanceCheckpoint(jobId, token, expected, state, at = Date.now()) {
      assertNoSecretShapedKeys(state, "state");
      return call("advanceCheckpoint", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const claim = await claimed(client, jobId, token, at);
          if (claim.result !== null) return claim.result;
          if (safeInteger(claim.row!.checkpoint) !== expected)
            return "checkpoint_conflict";
          if (expected + 1 > safeInteger(claim.row!.step_count))
            throw new RangeError(
              "Channel job checkpoint exceeds the procedure",
            );
          const changed = await client.query(
            `UPDATE ownware.channel_jobs SET checkpoint=$1,state_json=$2,gate_response_json=NULL,updated_at=$3 WHERE job_id=$4 AND state='running' AND claim_token=$5 AND lease_expires_at>=$3 AND checkpoint=$6`,
            [expected + 1, JSON.stringify(state), at, jobId, token, expected],
          );
          return changed.rowCount === 1 ? "advanced" : "stale_claim";
        }),
      );
    },
    appendWorkLine(jobId, token, title, detail, at = Date.now()) {
      if (!title.trim() || title.length > 200)
        return Promise.reject(
          new RangeError("Channel work line title must be 1–200 characters"),
        );
      if (detail !== undefined && detail.length > 1000)
        return Promise.reject(
          new RangeError("Channel work line detail exceeds 1000 characters"),
        );
      return call("appendWorkLine", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const claim = await claimed(client, jobId, token, at);
          if (claim.result !== null) return claim.result;
          const seq = safeInteger(
            (
              await client.query<{ seq: unknown }>(
                `SELECT COALESCE(MAX(seq),0)+1 AS seq FROM ownware.channel_job_work_lines WHERE job_id=$1`,
                [jobId],
              )
            ).rows[0]!.seq,
          );
          if (seq > CHANNEL_JOB_MAX_WORK_LINES)
            throw new RangeError("Channel job work-line budget exhausted");
          await client.query(
            `INSERT INTO ownware.channel_job_work_lines(job_id,seq,title,detail,created_at) VALUES($1,$2,$3,$4,$5)`,
            [jobId, seq, title, detail ?? null, at],
          );
          return "ok";
        }),
      );
    },
    workLines(jobId) {
      return call("workLines", false, async (client) =>
        (
          await client.query<{
            seq: unknown;
            title: string;
            detail: string | null;
            created_at: unknown;
          }>(
            `SELECT seq,title,detail,created_at FROM ownware.channel_job_work_lines WHERE job_id=$1 ORDER BY seq`,
            [jobId],
          )
        ).rows.map(
          (row) =>
            ({
              seq: safeInteger(row.seq),
              title: row.title,
              detail: row.detail,
              createdAt: safeInteger(row.created_at),
            }) as ChannelWorkLine,
        ),
      );
    },
    parkForGate(jobId, token, gate: ChannelGateSpec, at = Date.now()) {
      assertNoSecretShapedKeys(gate, "gate");
      return call("parkForGate", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const claim = await claimed(client, jobId, token, at);
          if (claim.result !== null) return claim.result;
          const changed = await client.query(
            `UPDATE ownware.channel_jobs SET state='waiting_for_input',gate_json=$1,gate_response_json=NULL,claim_token=NULL,claimed_by=NULL,lease_expires_at=NULL,updated_at=$2 WHERE job_id=$3 AND state='running' AND claim_token=$4 AND lease_expires_at>=$2`,
            [JSON.stringify({ ...gate, presentedAt: at }), at, jobId, token],
          );
          return changed.rowCount === 1 ? "parked" : "stale_claim";
        }),
      );
    },
    respondToGate(jobId, decision: ChannelGateDecisionInput, at = Date.now()) {
      if (!decision.actor.trim())
        return Promise.reject(new TypeError("Gate decision needs an actor"));
      return call("respondToGate", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const row = await getRow(client, jobId, true);
          if (row === null) return "missing";
          if (row.state !== "waiting_for_input" || row.gate_json === null)
            return "state_conflict";
          const gate = JSON.parse(row.gate_json) as StoredChannelGate;
          if (gate.id !== decision.gateId) return "gate_mismatch";
          await insertReceipt(
            client,
            {
              jobId,
              profileId: row.profile_id,
              channelKind: row.channel_kind,
              ...(row.channel_id === null ? {} : { channelId: row.channel_id }),
              kind: "gate_decision",
              title:
                decision.action === "approve"
                  ? `Approved — ${gate.title}`
                  : `Declined — ${gate.title}`,
              body: {
                gateId: gate.id,
                action: decision.action,
                actor: decision.actor,
                scope: gate.included,
                exclusions: gate.excluded,
                requestedAt: gate.presentedAt,
                decidedAt: at,
                ...(decision.note ? { note: decision.note } : {}),
                ...(decision.action === "deny"
                  ? { whatRemainedUnchanged: gate.onDecline }
                  : {}),
              },
            },
            at,
          );
          if (decision.action === "approve") {
            await client.query(
              `UPDATE ownware.channel_jobs SET state='queued',gate_json=NULL,gate_response_json=$1,updated_at=$2 WHERE job_id=$3 AND state='waiting_for_input'`,
              [
                JSON.stringify({
                  gateId: gate.id,
                  action: "approve",
                  actor: decision.actor,
                  decidedAt: at,
                }),
                at,
                jobId,
              ],
            );
            return "accepted";
          }
          await client.query(
            `UPDATE ownware.channel_jobs SET state='cancelled',gate_json=NULL,gate_response_json=NULL,cancel_requested_at=$1,outcome_code='gate_declined',updated_at=$1,terminal_at=$1 WHERE job_id=$2 AND state='waiting_for_input'`,
            [at, jobId],
          );
          return "declined";
        }),
      );
    },
    consumeGateResponse(jobId, token, expected, gateId, at = Date.now()) {
      return call("consumeGateResponse", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const claim = await claimed(client, jobId, token, at);
          if (claim.result !== null) return claim.result;
          const row = claim.row!;
          if (safeInteger(row.checkpoint) !== expected)
            return "checkpoint_conflict";
          if (
            row.gate_response_json === null ||
            (JSON.parse(row.gate_response_json) as ChannelGateResponse)
              .gateId !== gateId
          )
            return "response_missing";
          if (expected + 1 > safeInteger(row.step_count))
            throw new RangeError(
              "Channel job checkpoint exceeds the procedure",
            );
          const changed = await client.query(
            `UPDATE ownware.channel_jobs SET checkpoint=$1,gate_response_json=NULL,updated_at=$2 WHERE job_id=$3 AND state='running' AND claim_token=$4 AND lease_expires_at>=$2 AND checkpoint=$5`,
            [expected + 1, at, jobId, token, expected],
          );
          return changed.rowCount === 1 ? "advanced" : "stale_claim";
        }),
      );
    },
    deferUntil(jobId, token, retryAt, at = Date.now()) {
      if (!Number.isSafeInteger(retryAt) || retryAt <= at)
        return Promise.reject(
          new RangeError("Channel job retry time must be in the future"),
        );
      return call("deferUntil", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const claim = await claimed(client, jobId, token, at);
          if (claim.result !== null) return claim.result;
          if (
            safeInteger(claim.row!.attempt) >=
            safeInteger(claim.row!.max_attempts)
          )
            return "attempts_exhausted";
          const changed = await client.query(
            `UPDATE ownware.channel_jobs SET state='waiting_for_retry',attempt=attempt+1,claim_token=NULL,claimed_by=NULL,lease_expires_at=NULL,retry_after=$1,updated_at=$2 WHERE job_id=$3 AND state='running' AND claim_token=$4 AND lease_expires_at>=$2 AND attempt<max_attempts`,
            [retryAt, at, jobId, token],
          );
          return changed.rowCount === 1 ? "deferred" : "stale_claim";
        }),
      );
    },
    finish(jobId, token, outcome, outcomeCode, at = Date.now()) {
      if (!NAME.test(outcomeCode))
        return Promise.reject(
          new TypeError("Channel job outcome code is invalid"),
        );
      return call("finish", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const row = await getRow(client, jobId, true);
          if (row === null || row.state !== "running") return "state_conflict";
          if (row.claim_token !== token) return "stale_claim";
          if (
            row.lease_expires_at === null ||
            safeInteger(row.lease_expires_at) < at
          )
            return "lease_expired";
          if (
            outcome === "succeeded" &&
            safeInteger(row.checkpoint) !== safeInteger(row.step_count)
          )
            return "checkpoint_incomplete";
          const changed = await client.query(
            `UPDATE ownware.channel_jobs SET state=$1,claim_token=NULL,claimed_by=NULL,lease_expires_at=NULL,retry_after=NULL,gate_response_json=NULL,outcome_code=$2,updated_at=$3,terminal_at=$3 WHERE job_id=$4 AND state='running' AND claim_token=$5 AND lease_expires_at>=$3`,
            [outcome, outcomeCode, at, jobId, token],
          );
          return changed.rowCount === 1 ? "finished" : "stale_claim";
        }),
      );
    },
    requestCancel(jobId, at = Date.now()) {
      return call("requestCancel", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const row = await getRow(client, jobId, true);
          if (row === null) return "missing";
          if (row.state === "cancel_requested") return "already_requested";
          if (terminal(row.state)) return "terminal";
          const changed = await client.query(
            `UPDATE ownware.channel_jobs SET state='cancel_requested',cancel_requested_at=$1,gate_json=NULL,gate_response_json=NULL,retry_after=NULL,updated_at=$1 WHERE job_id=$2 AND state IN ('queued','running','waiting_for_input','waiting_for_retry')`,
            [at, jobId],
          );
          return changed.rowCount === 1 ? "requested" : "already_requested";
        }),
      );
    },
    confirmNextUnclaimedCancellation(at = Date.now()) {
      return call("confirmNextUnclaimedCancellation", true, async () => {
        const candidate = await context.pool.query<{ job_id: string }>(
          `SELECT job_id FROM ownware.channel_jobs WHERE state='cancel_requested' AND claim_token IS NULL ORDER BY updated_at,job_id LIMIT 1`,
        );
        if (candidate.rows[0] === undefined) return false;
        return (
          (await this.confirmCancelled(candidate.rows[0].job_id, null, at)) ===
          "cancelled"
        );
      });
    },
    confirmCancelled(jobId, token, at = Date.now()) {
      return call("confirmCancelled", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const row = await getRow(client, jobId, true);
          if (row === null || row.state !== "cancel_requested")
            return "state_conflict";
          if (row.claim_token !== token) return "stale_claim";
          if (
            row.lease_expires_at !== null &&
            safeInteger(row.lease_expires_at) < at
          )
            return "lease_expired";
          const changed = await client.query(
            `UPDATE ownware.channel_jobs SET state='cancelled',claim_token=NULL,claimed_by=NULL,lease_expires_at=NULL,retry_after=NULL,outcome_code='cancelled',updated_at=$1,terminal_at=$1 WHERE job_id=$2 AND state='cancel_requested' AND claim_token IS NOT DISTINCT FROM $3 AND (lease_expires_at IS NULL OR lease_expires_at>=$1)`,
            [at, jobId, token],
          );
          if (changed.rowCount !== 1) return "stale_claim";
          await insertReceipt(
            client,
            {
              jobId,
              profileId: row.profile_id,
              channelKind: row.channel_kind,
              ...(row.channel_id === null ? {} : { channelId: row.channel_id }),
              kind: "procedure_cancelled",
              title: "Setup cancelled — nothing further was changed",
              body: {
                operation: row.operation,
                checkpointReached: safeInteger(row.checkpoint),
                requestedAt: ni(row.cancel_requested_at),
              },
            },
            at,
          );
          return "cancelled";
        }),
      );
    },
    recoverExpiredClaims(at = Date.now()) {
      return call("recoverExpiredClaims", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const cancelledRows = await client.query<Row>(
            `UPDATE ownware.channel_jobs SET state='cancelled',claim_token=NULL,claimed_by=NULL,lease_expires_at=NULL,retry_after=NULL,outcome_code='cancelled',updated_at=$1,terminal_at=$1 WHERE state='cancel_requested' AND (claim_token IS NULL OR lease_expires_at<$1) RETURNING *`,
            [at],
          );
          for (const row of cancelledRows.rows)
            await insertReceipt(
              client,
              {
                jobId: row.job_id,
                profileId: row.profile_id,
                channelKind: row.channel_kind,
                ...(row.channel_id === null
                  ? {}
                  : { channelId: row.channel_id }),
                kind: "procedure_cancelled",
                title: "Setup cancelled — nothing further was changed",
                body: {
                  operation: row.operation,
                  checkpointReached: safeInteger(row.checkpoint),
                  requestedAt: ni(row.cancel_requested_at),
                },
              },
              at,
            );
          const requeued =
            (
              await client.query(
                `UPDATE ownware.channel_jobs SET state='queued',attempt=attempt+1,claim_token=NULL,claimed_by=NULL,lease_expires_at=NULL,retry_after=NULL,updated_at=$1 WHERE state='running' AND lease_expires_at<$1 AND attempt<max_attempts`,
                [at],
              )
            ).rowCount ?? 0;
          const failed =
            (
              await client.query(
                `UPDATE ownware.channel_jobs SET state='failed',claim_token=NULL,claimed_by=NULL,lease_expires_at=NULL,retry_after=NULL,outcome_code='attempts_exhausted',updated_at=$1,terminal_at=$1 WHERE state='running' AND lease_expires_at<$1 AND attempt>=max_attempts`,
                [at],
              )
            ).rowCount ?? 0;
          return {
            requeued,
            failed,
            cancelled: cancelledRows.rowCount ?? 0,
          } as ChannelJobRecoveryResult;
        }),
      );
    },
    appendReceipt(input, at = Date.now()) {
      return call("appendReceipt", true, (client) =>
        insertReceipt(client, input, at),
      );
    },
    receiptsForJob(jobId) {
      return call("receiptsForJob", false, async (client) =>
        (
          await client.query<ReceiptRow>(
            "SELECT * FROM ownware.channel_receipts WHERE job_id=$1 ORDER BY created_at,receipt_id",
            [jobId],
          )
        ).rows.map(receipt),
      );
    },
    receiptsForProfile(profileId, limit = 100) {
      return call("receiptsForProfile", false, async (client) =>
        (
          await client.query<ReceiptRow>(
            "SELECT * FROM ownware.channel_receipts WHERE profile_id=$1 ORDER BY created_at DESC,receipt_id DESC LIMIT $2",
            [profileId, limit],
          )
        ).rows.map(receipt),
      );
    },
  };
}
