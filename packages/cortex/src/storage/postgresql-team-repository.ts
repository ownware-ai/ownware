import { randomUUID } from "node:crypto";
import {
  TASK_STATUS_TRANSITIONS,
  TEAM_TASK_STATUSES,
  type Team,
  type TeamConductorEscalation,
  type TeamLease,
  type TeamMember,
  type TeamMemberAutonomy,
  type TeamRun,
  type TeamRunReceipt,
  type TeamRunStatus,
  type TeamTask,
  type TeamTaskKind,
  type TeamTaskStatus,
} from "../team/schema.js";
import type { PostgreSqlRootRepositoryContext } from "./postgresql-adapter.js";
import type { TeamRepository } from "./platform-repositories.js";
import {
  finiteNumber,
  repositoryCall,
  safeInteger,
  withPostgreSqlTransaction,
} from "./postgresql-repository.js";

interface TeamRow {
  readonly id: string;
  readonly name: string;
  readonly display_name: string;
  readonly charter: string;
  readonly charter_identity: string | null;
  readonly charter_principles: string | null;
  readonly charter_workflow: string | null;
  readonly charter_done_means: string | null;
  readonly charter_rules: string | null;
  readonly charter_voice: string | null;
  readonly conductor_name: string;
  readonly conductor_model: string | null;
  readonly conductor_escalation: string;
  readonly conductor_instructions: string | null;
  readonly surface: string;
  readonly max_cost_usd: unknown | null;
  readonly created_at: string;
  readonly updated_at: string;
}
interface MemberRow {
  readonly team_id: string;
  readonly slug: string;
  readonly profile_id: string;
  readonly role: string;
  readonly instructions: string | null;
  readonly model: string | null;
  readonly autonomy: string;
  readonly tool_restricts: string;
  readonly position: unknown;
}
interface RefRow {
  readonly name: string;
  readonly content: string;
  readonly position: unknown;
}
interface ConnectorRow {
  readonly toolkit: string;
  readonly position: unknown;
}
interface RunRow {
  readonly id: string;
  readonly team_id: string;
  readonly thread_id: string;
  readonly workspace_id: string | null;
  readonly status: string;
  readonly cost_usd: unknown;
  readonly max_cost_usd: unknown | null;
  readonly receipt: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}
interface TaskRow {
  readonly id: string;
  readonly run_id: string;
  readonly seq: unknown;
  readonly parent_id: string | null;
  readonly kind: string;
  readonly title: string;
  readonly brief: string;
  readonly done_criteria: string;
  readonly deliverables: string;
  readonly depends_on: string;
  readonly owner: string | null;
  readonly filed_by: string;
  readonly resource_hints: string;
  readonly status: string;
  readonly result: string | null;
  readonly blocked_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}
