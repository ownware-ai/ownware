import { randomUUID } from "node:crypto";
import type { TaskEventBus, TaskDto } from "../tasks/event-bus.js";
import { TaskStatusSchema } from "../tasks/event-bus.js";
import type {
  ApprovalDto,
  ClaimApprovalResult,
  ClaimedApproval,
  PendingApprovalDto,
} from "../schedules/approvals.js";
import { ApprovalStatusSchema } from "../schedules/approvals.js";
import {
  SCHEDULE_APPROVAL_INTENT_REVISION,
  scheduleApprovalOperationHash,
} from "../gateway/permission-intent.js";
import {
  DEFAULT_SAFETY_LEVEL,
  SafetyLevelSchema,
} from "../schedules/safety.js";
import {
  CadenceKindSchema,
  CatchUpPolicySchema,
  DEFAULT_DELIVERY_MODE,
  DeliveryModeSchema,
  DeliveryStatusSchema,
  OverlapPolicySchema,
  RunStatusSchema,
  ScheduleDeliverToSchema,
  ScheduleStateSchema,
  type RecentRunDto,
  type ScheduleDto,
  type ScheduleRunDto,
  type ToolEnvelope,
} from "../schedules/types.js";
import type { PostgreSqlRootRepositoryContext } from "./postgresql-adapter.js";
import type {
  ApprovalRepository,
  ScheduleRepository,
  TaskRepository,
} from "./platform-repositories.js";
import {
  repositoryCall,
  safeInteger,
  withPostgreSqlTransaction,
} from "./postgresql-repository.js";

interface ScheduleRow {
  readonly id: string;
  readonly profile_id: string;
  readonly workspace_id: string | null;
  readonly name: string;
  readonly prompt: string;
  readonly model: string | null;
  readonly cadence_kind: string;
  readonly cadence_expr: string;
  readonly cadence_display: string;
  readonly timezone: string;
  readonly catch_up_policy: string;
  readonly catch_up_window_ms: unknown | null;
  readonly overlap_policy: string;
  readonly skip_weekends: boolean;
  readonly skip_holidays: boolean;
  readonly tool_envelope: string | null;
  readonly safety_level: string;
  readonly delivery_mode: string;
  readonly quiet_on_empty: boolean;
  readonly deliver_channel: string | null;
  readonly deliver_target: string | null;
  readonly enabled: boolean;
  readonly state: string;
  readonly next_run_at: unknown | null;
  readonly last_run_at: unknown | null;
  readonly last_run_id: string | null;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}
interface RunRow {
  readonly id: string;
  readonly schedule_id: string;
  readonly thread_id: string | null;
  readonly scheduled_for: unknown;
  readonly started_at: unknown | null;
  readonly finished_at: unknown | null;
  readonly run_status: string;
  readonly skip_reason: string | null;
  readonly was_catch_up: boolean;
  readonly error_category: string | null;
  readonly error_message: string | null;
  readonly delivery_status: string;
  readonly idempotency_key: string | null;
  readonly created_at: unknown;
}
interface ApprovalRow {
  readonly id: string;
  readonly schedule_id: string;
  readonly run_id: string;
  readonly thread_id: string | null;
  readonly tool_name: string;
  readonly tool_input: string;
  readonly summary: string;
  readonly status: string;
  readonly result: string | null;
  readonly error_message: string | null;
  readonly created_at: unknown;
  readonly decided_at: unknown | null;
  readonly intent_revision?: unknown | null;
  readonly operation_hash?: string | null;
  readonly policy_revision?: string | null;
  readonly tool_revision?: string | null;
  readonly target_revision?: string | null;
  readonly claimed_at?: unknown | null;
}
interface TaskRow {
  readonly id: string;
  readonly thread_id: string;
  readonly content: string;
  readonly status: string;
  readonly list_order: unknown;
  readonly created_at: string;
  readonly updated_at: string;
}

const ni = (value: unknown | null): number | null =>
  value === null ? null : safeInteger(value);
const json = (value: string | null): unknown => {
  if (value === null || value.length === 0) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};
