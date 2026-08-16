import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChannelJobConflictError } from "../../../src/gateway/channel-job-store.js";
import { MemoryEventBus } from "../../../src/memory/event-bus.js";
import type { CoreStorageRepositories } from "../../../src/storage/core-repositories.js";
import { validateStoragePlan } from "../../../src/storage/config.js";
import { PostgreSqlStorageAdapter } from "../../../src/storage/postgresql-adapter.js";
import { createPostgreSqlCoreRepositories } from "../../../src/storage/postgresql-core-repositories.js";
import { createPostgreSqlPlatformRepositories } from "../../../src/storage/postgresql-platform-repositories.js";
import type { PlatformRepositories } from "../../../src/storage/platform-repositories.js";
import { TaskEventBus } from "../../../src/tasks/event-bus.js";
import {
  runPlatformRepositoryContract,
  type PlatformRepositoryHarness,
  type PlatformRepositoryPeer,
} from "../../storage/platform-repositories-contract.js";
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from "../../storage/postgresql-test-database.js";

interface RootRepositories {
  readonly core: CoreStorageRepositories;
  readonly platform: PlatformRepositories;
}

const TEST_URL = configuredPostgreSqlTestUrl();

if (TEST_URL === undefined) {
  describe.skip("platform storage repository contract — postgresql", () => {
    it("requires OWNWARE_TEST_POSTGRES_URL", () => {});
  });
} else {
  runPlatformRepositoryContract(
    "postgresql",
    async (): Promise<PlatformRepositoryHarness> => {
      const database = await createDisposablePostgreSqlDatabase(TEST_URL);
      const plan = validateStoragePlan(
        {
          storage: {
            kind: "postgresql",
            runtimeConnection: {
              source: "provider",
              resolve: () => database.url,
            },
            tls: { mode: "disable", allowInsecureLoopback: true },
          },
        },
        "/unused.db",
      );
      if (plan.kind !== "postgresql")
        throw new Error("Expected PostgreSQL plan.");

      const peers = new Set<
        PostgreSqlStorageAdapter<RootRepositories, object>
      >();
      async function open(): Promise<
        PostgreSqlStorageAdapter<RootRepositories, object>
      > {
        const adapter = new PostgreSqlStorageAdapter<RootRepositories, object>({
          plan,
          repositories: {
            createRoot: (context) => ({
              core: createPostgreSqlCoreRepositories(context),
              platform: createPostgreSqlPlatformRepositories(context, {
                taskEvents: new TaskEventBus(),
                memoryEvents: new MemoryEventBus(),
              }),
            }),
            createTransaction: () => ({}),
          },
        });
        await adapter.initialize();
        return adapter;
      }

      let adapter = await open();
      async function closePeer(
        peer: PostgreSqlStorageAdapter<RootRepositories, object>,
      ) {
        if (!peers.delete(peer)) return;
        await peer.close();
      }
      return {
        get repositories() {
          return adapter.repositories.platform;
        },
        get core() {
          return adapter.repositories.core;
        },
        async openPeer(): Promise<PlatformRepositoryPeer> {
          const peer = await open();
          peers.add(peer);
          return {
            repositories: peer.repositories.platform,
            close: () => closePeer(peer),
          };
        },
        async reopen() {
          await adapter.close();
          adapter = await open();
        },
        async close() {
          await Promise.all([...peers].map(closePeer));
          await adapter.close().catch(() => {});
          await database.close();
        },
      };
    },
  );

  describe("postgresql platform repository extended parity", () => {
    let database: Awaited<
      ReturnType<typeof createDisposablePostgreSqlDatabase>
    >;
    let adapter: PostgreSqlStorageAdapter<RootRepositories, object>;

    beforeEach(async () => {
      database = await createDisposablePostgreSqlDatabase(TEST_URL);
      const plan = validateStoragePlan(
        {
          storage: {
            kind: "postgresql",
            runtimeConnection: {
              source: "provider",
              resolve: () => database.url,
            },
            tls: { mode: "disable", allowInsecureLoopback: true },
          },
        },
        "/unused.db",
      );
      if (plan.kind !== "postgresql")
        throw new Error("Expected PostgreSQL plan.");
      adapter = new PostgreSqlStorageAdapter({
        plan,
        repositories: {
          createRoot: (context) => ({
            core: createPostgreSqlCoreRepositories(context),
            platform: createPostgreSqlPlatformRepositories(context, {
              taskEvents: new TaskEventBus(),
              memoryEvents: new MemoryEventBus(),
            }),
          }),
          createTransaction: () => ({}),
        },
      });
      await adapter.initialize();
    });

    afterEach(async () => {
      await adapter.close().catch(() => {});
      await database.close();
    });

    it("covers connector inventory, reconciliation and terminal transitions", async () => {
      const store = adapter.repositories.platform.connectorConnections;
      const first = await store.upsertPending({
        connectionId: "conn-a",
        connectorId: "gmail",
        source: "composio",
        entityId: "owner",
        expiresAt: 100,
      });
      await store.touchPolled(first.connectionId, 10);
      await store.touchVerified(first.connectionId, 11);
      expect(await store.findLastVerifiedAt("gmail", "composio")).toBe(11);
      expect(
        await store.findActive("gmail", "composio", "owner"),
      ).toMatchObject({ connectionId: "conn-a" });
      expect(
        await store.listActiveByStatus("composio", "pending", "owner"),
      ).toHaveLength(1);
      expect(await store.findPending()).toHaveLength(1);
      expect(await store.countForeignEntities("someone-else")).toBe(1);
      const page = await store.listInventory("owner", { limit: 10 });
      expect(page.items).toHaveLength(1);
      expect(await store.expireStaleOnBoot(101)).toBe(1);
      expect((await store.markExpired(first.connectionId))?.transitioned).toBe(
        false,
      );

      const second = await store.upsertPending({
        connectionId: "conn-b",
        connectorId: "calendar",
        source: "composio",
        entityId: "owner",
      });
      expect(
        (
          await store.markReady({
            connectionId: second.connectionId,
            vendorAccountId: "vendor",
          })
        ).transitioned,
      ).toBe(true);
      expect(
        (await store.markUnhealthy(second.connectionId, "vendor disabled", 120))
          ?.transitioned,
      ).toBe(true);
      const third = await store.upsertPending({
        connectionId: "conn-c",
        connectorId: "drive",
        source: "composio",
        entityId: "owner",
      });
      expect(
        (await store.markRevoked(third.connectionId, "user disconnected"))
          ?.transitioned,
      ).toBe(true);
      const fourth = await store.upsertPending({
        connectionId: "conn-d",
        connectorId: "slack",
        source: "composio",
        entityId: "owner",
      });
      expect(
        (
          await store.markFailed({
            connectionId: fourth.connectionId,
            reason: "denied",
          })
        ).transitioned,
      ).toBe(true);
    });

    it("covers channel gates, retries, receipts and cancellation recovery", async () => {
      const store = adapter.repositories.platform.channelJobs;
      const job = await store.enqueue(
        {
          profileId: "extended",
          operation: "connect_chat",
          channelKind: "chat",
          params: {},
          stepCount: 2,
        },
        100,
      );
      await expect(
        store.enqueue(
          {
            profileId: "extended",
            operation: "connect_chat",
            channelKind: "chat",
            params: {},
            stepCount: 2,
          },
          101,
        ),
      ).rejects.toBeInstanceOf(ChannelJobConflictError);
      const claim = await store.claimNext("worker", 110);
      expect(claim?.jobId).toBe(job.jobId);
      expect(await store.renewLease(job.jobId, claim!.claimToken, 111)).toBe(
        "ok",
      );
      expect(
        await store.parkForGate(
          job.jobId,
          claim!.claimToken,
          {
            id: "connect_chat:consent",
            title: "Connect?",
            included: ["Connect chat"],
            excluded: ["No sending"],
            onDecline: "Nothing changes",
          },
          112,
        ),
      ).toBe("parked");
      expect(
        await store.respondToGate(
          job.jobId,
          {
            gateId: "connect_chat:consent",
            action: "approve",
            actor: "operator",
          },
          113,
        ),
      ).toBe("accepted");
      const resumed = await store.claimNext("worker", 114);
      expect(
        await store.consumeGateResponse(
          job.jobId,
          resumed!.claimToken,
          0,
          "connect_chat:consent",
          115,
        ),
      ).toBe("advanced");
      expect(
        await store.deferUntil(job.jobId, resumed!.claimToken, 200, 116),
      ).toBe("deferred");
      expect(await store.claimNext("worker", 199)).toBeNull();
      const retried = await store.claimNext("worker", 200);
      expect(
        await store.advanceCheckpoint(
          job.jobId,
          retried!.claimToken,
          1,
          { ready: true },
          201,
        ),
      ).toBe("advanced");
      await store.appendReceipt(
        {
          jobId: job.jobId,
          profileId: "extended",
          kind: "connected",
          title: "Connected",
          body: { credentialId: "handle" },
        },
        202,
      );
      expect(
        await store.finish(
          job.jobId,
          retried!.claimToken,
          "succeeded",
          "complete",
          203,
        ),
      ).toBe("finished");
      expect(await store.receiptsForJob(job.jobId)).toHaveLength(2);
      expect(await store.receiptsForProfile("extended")).toHaveLength(2);

      const cancelled = await store.enqueue(
        {
          profileId: "extended",
          operation: "disconnect_chat",
          channelKind: "chat",
          params: {},
          stepCount: 1,
        },
        300,
      );
      expect(await store.requestCancel(cancelled.jobId, 301)).toBe("requested");
      expect(await store.confirmNextUnclaimedCancellation(302)).toBe(true);
      expect((await store.get(cancelled.jobId))?.state).toBe("cancelled");
      expect(await store.recoverExpiredClaims(1_000_000)).toEqual({
        requeued: 0,
        failed: 0,
        cancelled: 0,
      });
    });

    it("covers schedule history, approval inbox and memory lifecycle reads", async () => {
      const platform = adapter.repositories.platform;
      const schedule = await platform.schedules.create({
        profileId: "extended",
        name: "Daily",
        prompt: "Review",
        cadenceKind: "daily",
        cadenceExpr: '{"time":"09:00"}',
        cadenceDisplay: "Daily",
        timezone: "UTC",
        nextRunAt: 100,
      });
      expect(await platform.schedules.getDue(100)).toHaveLength(1);
      expect(
        await platform.schedules.list({
          profileId: "extended",
          enabledOnly: true,
        }),
      ).toHaveLength(1);
      expect(
        await platform.schedules.update(schedule.id, {
          name: "Updated",
          skipWeekends: true,
        }),
      ).toMatchObject({ name: "Updated", skipWeekends: true });
      expect(
        await platform.schedules.setEnabled(schedule.id, false),
      ).toMatchObject({ enabled: false, state: "paused" });
      const run = await platform.schedules.recordRun({
        scheduleId: schedule.id,
        scheduledFor: 100,
        runStatus: "running",
        startedAt: 100,
      });
      const approval = await platform.approvals.create({
        scheduleId: schedule.id,
        runId: run.id,
        toolName: "send",
        toolInput: {},
        summary: "Send",
        policyRevision: "a".repeat(64),
        toolRevision: "b".repeat(64),
        targetRevision: null,
      });
      expect(await platform.approvals.countPending()).toBe(1);
      expect(await platform.approvals.countPendingForRun(run.id)).toBe(1);
      expect(
        await platform.approvals.listPending({ profileId: "extended" }),
      ).toHaveLength(1);
      expect(await platform.approvals.listByRun(run.id)).toHaveLength(1);
      expect(await platform.approvals.claim(approval.id)).toMatchObject({
        status: "claimed",
      });
      expect(
        await platform.approvals.decide(approval.id, {
          status: "approved",
          result: { ok: true },
        }),
      ).toMatchObject({ status: "approved" });
      expect(
        await platform.schedules.updateRun(run.id, {
          deliveryStatus: "delivered",
        }),
      ).toMatchObject({ deliveryStatus: "delivered" });
      expect(await platform.schedules.listRuns(schedule.id)).toHaveLength(1);
      expect(await platform.schedules.listRecentRuns()).toHaveLength(1);
      expect(await platform.schedules.failInterruptedRuns(200)).toBe(1);
      expect(
        await platform.schedules.advance(schedule.id, { nextRunAt: 300 }),
      ).toMatchObject({ nextRunAt: 300 });

      const original = await platform.memories.create({
        profileId: "extended",
        content: "Fact",
        source: "user_pinned",
      });
      await platform.memories.recordReferences([original.id]);
      expect(
        await platform.memories.loadActiveForPrompt("extended", 10),
      ).toMatchObject([{ referenceCount: 1 }]);
      expect(await platform.memories.countForProfile("extended", "all")).toBe(
        1,
      );
      expect(
        await platform.memories.update(original.id, { kind: "preference" }),
      ).toMatchObject({ kind: "preference" });
      const replacement = await platform.memories.supersede(original.id, {
        profileId: "extended",
        content: "New fact",
        source: "reflection",
      });
      expect(
        await platform.memories.listForProfile("extended", { status: "all" }),
      ).toHaveLength(2);
      const rejected = await platform.memoryProposals.propose({
        profileId: "extended",
        threadId: "thread",
        content: "Maybe",
      });
      expect(
        await platform.memoryProposals.listForThread("thread"),
      ).toHaveLength(1);
      expect(
        await platform.memoryProposals.countPendingForProfile("extended"),
      ).toBe(1);
      expect(
        await platform.memoryProposals.reject(rejected.id, "No"),
      ).toMatchObject({ status: "rejected" });
      expect(await platform.memories.remove(replacement.id)).toBe(true);
      expect(await platform.schedules.delete(schedule.id)).toBe(true);
    });

    it("covers candidate routing/deletion and remaining team coordination methods", async () => {
      const { candidates, teams } = adapter.repositories.platform;
      const candidate = `sha256:${"b".repeat(64)}`;
      await candidates.begin(
        {
          candidateId: candidate,
          profileId: "extended",
          attemptId: "a",
          fileCount: 1,
          totalBytes: 2,
        },
        100,
      );
      await candidates.markReady(candidate, "a", 101);
      expect(
        (
          await candidates.compareAndSetActive(
            {
              profileId: "extended",
              candidateId: candidate,
              expectedActiveCandidateId: null,
            },
            102,
          )
        ).status,
      ).toBe("activated");
      const active = await candidates.getActive("extended", 102);
      expect(
        (
          await candidates.compareAndSetRouting(
            {
              profileId: "extended",
              expectedRevision: active!.deploymentRevision,
              routingState: "paused",
            },
            103,
          )
        ).status,
      ).toBe("changed");
      expect(
        await candidates.recordHealth({
          profileId: "extended",
          candidateId: candidate,
          health: "healthy",
          observedAt: 104,
        }),
      ).toBe(true);
      expect(await candidates.list("extended")).toHaveLength(1);
      const spare = `sha256:${"c".repeat(64)}`;
      await candidates.begin(
        {
          candidateId: spare,
          profileId: "extended",
          attemptId: "b",
          fileCount: 1,
          totalBytes: 2,
        },
        105,
      );
      await candidates.markReady(spare, "b", 106);
      expect(
        await candidates.deletionEligibility(
          { profileId: "extended", candidateId: spare },
          107,
        ),
      ).toBe("eligible");
      expect(
        (
          await candidates.beginDeletion(
            { profileId: "extended", candidateId: spare },
            108,
          )
        ).status,
      ).toBe("started");
      await candidates.markDeleteFailed(spare, "io", 109);
      expect(
        (
          await candidates.beginDeletion(
            { profileId: "extended", candidateId: spare },
            110,
          )
        ).status,
      ).toBe("started");
      await candidates.markDeleted(spare, 111);
      expect(await candidates.getDeletion(spare)).toMatchObject({
        state: "deleted",
      });
      const interrupted = `sha256:${"d".repeat(64)}`;
      await candidates.begin(
        {
          candidateId: interrupted,
          profileId: "extended",
          attemptId: "c",
          fileCount: 1,
          totalBytes: 2,
        },
        112,
      );
      expect(await candidates.recoverInterrupted(113)).toBe(1);
      await candidates.begin(
        {
          candidateId: interrupted,
          profileId: "extended",
          attemptId: "d",
          fileCount: 1,
          totalBytes: 2,
        },
        114,
      );
      await candidates.markCleanupFailed(interrupted, "d", 115);
      await candidates.markCleanupResolved(interrupted, "d", 116);

      const team = await teams.createTeam({
        name: "extended-team",
        displayName: "Extended",
        charter: "",
        conductorName: "Juno",
        members: [{ slug: "maya", profileId: "p", role: "Builder" }],
      });
      expect(await teams.getTeamByName("extended-team")).toMatchObject({
        id: team.id,
      });
      expect(await teams.listTeams()).toHaveLength(1);
      expect(
        await teams.updateTeam(team.id, { displayName: "Updated team" }),
      ).toMatchObject({ displayName: "Updated team" });
      const thread = await adapter.repositories.core.threads.create("extended");
      const run = await teams.createRun(team.id, thread.id, null);
      await teams.setRunBudget(run.id, 10);
      await teams.addRunCost(run.id, 1);
      expect(await teams.getRunByThread(thread.id)).toMatchObject({
        maxCostUsd: 10,
        costUsd: 1,
      });
      expect(await teams.listRunsForTeam(team.id)).toHaveLength(1);
      expect(await teams.listActiveRuns()).toHaveLength(1);
      const work = await teams.insertTask(run.id, {
        kind: "work",
        title: "Work",
        brief: "Do",
        filedBy: "conductor",
        owner: "maya",
      });
      expect(await teams.getTaskBySeq(run.id, 1)).toMatchObject({
        id: work.id,
      });
      expect(await teams.assignTask(work.id, "maya")).toMatchObject({
        owner: "maya",
      });
      expect(
        await teams.updateTaskStructure(work.id, { title: "Changed" }),
      ).toMatchObject({ title: "Changed" });
      expect(await teams.setTaskStatus(work.id, "active")).toMatchObject({
        status: "active",
      });
      expect(
        await teams.acquireLease({
          runId: run.id,
          resourceKey: "file",
          taskId: work.id,
          agentId: "maya",
        }),
      ).toEqual({ acquired: true });
      await teams.renewLeasesForAgent(run.id, "maya");
      expect(await teams.completeTask("maya", work.id, "Done")).toMatchObject({
        status: "done",
      });
      expect(await teams.listLeases(run.id)).toHaveLength(0);
      const question = await teams.insertTask(run.id, {
        kind: "question",
        title: "Question",
        brief: "Ask",
        filedBy: "maya",
      });
      expect(await teams.answerQuestion(question.id, "Answer")).toMatchObject({
        status: "done",
        result: "Answer",
      });
      await teams.setRunStatus(run.id, "done", null);
      expect(await teams.getRun(run.id)).toMatchObject({ status: "done" });
      expect(await teams.deleteTeam(team.id)).toBe(true);
    });
  });
}
