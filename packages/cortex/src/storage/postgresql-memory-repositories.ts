import { randomUUID } from "node:crypto";
import type { MemoryEventBus } from "../memory/event-bus.js";
import {
  MemoryKindSchema,
  MemoryScopeSchema,
  MemorySourceSchema,
  MemoryStatusSchema,
  ProposalStatusSchema,
  type Memory,
  type MemoryProposal,
  type UserIdentity,
} from "../memory/schema.js";
import type { PostgreSqlRootRepositoryContext } from "./postgresql-adapter.js";
import type {
  MemoryProposalRepository,
  MemoryRepository,
  UserIdentityRepository,
} from "./platform-repositories.js";
import {
  finiteNumber,
  repositoryCall,
  safeInteger,
  withPostgreSqlTransaction,
} from "./postgresql-repository.js";

interface MemoryRow {
  readonly id: string;
  readonly profile_id: string;
  readonly scope: string;
  readonly scope_id: string | null;
  readonly kind: string;
  readonly content: string;
  readonly source: string;
  readonly source_thread_id: string | null;
  readonly source_proposal_id: string | null;
  readonly confidence: unknown;
  readonly status: string;
  readonly superseded_by: string | null;
  readonly pinned: boolean;
  readonly reference_count: unknown;
  readonly last_referenced_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}
interface ProposalRow {
  readonly id: string;
  readonly profile_id: string;
  readonly thread_id: string;
  readonly proposed_content: string;
  readonly proposed_kind: string;
  readonly status: string;
  readonly resolved_content: string | null;
  readonly resolved_memory_id: string | null;
  readonly rejection_reason: string | null;
  readonly created_at: string;
  readonly resolved_at: string | null;
}
interface IdentityRow {
  readonly name: string | null;
  readonly role: string | null;
  readonly company: string | null;
  readonly timezone: string | null;
  readonly pronouns: string | null;
  readonly preferences: string | null;
  readonly updated_at: string;
}
const EMPTY: UserIdentity = {
  name: null,
  role: null,
  company: null,
  timezone: null,
  pronouns: null,
  preferences: null,
  updatedAt: null,
};
const newId = (prefix: string, length = 16) =>
  `${prefix}_${randomUUID().replaceAll("-", "").slice(0, length)}`;