function schedule(row: ScheduleRow): ScheduleDto {
  let envelope: ToolEnvelope | null = null;
  try {
    envelope =
      row.tool_envelope === null
        ? null
        : (JSON.parse(row.tool_envelope) as ToolEnvelope);
  } catch {}
  const deliver =
    row.deliver_channel !== null && row.deliver_target !== null
      ? ScheduleDeliverToSchema.safeParse({
          channel: row.deliver_channel,
          target: row.deliver_target,
        })
      : null;
  return {
    id: row.id,
    profileId: row.profile_id,
    workspaceId: row.workspace_id,
    name: row.name,
    prompt: row.prompt,
    model: row.model,
    cadenceKind: CadenceKindSchema.parse(row.cadence_kind),
    cadenceExpr: row.cadence_expr,
    cadenceDisplay: row.cadence_display,
    timezone: row.timezone,
    catchUpPolicy: CatchUpPolicySchema.parse(row.catch_up_policy),
    catchUpWindowMs: ni(row.catch_up_window_ms),
    overlapPolicy: OverlapPolicySchema.parse(row.overlap_policy),
    skipWeekends: row.skip_weekends,
    skipHolidays: row.skip_holidays,
    toolEnvelope: envelope,
    safetyLevel: SafetyLevelSchema.parse(row.safety_level),
    deliveryMode: DeliveryModeSchema.parse(row.delivery_mode),
    quietOnEmpty: row.quiet_on_empty,
    deliver: deliver?.success === true ? deliver.data : null,
    enabled: row.enabled,
    state: ScheduleStateSchema.parse(row.state),
    nextRunAt: ni(row.next_run_at),
    lastRunAt: ni(row.last_run_at),
    lastRunId: row.last_run_id,
    createdAt: safeInteger(row.created_at),
    updatedAt: safeInteger(row.updated_at),
  };
}
function run(row: RunRow): ScheduleRunDto {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    threadId: row.thread_id,
    scheduledFor: safeInteger(row.scheduled_for),
    startedAt: ni(row.started_at),
    finishedAt: ni(row.finished_at),
    runStatus: RunStatusSchema.parse(row.run_status),
    skipReason: row.skip_reason,
    wasCatchUp: row.was_catch_up,
    errorCategory: row.error_category,
    errorMessage: row.error_message,
    deliveryStatus: DeliveryStatusSchema.parse(row.delivery_status),
    idempotencyKey: row.idempotency_key,
    createdAt: safeInteger(row.created_at),
  };
}
function approval(row: ApprovalRow): ApprovalDto {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    runId: row.run_id,
    threadId: row.thread_id,
    toolName: row.tool_name,
    toolInput: json(row.tool_input),
    summary: row.summary,
    status: ApprovalStatusSchema.parse(row.status),
    result: json(row.result),
    errorMessage: row.error_message,
    createdAt: safeInteger(row.created_at),
    decidedAt: ni(row.decided_at),
    intentRevision: row.intent_revision == null
      ? null
      : safeInteger(row.intent_revision) === SCHEDULE_APPROVAL_INTENT_REVISION
        ? SCHEDULE_APPROVAL_INTENT_REVISION
        : null,
    claimedAt: row.claimed_at == null ? null : safeInteger(row.claimed_at),
  };
}
function task(row: TaskRow): TaskDto {
  return {
    id: row.id,
    threadId: row.thread_id,
    content: row.content,
    status: TaskStatusSchema.parse(row.status),
    order: safeInteger(row.list_order),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
const id = (prefix: string) =>
  `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

export function createPostgreSqlScheduleRepository(
  context: PostgreSqlRootRepositoryContext,
): ScheduleRepository {
  const call = <T>(
    op: string,
    write: boolean,
    fn: Parameters<typeof repositoryCall<T>>[4],
  ) =>
    repositoryCall(
      context,
      "schedules",
      op,
      write ? "write_failed" : "read_failed",
      fn,
    );
  const getOn = async (
    client: Parameters<
      Parameters<typeof repositoryCall<ScheduleDto | null>>[4]
    >[0],
    value: string,
  ) => {
    const row = (
      await client.query<ScheduleRow>(
        "SELECT * FROM ownware.schedules WHERE id=$1",
        [value],
      )
    ).rows[0];
    return row === undefined ? null : schedule(row);
  };
  const getRunOn = async (
    client: Parameters<
      Parameters<typeof repositoryCall<ScheduleRunDto | null>>[4]
    >[0],
    value: string,
  ) => {
    const row = (
      await client.query<RunRow>(
        "SELECT * FROM ownware.schedule_runs WHERE id=$1",
        [value],
      )
    ).rows[0];
    return row === undefined ? null : run(row);
  };
  const insertRun = async (
    client: Parameters<Parameters<typeof repositoryCall<ScheduleRunDto>>[4]>[0],
    input: Parameters<ScheduleRepository["recordRun"]>[0],
  ) => {
    const runId = id("srun");
    const createdAt = Date.now();
    await client.query(
      `INSERT INTO ownware.schedule_runs (id,schedule_id,thread_id,scheduled_for,started_at,
      finished_at,run_status,skip_reason,was_catch_up,error_category,error_message,delivery_status,
      idempotency_key,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        runId,
        input.scheduleId,
        input.threadId ?? null,
        input.scheduledFor,
        input.startedAt ?? null,
        input.finishedAt ?? null,
        RunStatusSchema.parse(input.runStatus),
        input.skipReason ?? null,
        input.wasCatchUp ?? false,
        input.errorCategory ?? null,
        input.errorMessage ?? null,
        DeliveryStatusSchema.parse(input.deliveryStatus ?? "not-requested"),
        input.idempotencyKey ?? null,
        createdAt,
      ],
    );
    return (await getRunOn(client, runId))!;
  };
  return {
    create(input) {
      return call("create", true, async (client) => {
        const scheduleId = id("sched");
        const now = Date.now();
        const deliver =
          input.deliver == null
            ? null
            : ScheduleDeliverToSchema.parse(input.deliver);
        await client.query(
          `INSERT INTO ownware.schedules (id,profile_id,workspace_id,name,prompt,model,
        cadence_kind,cadence_expr,cadence_display,timezone,catch_up_policy,catch_up_window_ms,overlap_policy,
        skip_weekends,skip_holidays,tool_envelope,safety_level,delivery_mode,quiet_on_empty,
        deliver_channel,deliver_target,enabled,state,next_run_at,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'scheduled',$23,$24,$24)`,
          [
            scheduleId,
            input.profileId,
            input.workspaceId ?? null,
            input.name,
            input.prompt,
            input.model ?? null,
            CadenceKindSchema.parse(input.cadenceKind),
            input.cadenceExpr,
            input.cadenceDisplay,
            input.timezone,
            CatchUpPolicySchema.parse(input.catchUpPolicy ?? "catch-up"),
            input.catchUpWindowMs ?? null,
            OverlapPolicySchema.parse(input.overlapPolicy ?? "skip-if-running"),
            input.skipWeekends ?? false,
            input.skipHolidays ?? false,
            input.toolEnvelope == null
              ? null
              : JSON.stringify(input.toolEnvelope),
            SafetyLevelSchema.parse(input.safetyLevel ?? DEFAULT_SAFETY_LEVEL),
            DeliveryModeSchema.parse(
              input.deliveryMode ?? DEFAULT_DELIVERY_MODE,
            ),
            input.quietOnEmpty ?? true,
            deliver?.channel ?? null,
            deliver?.target ?? null,
            input.enabled ?? true,
            input.nextRunAt ?? null,
            now,
          ],
        );
        return (await getOn(client, scheduleId))!;
      });
    },
    get(value) {
      return call("get", false, (client) => getOn(client, value));
    },
    list(filter) {
      return call("list", false, async (client) => {
        const values: unknown[] = [];
        const where: string[] = [];
        if (filter?.profileId !== undefined) {
          values.push(filter.profileId);
          where.push(`profile_id=$${values.length}`);
        }
        if (filter?.enabledOnly === true) where.push("enabled=TRUE");
        return (
          await client.query<ScheduleRow>(
            `SELECT * FROM ownware.schedules ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`,
            values,
          )
        ).rows.map(schedule);
      });
    },
    getDue(now) {
      return call("getDue", false, async (client) =>
        (
          await client.query<ScheduleRow>(
            "SELECT * FROM ownware.schedules WHERE enabled=TRUE AND next_run_at IS NOT NULL AND next_run_at<=$1 ORDER BY next_run_at",
            [now],
          )
        ).rows.map(schedule),
      );
    },
    update(value, patch) {
      return call("update", true, async (client) => {
        const current = await getOn(client, value);
        if (current === null) return null;
        const deliver =
          patch.deliver !== undefined
            ? patch.deliver === null
              ? null
              : ScheduleDeliverToSchema.parse(patch.deliver)
            : current.deliver;
        const m = {
          name: patch.name ?? current.name,
          prompt: patch.prompt ?? current.prompt,
          model: patch.model !== undefined ? patch.model : current.model,
          cadenceKind: CadenceKindSchema.parse(
            patch.cadenceKind ?? current.cadenceKind,
          ),
          cadenceExpr: patch.cadenceExpr ?? current.cadenceExpr,
          cadenceDisplay: patch.cadenceDisplay ?? current.cadenceDisplay,
          timezone: patch.timezone ?? current.timezone,
          catchUpPolicy: CatchUpPolicySchema.parse(
            patch.catchUpPolicy ?? current.catchUpPolicy,
          ),
          catchUpWindowMs:
            patch.catchUpWindowMs !== undefined
              ? patch.catchUpWindowMs
              : current.catchUpWindowMs,
          overlapPolicy: OverlapPolicySchema.parse(
            patch.overlapPolicy ?? current.overlapPolicy,
          ),
          skipWeekends: patch.skipWeekends ?? current.skipWeekends,
          skipHolidays: patch.skipHolidays ?? current.skipHolidays,
          toolEnvelope:
            patch.toolEnvelope !== undefined
              ? patch.toolEnvelope
              : current.toolEnvelope,
          safetyLevel: SafetyLevelSchema.parse(
            patch.safetyLevel ?? current.safetyLevel,
          ),
          deliveryMode: DeliveryModeSchema.parse(
            patch.deliveryMode ?? current.deliveryMode,
          ),
          quietOnEmpty: patch.quietOnEmpty ?? current.quietOnEmpty,
          enabled: patch.enabled ?? current.enabled,
          state: ScheduleStateSchema.parse(patch.state ?? current.state),
        };
        await client.query(
          `UPDATE ownware.schedules SET name=$1,prompt=$2,model=$3,cadence_kind=$4,
        cadence_expr=$5,cadence_display=$6,timezone=$7,catch_up_policy=$8,catch_up_window_ms=$9,
        overlap_policy=$10,skip_weekends=$11,skip_holidays=$12,tool_envelope=$13,safety_level=$14,
        delivery_mode=$15,quiet_on_empty=$16,deliver_channel=$17,deliver_target=$18,enabled=$19,state=$20,updated_at=$21 WHERE id=$22`,
          [
            m.name,
            m.prompt,
            m.model,
            m.cadenceKind,
            m.cadenceExpr,
            m.cadenceDisplay,
            m.timezone,
            m.catchUpPolicy,
            m.catchUpWindowMs,
            m.overlapPolicy,
            m.skipWeekends,
            m.skipHolidays,
            m.toolEnvelope == null ? null : JSON.stringify(m.toolEnvelope),
            m.safetyLevel,
            m.deliveryMode,
            m.quietOnEmpty,
            deliver?.channel ?? null,
            deliver?.target ?? null,
            m.enabled,
            m.state,
            Date.now(),
            value,
          ],
        );
        return getOn(client, value);
      });
    },
    setEnabled(value, enabled) {
      return this.update(value, {
        enabled,
        state: enabled ? "scheduled" : "paused",
      });
    },
    advance(value, input) {
      return call("advance", true, async (client) => {
        const cur = await getOn(client, value);
        if (cur === null) return null;
        await client.query(
          `UPDATE ownware.schedules SET next_run_at=$1,last_run_at=$2,last_run_id=$3,state=$4,updated_at=$5 WHERE id=$6`,
          [
            input.nextRunAt,
            input.lastRunAt !== undefined ? input.lastRunAt : cur.lastRunAt,
            input.lastRunId !== undefined ? input.lastRunId : cur.lastRunId,
            ScheduleStateSchema.parse(input.state ?? cur.state),
            Date.now(),
            value,
          ],
        );
        return getOn(client, value);
      });
    },
    delete(value) {
      return call(
        "delete",
        true,
        async (client) =>
          (
            await client.query("DELETE FROM ownware.schedules WHERE id=$1", [
              value,
            ])
          ).rowCount === 1,
      );
    },
    recordRunAndAdvance(params) {
      return call("recordRunAndAdvance", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const value = await insertRun(client, params.run);
          const current = await getOn(client, params.scheduleId);
          if (current === null) throw new Error("schedule missing");
          await client.query(
            `UPDATE ownware.schedules SET next_run_at=$1,last_run_at=$2,last_run_id=$3,state=$4,updated_at=$5 WHERE id=$6`,
            [
              params.advance.nextRunAt,
              params.advance.lastRunAt !== undefined
                ? params.advance.lastRunAt
                : current.lastRunAt,
              value.id,
              ScheduleStateSchema.parse(params.advance.state ?? current.state),
              Date.now(),
              params.scheduleId,
            ],
          );
          return value;
        }),
      );
    },
    recordRun(input) {
      return call("recordRun", true, (client) => insertRun(client, input));
    },
    getRun(value) {
      return call("getRun", false, (client) => getRunOn(client, value));
    },
    updateRun(value, patch) {
      return call("updateRun", true, async (client) => {
        const cur = await getRunOn(client, value);
        if (cur === null) return null;
        await client.query(
          `UPDATE ownware.schedule_runs SET thread_id=$1,started_at=$2,finished_at=$3,
        run_status=$4,skip_reason=$5,error_category=$6,error_message=$7,delivery_status=$8 WHERE id=$9`,
          [
            patch.threadId !== undefined ? patch.threadId : cur.threadId,
            patch.startedAt !== undefined ? patch.startedAt : cur.startedAt,
            patch.finishedAt !== undefined ? patch.finishedAt : cur.finishedAt,
            RunStatusSchema.parse(patch.runStatus ?? cur.runStatus),
            patch.skipReason !== undefined ? patch.skipReason : cur.skipReason,
            patch.errorCategory !== undefined
              ? patch.errorCategory
              : cur.errorCategory,
            patch.errorMessage !== undefined
              ? patch.errorMessage
              : cur.errorMessage,
            DeliveryStatusSchema.parse(
              patch.deliveryStatus ?? cur.deliveryStatus,
            ),
            value,
          ],
        );
        return getRunOn(client, value);
      });
    },
    failInterruptedRuns(now, message = "Interrupted by restart") {
      return call(
        "failInterruptedRuns",
        true,
        async (client) =>
          (
            await client.query(
              `UPDATE ownware.schedule_runs SET run_status='failed-to-run',error_message=$1,finished_at=$2 WHERE run_status='running'`,
              [message, now],
            )
          ).rowCount ?? 0,
      );
    },
    listRuns(scheduleId, limit = 50) {
      return call("listRuns", false, async (client) =>
        (
          await client.query<RunRow>(
            "SELECT * FROM ownware.schedule_runs WHERE schedule_id=$1 ORDER BY scheduled_for DESC LIMIT $2",
            [scheduleId, limit],
          )
        ).rows.map(run),
      );
    },
    listRecentRuns(limit = 50, opts = {}) {
      return call("listRecentRuns", false, async (client) =>
        (
          await client.query<
            RunRow & { schedule_name: string; schedule_profile_id: string }
          >(
            `SELECT r.*,s.name AS schedule_name,s.profile_id AS schedule_profile_id FROM ownware.schedule_runs r
       JOIN ownware.schedules s ON s.id=r.schedule_id ${opts.runningOnly === true ? "WHERE r.run_status='running'" : ""}
       ORDER BY r.scheduled_for DESC LIMIT $1`,
            [limit],
          )
        ).rows.map(
          (row) =>
            ({
              ...run(row),
              scheduleName: row.schedule_name,
              profileId: row.schedule_profile_id,
            }) as RecentRunDto,
        ),
      );
    },
  };
}