interface LeaseRow {
  readonly run_id: string;
  readonly resource_key: string;
  readonly task_id: string;
  readonly agent_id: string;
  readonly last_activity_at: string;
}
type Client = Parameters<Parameters<typeof repositoryCall<unknown>>[4]>[0];
const id = (prefix: string) =>
    `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
  now = () => new Date().toISOString();
function strings(value: string, column: string): readonly string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string"))
    throw new Error(`${column} is invalid`);
  return parsed as string[];
}
const member = (row: MemberRow): TeamMember => ({
  slug: row.slug,
  profileId: row.profile_id,
  role: row.role,
  ...(row.instructions === null ? {} : { instructions: row.instructions }),
  ...(row.model === null ? {} : { model: row.model }),
  autonomy: (row.autonomy as TeamMemberAutonomy) ?? "inherit",
  toolRestricts: [...strings(row.tool_restricts, "tool_restricts")],
});
const run = (row: RunRow): TeamRun => ({
  id: row.id,
  teamId: row.team_id,
  threadId: row.thread_id,
  workspaceId: row.workspace_id,
  status: row.status as TeamRunStatus,
  costUsd: finiteNumber(row.cost_usd),
  maxCostUsd: row.max_cost_usd === null ? null : finiteNumber(row.max_cost_usd),
  receipt:
    row.receipt === null ? null : (JSON.parse(row.receipt) as TeamRunReceipt),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const task = (row: TaskRow): TeamTask => {
  if (!(TEAM_TASK_STATUSES as readonly string[]).includes(row.status))
    throw new Error("team task status is invalid");
  return {
    id: row.id,
    runId: row.run_id,
    seq: safeInteger(row.seq),
    parentId: row.parent_id,
    kind: row.kind as TeamTaskKind,
    title: row.title,
    brief: row.brief,
    doneCriteria: row.done_criteria,
    deliverables: strings(row.deliverables, "deliverables"),
    dependsOn: strings(row.depends_on, "depends_on"),
    owner: row.owner,
    filedBy: row.filed_by,
    resourceHints: strings(row.resource_hints, "resource_hints"),
    status: row.status as TeamTaskStatus,
    result: row.result,
    blockedReason: row.blocked_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};
const lease = (row: LeaseRow): TeamLease => ({
  runId: row.run_id,
  resourceKey: row.resource_key,
  taskId: row.task_id,
  agentId: row.agent_id,
  lastActivityAt: row.last_activity_at,
});
async function hydrate(client: Client, row: TeamRow): Promise<Team> {
  const members = await client.query<MemberRow>(
    "SELECT * FROM ownware.team_members WHERE team_id=$1 ORDER BY position",
    [row.id],
  );
  const refs = await client.query<RefRow>(
    "SELECT * FROM ownware.team_references WHERE team_id=$1 ORDER BY position",
    [row.id],
  );
  const connectors = await client.query<ConnectorRow>(
    "SELECT * FROM ownware.team_connectors WHERE team_id=$1 ORDER BY position",
    [row.id],
  );
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    charter: row.charter,
    fragments: {
      ...(row.charter_identity === null
        ? {}
        : { identity: row.charter_identity }),
      ...(row.charter_principles === null
        ? {}
        : { principles: row.charter_principles }),
      ...(row.charter_workflow === null
        ? {}
        : { workflow: row.charter_workflow }),
      ...(row.charter_done_means === null
        ? {}
        : { doneMeans: row.charter_done_means }),
      ...(row.charter_rules === null ? {} : { rules: row.charter_rules }),
      ...(row.charter_voice === null ? {} : { voice: row.charter_voice }),
    },
    conductorName: row.conductor_name,
    conductorModel: row.conductor_model,
    conductorEscalation:
      (row.conductor_escalation as TeamConductorEscalation) ?? "balanced",
    conductorInstructions: row.conductor_instructions,
    surface: row.surface ?? "ownware",
    references: refs.rows.map((item) => ({
      name: item.name,
      content: item.content,
    })),
    composioToolkits: connectors.rows.map((item) => item.toolkit),
    maxCostUsd:
      row.max_cost_usd === null ? null : finiteNumber(row.max_cost_usd),
    members: members.rows.map(member),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
async function getTeam(client: Client, column: "id" | "name", value: string) {
  const row = (
    await client.query<TeamRow>(
      `SELECT * FROM ownware.teams WHERE ${column}=$1`,
      [value],
    )
  ).rows[0];
  return row === undefined ? null : hydrate(client, row);
}
async function getRun(
  client: Client,
  column: "id" | "thread_id",
  value: string,
) {
  const row = (
    await client.query<RunRow>(
      `SELECT * FROM ownware.team_runs WHERE ${column}=$1`,
      [value],
    )
  ).rows[0];
  return row === undefined ? null : run(row);
}
async function getTask(client: Client, id: string, lock = false) {
  const row = (
    await client.query<TaskRow>(
      `SELECT * FROM ownware.team_tasks WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
      [id],
    )
  ).rows[0];
  return row === undefined ? null : task(row);
}
async function setStatus(
  client: Client,
  idValue: string,
  status: TeamTaskStatus,
  blockedReason?: string | null,
) {
  const current = await getTask(client, idValue, true);
  if (current === null) throw new Error("unknown team task");
  if (current.status === status) return current;
  if (!TASK_STATUS_TRANSITIONS[current.status].includes(status))
    throw new Error(
      `Illegal task status transition ${current.status} → ${status}`,
    );
  await client.query(
    "UPDATE ownware.team_tasks SET status=$1,blocked_reason=$2,updated_at=$3 WHERE id=$4",
    [status, blockedReason ?? null, now(), idValue],
  );
  if (current.status === "active")
    await client.query("DELETE FROM ownware.team_leases WHERE task_id=$1", [
      idValue,
    ]);
  return (await getTask(client, idValue))!;
}
async function writeMembers(
  client: Client,
  teamId: string,
  members: readonly TeamMember[],
) {
  for (const [position, item] of members.entries())
    await client.query(
      `INSERT INTO ownware.team_members(team_id,slug,profile_id,role,instructions,model,autonomy,tool_restricts,position) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        teamId,
        item.slug,
        item.profileId,
        item.role,
        item.instructions ?? null,
        item.model ?? null,
        item.autonomy ?? "inherit",
        JSON.stringify(item.toolRestricts ?? []),
        position,
      ],
    );
}

export function createPostgreSqlTeamRepository(
  context: PostgreSqlRootRepositoryContext,
): TeamRepository {
  const call = <T>(
    op: string,
    write: boolean,
    fn: Parameters<typeof repositoryCall<T>>[4],
  ) =>
    repositoryCall(
      context,
      "teams",
      op,
      write ? "write_failed" : "read_failed",
      fn,
    );
  return {
    createTeam(input) {
      return call("createTeam", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const value = id("team"),
            ts = now();
          await client.query(
            `INSERT INTO ownware.teams(id,name,display_name,charter,charter_identity,charter_principles,charter_workflow,charter_done_means,charter_rules,charter_voice,conductor_name,conductor_model,conductor_escalation,conductor_instructions,surface,max_cost_usd,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)`,
            [
              value,
              input.name,
              input.displayName,
              input.charter,
              input.fragments?.identity ?? null,
              input.fragments?.principles ?? null,
              input.fragments?.workflow ?? null,
              input.fragments?.doneMeans ?? null,
              input.fragments?.rules ?? null,
              input.fragments?.voice ?? null,
              input.conductorName,
              input.conductorModel ?? null,
              input.conductorEscalation ?? "balanced",
              input.conductorInstructions ?? null,
              input.surface ?? "ownware",
              input.maxCostUsd ?? null,
              ts,
            ],
          );
          await writeMembers(client, value, input.members);
          for (const [position, item] of (input.references ?? []).entries())
            await client.query(
              "INSERT INTO ownware.team_references(team_id,position,name,content) VALUES($1,$2,$3,$4)",
              [value, position, item.name, item.content],
            );
          for (const [position, item] of (
            input.composioToolkits ?? []
          ).entries())
            await client.query(
              "INSERT INTO ownware.team_connectors(team_id,position,toolkit) VALUES($1,$2,$3)",
              [value, position, item],
            );
          return (await getTeam(client, "id", value))!;
        }),
      );
    },
    getTeam(value) {
      return call("getTeam", false, (client) => getTeam(client, "id", value));
    },
    getTeamByName(value) {
      return call("getTeamByName", false, (client) =>
        getTeam(client, "name", value),
      );
    },
    listTeams() {
      return call("listTeams", false, async (client) => {
        const rows = (
          await client.query<TeamRow>(
            "SELECT * FROM ownware.teams ORDER BY updated_at DESC",
          )
        ).rows;
        return Promise.all(rows.map((row) => hydrate(client, row)));
      });
    },
    updateTeam(teamId, input) {
      return call("updateTeam", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",
            ["teams.update", teamId],
          );
          const current = await getTeam(client, "id", teamId);
          if (current === null) return null;
          const fragments = input.fragments ?? current.fragments,
            ts = now();
          await client.query(
            `UPDATE ownware.teams SET display_name=$1,charter=$2,charter_identity=$3,charter_principles=$4,charter_workflow=$5,charter_done_means=$6,charter_rules=$7,charter_voice=$8,conductor_name=$9,conductor_model=$10,conductor_escalation=$11,conductor_instructions=$12,surface=$13,max_cost_usd=$14,updated_at=$15 WHERE id=$16`,
            [
              input.displayName ?? current.displayName,
              input.charter ?? current.charter,
              fragments.identity ?? null,
              fragments.principles ?? null,
              fragments.workflow ?? null,
              fragments.doneMeans ?? null,
              fragments.rules ?? null,
              fragments.voice ?? null,
              input.conductorName ?? current.conductorName,
              input.conductorModel === undefined
                ? current.conductorModel
                : input.conductorModel,
              input.conductorEscalation ?? current.conductorEscalation,
              input.conductorInstructions === undefined
                ? current.conductorInstructions
                : input.conductorInstructions,
              input.surface ?? current.surface,
              input.maxCostUsd === undefined
                ? current.maxCostUsd
                : input.maxCostUsd,
              ts,
              teamId,
            ],
          );
          if (input.members !== undefined) {
            await client.query(
              "DELETE FROM ownware.team_members WHERE team_id=$1",
              [teamId],
            );
            await writeMembers(client, teamId, input.members);
          }
          if (input.references !== undefined) {
            await client.query(
              "DELETE FROM ownware.team_references WHERE team_id=$1",
              [teamId],
            );
            for (const [position, item] of input.references.entries())
              await client.query(
                "INSERT INTO ownware.team_references(team_id,position,name,content) VALUES($1,$2,$3,$4)",
                [teamId, position, item.name, item.content],
              );
          }
          if (input.composioToolkits !== undefined) {
            await client.query(
              "DELETE FROM ownware.team_connectors WHERE team_id=$1",
              [teamId],
            );
            for (const [position, item] of input.composioToolkits.entries())
              await client.query(
                "INSERT INTO ownware.team_connectors(team_id,position,toolkit) VALUES($1,$2,$3)",
                [teamId, position, item],
              );
          }
          return getTeam(client, "id", teamId);
        }),
      );
    },
    deleteTeam(value) {
      return call(
        "deleteTeam",
        true,
        async (client) =>
          (await client.query("DELETE FROM ownware.teams WHERE id=$1", [value]))
            .rowCount === 1,
      );
    },
    createRun(teamId, threadId, workspaceId) {
      return call("createRun", true, async (client) => {
        const team = await getTeam(client, "id", teamId);
        if (team === null) throw new Error("unknown team");
        const value = id("teamrun"),
          ts = now();
        await client.query(
          `INSERT INTO ownware.team_runs(id,team_id,thread_id,workspace_id,status,cost_usd,max_cost_usd,receipt,created_at,updated_at) VALUES($1,$2,$3,$4,'active',0,$5,NULL,$6,$6)`,
          [value, teamId, threadId, workspaceId, team.maxCostUsd, ts],
        );
        return (await getRun(client, "id", value))!;
      });
    },
    setRunBudget(value, max) {
      return call("setRunBudget", true, async (client) => {
        if (
          (
            await client.query(
              "UPDATE ownware.team_runs SET max_cost_usd=$1,updated_at=$2 WHERE id=$3",
              [max, now(), value],
            )
          ).rowCount !== 1
        )
          throw new Error("unknown team run");
      });
    },
    getRun(value) {
      return call("getRun", false, (client) => getRun(client, "id", value));
    },
    getRunByThread(value) {
      return call("getRunByThread", false, (client) =>
        getRun(client, "thread_id", value),
      );
    },
    listRunsForTeam(teamId) {
      return call("listRunsForTeam", false, async (client) =>
        (
          await client.query<RunRow>(
            "SELECT * FROM ownware.team_runs WHERE team_id=$1 ORDER BY updated_at DESC",
            [teamId],
          )
        ).rows.map(run),
      );
    },
    listActiveRuns() {
      return call("listActiveRuns", false, async (client) =>
        (
          await client.query<RunRow>(
            `SELECT * FROM ownware.team_runs WHERE status='active' ORDER BY created_at`,
          )
        ).rows.map(run),
      );
    },
    setRunStatus(value, status, receipt) {
      return call("setRunStatus", true, async (client) => {
        if (
          (
            await client.query(
              "UPDATE ownware.team_runs SET status=$1,receipt=$2,updated_at=$3 WHERE id=$4",
              [
                status,
                receipt === null ? null : JSON.stringify(receipt),
                now(),
                value,
              ],
            )
          ).rowCount !== 1
        )
          throw new Error("unknown team run");
      });
    },
    addRunCost(value, cost) {
      if (!Number.isFinite(cost) || cost <= 0) return Promise.resolve();
      return call("addRunCost", true, async (client) => {
        await client.query(
          "UPDATE ownware.team_runs SET cost_usd=cost_usd+$1,updated_at=$2 WHERE id=$3",
          [cost, now(), value],
        );
      });
    },
    insertTask(runId, input) {
      return call("insertTask", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            runId,
          ]);
          const seq = safeInteger(
              (
                await client.query<{ next: unknown }>(
                  `SELECT COALESCE(MAX(seq),0)+1 AS next FROM ownware.team_tasks WHERE run_id=$1`,
                  [runId],
                )
              ).rows[0]!.next,
            ),
            value = id("tt"),
            ts = now();
          await client.query(
            `INSERT INTO ownware.team_tasks(id,run_id,seq,parent_id,kind,title,brief,done_criteria,deliverables,depends_on,owner,filed_by,resource_hints,status,result,blocked_reason,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULL,NULL,$15,$15)`,
            [
              value,
              runId,
              seq,
              input.parentId ?? null,
              input.kind,
              input.title,
              input.brief,
              input.doneCriteria ?? "",
              JSON.stringify(input.deliverables ?? []),
              JSON.stringify(input.dependsOn ?? []),
              input.owner ?? null,
              input.filedBy,
              JSON.stringify(input.resourceHints ?? []),
              input.status ?? "ready",
              ts,
            ],
          );
          return (await getTask(client, value))!;
        }),
      );
    },
    getTask(value) {
      return call("getTask", false, (client) => getTask(client, value));
    },
    getTaskBySeq(runId, seq) {
      return call("getTaskBySeq", false, async (client) => {
        const row = (
          await client.query<TaskRow>(
            "SELECT * FROM ownware.team_tasks WHERE run_id=$1 AND seq=$2",
            [runId, seq],
          )
        ).rows[0];
        return row === undefined ? null : task(row);
      });
    },
    listTasks(runId) {
      return call("listTasks", false, async (client) =>
        (
          await client.query<TaskRow>(
            "SELECT * FROM ownware.team_tasks WHERE run_id=$1 ORDER BY seq",
            [runId],
          )
        ).rows.map(task),
      );
    },
    setTaskStatus(value, status, reason) {
      return call("setTaskStatus", true, () =>
        withPostgreSqlTransaction(context.pool, (client) =>
          setStatus(client, value, status, reason),
        ),
      );
    },
    completeTask(caller, value, result) {
      return call("completeTask", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const current = await getTask(client, value);
          if (current === null) throw new Error("unknown team task");
          if (current.owner !== caller)
            throw new Error("caller does not own task");
          if (current.status !== "active")
            throw new Error("task is not active");
          await client.query(
            "UPDATE ownware.team_tasks SET result=$1,updated_at=$2 WHERE id=$3",
            [result, now(), value],
          );
          return setStatus(client, value, "done");
        }),
      );
    },
    assignTask(value, owner) {
      return call("assignTask", true, async (client) => {
        if (
          (
            await client.query(
              "UPDATE ownware.team_tasks SET owner=$1,updated_at=$2 WHERE id=$3",
              [owner, now(), value],
            )
          ).rowCount !== 1
        )
          throw new Error("unknown team task");
        return (await getTask(client, value))!;
      });
    },
    updateTaskStructure(value, input) {
      return call("updateTaskStructure", true, async (client) => {
        const current = await getTask(client, value);
        if (current === null) throw new Error("unknown team task");
        await client.query(
          `UPDATE ownware.team_tasks SET title=$1,brief=$2,done_criteria=$3,deliverables=$4,depends_on=$5,resource_hints=$6,updated_at=$7 WHERE id=$8`,
          [
            input.title ?? current.title,
            input.brief ?? current.brief,
            input.doneCriteria ?? current.doneCriteria,
            JSON.stringify(input.deliverables ?? current.deliverables),
            JSON.stringify(input.dependsOn ?? current.dependsOn),
            JSON.stringify(input.resourceHints ?? current.resourceHints),
            now(),
            value,
          ],
        );
        return (await getTask(client, value))!;
      });
    },
    acquireLease(params) {
      return call("acquireLease", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const row = (
            await client.query<LeaseRow>(
              "SELECT * FROM ownware.team_leases WHERE run_id=$1 AND resource_key=$2 FOR UPDATE",
              [params.runId, params.resourceKey],
            )
          ).rows[0];
          if (row !== undefined && row.task_id !== params.taskId)
            return { acquired: false, holder: lease(row) };
          if (row !== undefined)
            await client.query(
              "UPDATE ownware.team_leases SET last_activity_at=$1 WHERE run_id=$2 AND resource_key=$3",
              [now(), params.runId, params.resourceKey],
            );
          else {
            const inserted = await client.query(
              `INSERT INTO ownware.team_leases(run_id,resource_key,task_id,agent_id,last_activity_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(run_id,resource_key) DO NOTHING`,
              [
                params.runId,
                params.resourceKey,
                params.taskId,
                params.agentId,
                now(),
              ],
            );
            if (inserted.rowCount !== 1) {
              const holder = (
                await client.query<LeaseRow>(
                  "SELECT * FROM ownware.team_leases WHERE run_id=$1 AND resource_key=$2",
                  [params.runId, params.resourceKey],
                )
              ).rows[0]!;
              return { acquired: false, holder: lease(holder) };
            }
          }
          return { acquired: true };
        }),
      );
    },
    renewLeasesForAgent(runId, agentId) {
      return call("renewLeasesForAgent", true, async (client) => {
        await client.query(
          "UPDATE ownware.team_leases SET last_activity_at=$1 WHERE run_id=$2 AND agent_id=$3",
          [now(), runId, agentId],
        );
      });
    },
    listLeases(runId) {
      return call("listLeases", false, async (client) =>
        (
          await client.query<LeaseRow>(
            "SELECT * FROM ownware.team_leases WHERE run_id=$1 ORDER BY resource_key",
            [runId],
          )
        ).rows.map(lease),
      );
    },
    answerQuestion(value, answer) {
      return call("answerQuestion", true, () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const current = await getTask(client, value);
          if (current === null) throw new Error("unknown team task");
          if (current.kind !== "question")
            throw new Error("task is not a question");
          if (current.status !== "ready" && current.status !== "active")
            throw new Error("task cannot be answered");
          await client.query(
            "UPDATE ownware.team_tasks SET result=$1,updated_at=$2 WHERE id=$3",
            [answer, now(), value],
          );
          return setStatus(client, value, "done");
        }),
      );
    },
  };
}