function memory(row: MemoryRow): Memory {
  return {
    id: row.id,
    profileId: row.profile_id,
    scope: MemoryScopeSchema.parse(row.scope),
    scopeId: row.scope_id,
    kind: MemoryKindSchema.parse(row.kind),
    content: row.content,
    source: MemorySourceSchema.parse(row.source),
    sourceThreadId: row.source_thread_id,
    sourceProposalId: row.source_proposal_id,
    confidence: finiteNumber(row.confidence),
    status: MemoryStatusSchema.parse(row.status),
    supersededBy: row.superseded_by,
    pinned: row.pinned,
    referenceCount: safeInteger(row.reference_count),
    lastReferencedAt: row.last_referenced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function proposal(row: ProposalRow): MemoryProposal {
  return {
    id: row.id,
    profileId: row.profile_id,
    threadId: row.thread_id,
    proposedContent: row.proposed_content,
    proposedKind: MemoryKindSchema.parse(row.proposed_kind),
    status: ProposalStatusSchema.parse(row.status),
    resolvedContent: row.resolved_content,
    resolvedMemoryId: row.resolved_memory_id,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

type QueryClient = Parameters<Parameters<typeof repositoryCall<unknown>>[4]>[0];
async function getMemory(
  client: QueryClient,
  id: string,
): Promise<Memory | null> {
  const row = (
    await client.query<MemoryRow>(
      "SELECT * FROM ownware.memories WHERE id=$1",
      [id],
    )
  ).rows[0];
  return row === undefined ? null : memory(row);
}
async function insertMemory(
  client: QueryClient,
  input: Parameters<MemoryRepository["create"]>[0],
): Promise<Memory> {
  const id = newId("mem"),
    now = new Date().toISOString();
  await client.query(
    `INSERT INTO ownware.memories
  (id,profile_id,scope,scope_id,kind,content,source,source_thread_id,source_proposal_id,confidence,status,superseded_by,pinned,reference_count,last_referenced_at,created_at,updated_at)
  VALUES($1,$2,'agent',NULL,$3,$4,$5,$6,$7,$8,'active',NULL,$9,0,NULL,$10,$10)`,
    [
      id,
      input.profileId,
      input.kind ?? "fact",
      input.content,
      input.source,
      input.sourceThreadId ?? null,
      input.sourceProposalId ?? null,
      input.confidence ?? (input.source === "user_pinned" ? 1 : 0.8),
      input.pinned ?? false,
      now,
    ],
  );
  return (await getMemory(client, id))!;
}

export function createPostgreSqlMemoryRepository(
  context: PostgreSqlRootRepositoryContext,
  bus: MemoryEventBus,
): MemoryRepository {
  const call = <T>(
    op: string,
    write: boolean,
    fn: Parameters<typeof repositoryCall<T>>[4],
  ) =>
    repositoryCall(
      context,
      "memories",
      op,
      write ? "write_failed" : "read_failed",
      fn,
    );
  return {
    getById(id) {
      return call("getById", false, (client) => getMemory(client, id));
    },
    loadActiveForPrompt(profileId, limit) {
      if (limit <= 0) return Promise.resolve([]);
      return call("loadActiveForPrompt", false, async (client) =>
        (
          await client.query<MemoryRow>(
            `SELECT * FROM ownware.memories WHERE profile_id=$1 AND status='active' ORDER BY pinned DESC,last_referenced_at DESC NULLS LAST,confidence DESC,created_at DESC LIMIT $2`,
            [profileId, limit],
          )
        ).rows.map(memory),
      );
    },
    recordReferences(ids) {
      if (ids.length === 0) return Promise.resolve();
      return call("recordReferences", true, async (client) => {
        await client.query(
          `UPDATE ownware.memories SET reference_count=reference_count+1,last_referenced_at=$1 WHERE id=ANY($2::text[])`,
          [new Date().toISOString(), ids],
        );
      });
    },
    listForProfile(profileId, options = {}) {
      return call("listForProfile", false, async (client) => {
        const status = options.status ?? "active",
          limit = options.limit ?? 200,
          offset = options.offset ?? 0;
        return (
          await client.query<MemoryRow>(
            `SELECT * FROM ownware.memories WHERE profile_id=$1 ${status === "all" ? "" : `AND status=$2`} ORDER BY ${status === "all" ? "(status='active') DESC," : ""} pinned DESC,last_referenced_at DESC NULLS LAST,confidence DESC,created_at DESC LIMIT $${status === "all" ? 2 : 3} OFFSET $${status === "all" ? 3 : 4}`,
            status === "all"
              ? [profileId, limit, offset]
              : [profileId, status, limit, offset],
          )
        ).rows.map(memory);
      });
    },
    countForProfile(profileId, status = "active") {
      return call("countForProfile", false, async (client) =>
        safeInteger(
          (
            await client.query<{ n: unknown }>(
              `SELECT COUNT(*) AS n FROM ownware.memories WHERE profile_id=$1 ${status === "all" ? "" : "AND status=$2"}`,
              status === "all" ? [profileId] : [profileId, status],
            )
          ).rows[0]!.n,
        ),
      );
    },
    create(input) {
      return call("create", true, async (client) => {
        const value = await insertMemory(client, input);
        bus.emit({
          type: "memory.changed",
          profileId: value.profileId,
          memoryId: value.id,
          at: value.createdAt,
        });
        return value;
      });
    },
    update(id, input) {
      return call("update", true, async (client) => {
        const sets: string[] = [],
          values: unknown[] = [];
        for (const [key, value] of Object.entries({
          content: input.content,
          kind: input.kind,
          pinned: input.pinned,
          status: input.status,
        })) {
          if (value !== undefined) {
            values.push(value);
            sets.push(`${key}=$${values.length}`);
          }
        }
        if (sets.length === 0) return getMemory(client, id);
        values.push(new Date().toISOString());
        sets.push(`updated_at=$${values.length}`);
        values.push(id);
        await client.query(
          `UPDATE ownware.memories SET ${sets.join(",")} WHERE id=$${values.length}`,
          values,
        );
        const value = await getMemory(client, id);
        if (value !== null)
          bus.emit({
            type: "memory.changed",
            profileId: value.profileId,
            memoryId: id,
            at: value.updatedAt,
          });
        return value;
      });
    },
    remove(id) {
      return call("remove", true, async (client) => {
        const existing = await getMemory(client, id);
        if (existing === null) return false;
        const result = await client.query(
          "DELETE FROM ownware.memories WHERE id=$1",
          [id],
        );
        if (result.rowCount === 1)
          bus.emit({
            type: "memory.changed",
            profileId: existing.profileId,
            memoryId: id,
            at: new Date().toISOString(),
          });
        return result.rowCount === 1;
      });
    },
    supersede(oldId, input) {
      return call("supersede", true, async () => {
        const now = new Date().toISOString();
        const value = await withPostgreSqlTransaction(
          context.pool,
          async (client) => {
            const created = await insertMemory(client, input);
            const marked = await client.query(
              `UPDATE ownware.memories SET status='superseded',superseded_by=$1,updated_at=$2 WHERE id=$3 AND status='active'`,
              [created.id, now, oldId],
            );
            if (marked.rowCount !== 1)
              throw new Error("Memory supersession target is not active.");
            return created;
          },
        );
        bus.emit({
          type: "memory.changed",
          profileId: value.profileId,
          memoryId: value.id,
          at: now,
        });
        return value;
      });
    },
  };
}

export function createPostgreSqlMemoryProposalRepository(
  context: PostgreSqlRootRepositoryContext,
  bus: MemoryEventBus,
): MemoryProposalRepository {
  const call = <T>(
    op: string,
    write: boolean,
    fn: Parameters<typeof repositoryCall<T>>[4],
  ) =>
    repositoryCall(
      context,
      "memory_proposals",
      op,
      write ? "write_failed" : "read_failed",
      fn,
    );
  const getOn = async (client: QueryClient, id: string) => {
    const row = (
      await client.query<ProposalRow>(
        "SELECT * FROM ownware.memory_proposals WHERE id=$1",
        [id],
      )
    ).rows[0];
    return row === undefined ? null : proposal(row);
  };
  const list = async (
    client: QueryClient,
    column: "profile_id" | "thread_id",
    value: string,
    options: { status?: string; limit?: number },
  ) => {
    const status = options.status ?? "pending";
    return (
      await client.query<ProposalRow>(
        `SELECT * FROM ownware.memory_proposals WHERE ${column}=$1 ${status === "all" ? "" : "AND status=$2"} ORDER BY ${column === "profile_id" && status === "all" ? "(status='pending') DESC," : ""} created_at DESC LIMIT $${status === "all" ? 2 : 3}`,
        status === "all"
          ? [value, options.limit ?? 100]
          : [value, status, options.limit ?? 100],
      )
    ).rows.map(proposal);
  };
  return {
    getById(id) {
      return call("getById", false, (client) => getOn(client, id));
    },
    listForProfile(profileId, options = {}) {
      return call("listForProfile", false, (client) =>
        list(client, "profile_id", profileId, options),
      );
    },
    listForThread(threadId, options = {}) {
      return call("listForThread", false, (client) =>
        list(client, "thread_id", threadId, options),
      );
    },
    countPendingForProfile(profileId) {
      return call("countPendingForProfile", false, async (client) =>
        safeInteger(
          (
            await client.query<{ n: unknown }>(
              `SELECT COUNT(*) AS n FROM ownware.memory_proposals WHERE profile_id=$1 AND status='pending'`,
              [profileId],
            )
          ).rows[0]!.n,
        ),
      );
    },
    async propose(input) {
      return (await this.proposeWithDisposition(input)).proposal;
    },
    proposeWithDisposition(input) {
      return call("proposeWithDisposition", true, async () => {
        const content = input.content.trim();
        if (content.length === 0)
          throw new Error("Proposal content cannot be empty.");
        const value = await withPostgreSqlTransaction(
          context.pool,
          async (client) => {
            await client.query(
              "SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",
              [input.threadId, content],
            );
            const existing = (
              await client.query<ProposalRow>(
                `SELECT * FROM ownware.memory_proposals WHERE thread_id=$1 AND status='pending' AND proposed_content=$2 ORDER BY created_at DESC LIMIT 1`,
                [input.threadId, content],
              )
            ).rows[0];
            if (existing !== undefined) {
              return { proposal: proposal(existing), created: false };
            }
            const id = newId("prop"),
              now = new Date().toISOString();
            await client.query(
              `INSERT INTO ownware.memory_proposals(id,profile_id,thread_id,proposed_content,proposed_kind,status,resolved_content,resolved_memory_id,rejection_reason,created_at,resolved_at) VALUES($1,$2,$3,$4,$5,'pending',NULL,NULL,NULL,$6,NULL)`,
              [
                id,
                input.profileId,
                input.threadId,
                content,
                input.kind ?? "fact",
                now,
              ],
            );
            return { proposal: (await getOn(client, id))!, created: true };
          },
        );
        if (value.created) {
          bus.emit({
            type: "memory.proposed",
            profileId: value.proposal.profileId,
            threadId: value.proposal.threadId,
            proposalId: value.proposal.id,
            at: value.proposal.createdAt,
          });
        }
        return value;
      });
    },
    accept(id, edits) {
      return call("accept", true, async () => {
        const now = new Date().toISOString();
        const value = await withPostgreSqlTransaction(
          context.pool,
          async (client) => {
            const row = (
              await client.query<ProposalRow>(
                "SELECT * FROM ownware.memory_proposals WHERE id=$1 FOR UPDATE",
                [id],
              )
            ).rows[0];
            if (row === undefined) return null;
            const existing = proposal(row);
            if (existing.status !== "pending")
              throw new Error(
                `Cannot accept proposal ${id}: status is not pending.`,
              );
            const content = (edits.content ?? existing.proposedContent).trim();
            if (content.length === 0)
              throw new Error("Final content cannot be empty.");
            const kind = edits.kind ?? existing.proposedKind,
              status =
                content !== existing.proposedContent ||
                kind !== existing.proposedKind
                  ? "edited"
                  : "accepted";
            const created = await insertMemory(client, {
              profileId: existing.profileId,
              content,
              kind,
              source: "agent_proposed",
              sourceThreadId: existing.threadId,
              sourceProposalId: id,
              confidence: edits.pinned ? 1 : 0.9,
              pinned: edits.pinned ?? false,
            });
            await client.query(
              `UPDATE ownware.memory_proposals SET status=$1,resolved_content=$2,resolved_memory_id=$3,resolved_at=$4 WHERE id=$5`,
              [status, content, created.id, now, id],
            );
            return { proposal: (await getOn(client, id))!, memory: created };
          },
        );
        if (value !== null) {
          bus.emit({
            type: "memory.changed",
            profileId: value.proposal.profileId,
            memoryId: value.memory.id,
            at: now,
          });
          bus.emit({
            type: "memory.proposal.resolved",
            profileId: value.proposal.profileId,
            proposalId: id,
            status: value.proposal.status,
            at: now,
          });
        }
        return value;
      });
    },
    reject(id, reason) {
      return call("reject", true, async (client) => {
        const existing = await getOn(client, id);
        if (existing === null) return null;
        if (existing.status !== "pending")
          throw new Error(
            `Cannot reject proposal ${id}: status is not pending.`,
          );
        const now = new Date().toISOString();
        await client.query(
          `UPDATE ownware.memory_proposals SET status='rejected',rejection_reason=$1,resolved_at=$2 WHERE id=$3 AND status='pending'`,
          [reason, now, id],
        );
        bus.emit({
          type: "memory.proposal.resolved",
          profileId: existing.profileId,
          proposalId: id,
          status: "rejected",
          at: now,
        });
        return getOn(client, id);
      });
    },
  };
}

export function createPostgreSqlUserIdentityRepository(
  context: PostgreSqlRootRepositoryContext,
  bus: MemoryEventBus,
): UserIdentityRepository {
  const call = <T>(
    op: string,
    write: boolean,
    fn: Parameters<typeof repositoryCall<T>>[4],
  ) =>
    repositoryCall(
      context,
      "user_identity",
      op,
      write ? "write_failed" : "read_failed",
      fn,
    );
  const getOn = async (client: QueryClient): Promise<UserIdentity> => {
    const row = (
      await client.query<IdentityRow>(
        `SELECT name,role,company,timezone,pronouns,preferences,updated_at FROM ownware.user_identity WHERE id='singleton'`,
      )
    ).rows[0];
    return row === undefined
      ? EMPTY
      : {
          name: row.name,
          role: row.role,
          company: row.company,
          timezone: row.timezone,
          pronouns: row.pronouns,
          preferences: row.preferences,
          updatedAt: row.updated_at,
        };
  };
  const render = (value: UserIdentity) => {
    const lines: string[] = [];
    if (value.name) lines.push(`- Name: ${value.name}`);
    if (value.pronouns) lines.push(`- Pronouns: ${value.pronouns}`);
    if (value.role) lines.push(`- Role: ${value.role}`);
    if (value.company) lines.push(`- Company: ${value.company}`);
    if (value.timezone) lines.push(`- Timezone: ${value.timezone}`);
    if (value.preferences) {
      lines.push("- Preferences:");
      for (const line of value.preferences.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) lines.push(`  - ${trimmed.replace(/^[-*]\s+/, "")}`);
      }
    }
    return lines.length === 0
      ? null
      : [
          "## About the user",
          'These are facts the user has shared in their global "About you" settings. Apply them when answering — never ask for information already listed below.',
          ...lines,
        ].join("\n");
  };
  return {
    get() {
      return call("get", false, getOn);
    },
    set(input) {
      return call("set", true, async (client) => {
        const current = await getOn(client),
          now = new Date().toISOString(),
          merged = {
            name: input.name === undefined ? current.name : input.name,
            role: input.role === undefined ? current.role : input.role,
            company:
              input.company === undefined ? current.company : input.company,
            timezone:
              input.timezone === undefined ? current.timezone : input.timezone,
            pronouns:
              input.pronouns === undefined ? current.pronouns : input.pronouns,
            preferences:
              input.preferences === undefined
                ? current.preferences
                : input.preferences,
          };
        await client.query(
          `INSERT INTO ownware.user_identity(id,name,role,company,timezone,pronouns,preferences,created_at,updated_at) VALUES('singleton',$1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,role=EXCLUDED.role,company=EXCLUDED.company,timezone=EXCLUDED.timezone,pronouns=EXCLUDED.pronouns,preferences=EXCLUDED.preferences,updated_at=EXCLUDED.updated_at`,
          [
            merged.name,
            merged.role,
            merged.company,
            merged.timezone,
            merged.pronouns,
            merged.preferences,
            now,
          ],
        );
        bus.emit({ type: "memory.identity.changed", at: now });
        return { ...merged, updatedAt: now };
      });
    },
    renderForPrompt() {
      return call("renderForPrompt", false, async (client) =>
        render(await getOn(client)),
      );
    },
  };
}