export function createPostgreSqlApprovalRepository(
  context: PostgreSqlRootRepositoryContext,
): ApprovalRepository {
  const call = <T>(
    op: string,
    write: boolean,
    fn: Parameters<typeof repositoryCall<T>>[4],
  ) =>
    repositoryCall(
      context,
      "schedule_approvals",
      op,
      write ? "write_failed" : "read_failed",
      fn,
    );
  const getOn = async (
    client: Parameters<
      Parameters<typeof repositoryCall<ApprovalDto | null>>[4]
    >[0],
    value: string,
  ) => {
    const row = (
      await client.query<ApprovalRow>(
        `SELECT approval.*,binding.intent_revision,binding.operation_hash,
          binding.policy_revision,binding.tool_revision,binding.target_revision,
          claim.claimed_at
        FROM ownware.schedule_approvals AS approval
        LEFT JOIN ownware.schedule_approval_bindings AS binding
          ON binding.approval_id=approval.id
        LEFT JOIN ownware.schedule_approval_claims AS claim
          ON claim.approval_id=approval.id
        WHERE approval.id=$1`,
        [value],
      )
    ).rows[0];
    return row === undefined ? null : approval(row);
  };
  return {
    create(input) {
      return call("create", true, async () => {
        const value = id("appr"), now = Date.now();
        const threadId = input.threadId ?? null;
        const operationHash = scheduleApprovalOperationHash({
          approvalId: value,
          scheduleId: input.scheduleId,
          runId: input.runId,
          threadId,
          toolName: input.toolName,
          toolInput: input.toolInput,
          policyRevision: input.policyRevision,
          toolRevision: input.toolRevision,
          targetRevision: input.targetRevision ?? null,
        });
        return withPostgreSqlTransaction(context.pool, async (client) => {
          await client.query(
          `INSERT INTO ownware.schedule_approvals
      (id,schedule_id,run_id,thread_id,tool_name,tool_input,summary,status,result,error_message,created_at,decided_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',NULL,NULL,$8,NULL)`,
          [
            value,
            input.scheduleId,
            input.runId,
            threadId,
            input.toolName,
            JSON.stringify(input.toolInput ?? null),
            input.summary,
            now,
          ],
        );
          await client.query(
            `INSERT INTO ownware.schedule_approval_bindings
              (approval_id,intent_revision,operation_hash,policy_revision,
               tool_revision,target_revision,bound_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              value,
              SCHEDULE_APPROVAL_INTENT_REVISION,
              operationHash,
              input.policyRevision,
              input.toolRevision,
              input.targetRevision ?? null,
              now,
            ],
          );
          return (await getOn(client, value))!;
        });
      });
    },
    get(value) {
      return call("get", false, (client) => getOn(client, value));
    },
    listByRun(runId) {
      return call("listByRun", false, async (client) =>
        (
          await client.query<ApprovalRow>(
            `SELECT approval.*,binding.intent_revision,binding.operation_hash,
              binding.policy_revision,binding.tool_revision,binding.target_revision,
              claim.claimed_at
             FROM ownware.schedule_approvals AS approval
             LEFT JOIN ownware.schedule_approval_bindings AS binding
               ON binding.approval_id=approval.id
             LEFT JOIN ownware.schedule_approval_claims AS claim
               ON claim.approval_id=approval.id
             WHERE approval.run_id=$1 ORDER BY approval.created_at DESC`,
            [runId],
          )
        ).rows.map(approval),
      );
    },
    listPending(opts = {}) {
      return call("listPending", false, async (client) => {
        const values: unknown[] = [];
        let filter = "";
        if (opts.profileId !== undefined) {
          values.push(opts.profileId);
          filter = ` AND s.profile_id=$${values.length}`;
        }
        values.push(
          opts.limit !== undefined && opts.limit > 0
            ? Math.min(opts.limit, 500)
            : 200,
        );
        return (
          await client.query<
            ApprovalRow & { schedule_name: string; schedule_profile_id: string }
          >(
            `SELECT a.*,binding.intent_revision,binding.operation_hash,
              binding.policy_revision,binding.tool_revision,binding.target_revision,
              claim.claimed_at,s.name AS schedule_name,s.profile_id AS schedule_profile_id
             FROM ownware.schedule_approvals a
             JOIN ownware.schedules s ON s.id=a.schedule_id
             JOIN ownware.schedule_approval_bindings binding ON binding.approval_id=a.id
             LEFT JOIN ownware.schedule_approval_claims claim ON claim.approval_id=a.id
             WHERE a.status='pending'${filter}
             ORDER BY a.created_at DESC LIMIT $${values.length}`,
            values,
          )
        ).rows.map(
          (row) =>
            ({
              ...approval(row),
              scheduleName: row.schedule_name,
              profileId: row.schedule_profile_id,
            }) as PendingApprovalDto,
        );
      });
    },
    countPending(profileId) {
      return call("countPending", false, async (client) =>
        safeInteger(
          (
            await client.query<{ n: unknown }>(
              profileId === undefined
                ? `SELECT COUNT(*) AS n FROM ownware.schedule_approvals WHERE status='pending'`
                : `SELECT COUNT(*) AS n FROM ownware.schedule_approvals a JOIN ownware.schedules s ON s.id=a.schedule_id WHERE a.status='pending' AND s.profile_id=$1`,
              profileId === undefined ? [] : [profileId],
            )
          ).rows[0]!.n,
        ),
      );
    },
    countPendingForRun(runId) {
      return call("countPendingForRun", false, async (client) =>
        safeInteger(
          (
            await client.query<{ n: unknown }>(
              `SELECT COUNT(*) AS n FROM ownware.schedule_approvals WHERE run_id=$1 AND status='pending'`,
              [runId],
            )
          ).rows[0]!.n,
        ),
      );
    },
    claim(value) {
      return call("claim", true, async () =>
        withPostgreSqlTransaction(context.pool, async (client): Promise<ClaimApprovalResult> => {
          const row = (
            await client.query<ApprovalRow>(
              `SELECT approval.*,binding.intent_revision,binding.operation_hash,
                binding.policy_revision,binding.tool_revision,binding.target_revision,
                claim.claimed_at
               FROM ownware.schedule_approvals AS approval
               LEFT JOIN ownware.schedule_approval_bindings AS binding
                 ON binding.approval_id=approval.id
               LEFT JOIN ownware.schedule_approval_claims AS claim
                 ON claim.approval_id=approval.id
               WHERE approval.id=$1
               FOR UPDATE OF approval`,
              [value],
            )
          ).rows[0];
          if (row === undefined) return { status: "missing", approval: null };
          const current = approval(row);
          if (current.status === "executing" || current.claimedAt !== null) {
            return { status: "already_claimed", approval: current };
          }
          if (current.status !== "pending") {
            return { status: "not_pending", approval: current };
          }
          let recomputed: string | null = null;
          try {
            if (
              row.intent_revision != null
              && safeInteger(row.intent_revision) === SCHEDULE_APPROVAL_INTENT_REVISION
              && row.operation_hash != null
              && row.policy_revision != null
              && row.tool_revision != null
            ) {
              recomputed = scheduleApprovalOperationHash({
                approvalId: row.id,
                scheduleId: row.schedule_id,
                runId: row.run_id,
                threadId: row.thread_id,
                toolName: row.tool_name,
                toolInput: json(row.tool_input),
                policyRevision: row.policy_revision,
                toolRevision: row.tool_revision,
                targetRevision: row.target_revision ?? null,
              });
            }
          } catch {
            recomputed = null;
          }
          const now = Date.now();
          if (recomputed === null || recomputed !== row.operation_hash) {
            await client.query(
              `UPDATE ownware.schedule_approvals
               SET status='indeterminate',
                 error_message='The stored approval identity no longer matches the reviewed action.',
                 decided_at=$1
               WHERE id=$2 AND status='pending'`,
              [now, value],
            );
            return { status: "intent_mismatch", approval: (await getOn(client, value))! };
          }
          await client.query(
            `INSERT INTO ownware.schedule_approval_claims
              (approval_id,operation_hash,claimed_at) VALUES ($1,$2,$3)`,
            [value, row.operation_hash, now],
          );
          const changed = await client.query(
            `UPDATE ownware.schedule_approvals SET status='executing'
             WHERE id=$1 AND status='pending' RETURNING id`,
            [value],
          );
          if (changed.rowCount !== 1) {
            throw new Error("Schedule approval claim lost its lifecycle transition");
          }
          const claimed = (await getOn(client, value))!;
          return {
            status: "claimed",
            approval: {
              ...claimed,
              status: "executing",
              operationHash: row.operation_hash,
              policyRevision: row.policy_revision!,
              toolRevision: row.tool_revision!,
              targetRevision: row.target_revision ?? null,
            } satisfies ClaimedApproval,
          };
        }),
      );
    },
    recoverInterruptedClaims() {
      return call("recoverInterruptedClaims", true, async (client) => {
        const result = await client.query(
          `UPDATE ownware.schedule_approvals AS approval
           SET status='indeterminate',
             error_message=COALESCE(
               approval.error_message,
               'Ownware restarted after this action was claimed; its external effect is unknown.'
             ),
             decided_at=$1
           WHERE approval.status='executing'
             AND EXISTS (
               SELECT 1 FROM ownware.schedule_approval_claims AS claim
               WHERE claim.approval_id=approval.id
             )`,
          [Date.now()],
        );
        return result.rowCount ?? 0;
      });
    },
    decide(value, input) {
      return call("decide", true, async (client) => {
        const status = ApprovalStatusSchema.parse(input.status);
        if (status === "pending" || status === "executing") {
          throw new TypeError("Schedule approval terminal status is invalid");
        }
        const expected = status === "discarded" ? "pending" : "executing";
        await client.query(
          `UPDATE ownware.schedule_approvals AS approval
           SET status=$1,result=$2,error_message=$3,decided_at=$4
           WHERE approval.id=$5 AND approval.status=$6
             AND (
               $1='discarded'
               OR EXISTS (
                 SELECT 1 FROM ownware.schedule_approval_claims AS claim
                 WHERE claim.approval_id=approval.id
               )
             )`,
          [
            status,
            input.result !== undefined ? JSON.stringify(input.result) : null,
            input.errorMessage ?? null,
            Date.now(),
            value,
            expected,
          ],
        );
        return getOn(client, value);
      });
    },
  };
}

export function createPostgreSqlTaskRepository(
  context: PostgreSqlRootRepositoryContext,
  bus: TaskEventBus,
): TaskRepository {
  const call = <T>(
    op: string,
    write: boolean,
    fn: Parameters<typeof repositoryCall<T>>[4],
  ) =>
    repositoryCall(
      context,
      "tasks",
      op,
      write ? "write_failed" : "read_failed",
      fn,
    );
  const list = async (
    client: Parameters<Parameters<typeof repositoryCall<TaskDto[]>>[4]>[0],
    threadId: string,
  ) =>
    (
      await client.query<TaskRow>(
        "SELECT * FROM ownware.tasks WHERE thread_id=$1 ORDER BY list_order",
        [threadId],
      )
    ).rows.map(task);
  return {
    listForThread(threadId) {
      if (threadId.length === 0) return Promise.resolve([]);
      return call("listForThread", false, (client) => list(client, threadId));
    },
    replaceAllForThread(threadId, tasks) {
      if (threadId.length === 0) return Promise.resolve([]);
      return call("replaceAllForThread", true, async () => {
        const now = new Date().toISOString();
        const stored = await withPostgreSqlTransaction(
          context.pool,
          async (client) => {
            await client.query(
              "SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",
              ["tasks.replace_all", threadId],
            );
            await client.query("DELETE FROM ownware.tasks WHERE thread_id=$1", [
              threadId,
            ]);
            const result: TaskDto[] = [];
            for (const [order, item] of tasks.entries()) {
              const status = TaskStatusSchema.parse(item.status),
                value = id("task");
              await client.query(
                `INSERT INTO ownware.tasks(id,thread_id,content,status,list_order,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)`,
                [value, threadId, item.content, status, order, now],
              );
              result.push({
                id: value,
                threadId,
                content: item.content,
                status,
                order,
                createdAt: now,
                updatedAt: now,
              });
            }
            return result;
          },
        );
        bus.emit({ type: "tasks.updated", threadId, tasks: stored, at: now });
        return stored;
      });
    },
    updateStatus(threadId, taskId, status) {
      if (threadId.length === 0 || taskId.length === 0)
        return Promise.resolve(null);
      return call("updateStatus", true, async (client) => {
        const now = new Date().toISOString();
        const updated = await client.query(
          `UPDATE ownware.tasks SET status=$1,updated_at=$2 WHERE id=$3 AND thread_id=$4`,
          [TaskStatusSchema.parse(status), now, taskId, threadId],
        );
        if (updated.rowCount !== 1) return null;
        const rows = await list(client, threadId);
        const value = rows.find((item) => item.id === taskId) ?? null;
        if (value !== null)
          bus.emit({ type: "tasks.updated", threadId, tasks: rows, at: now });
        return value;
      });
    },
  };
}
