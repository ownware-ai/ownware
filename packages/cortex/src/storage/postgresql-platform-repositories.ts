import type { MemoryEventBus } from "../memory/event-bus.js";
import type { TaskEventBus } from "../tasks/event-bus.js";
import type { PostgreSqlRootRepositoryContext } from "./postgresql-adapter.js";
import { createPostgreSqlCandidateRepository } from "./postgresql-candidate-repository.js";
import { createPostgreSqlChannelJobRepository } from "./postgresql-channel-job-repository.js";
import { createPostgreSqlConnectorConnectionsRepository } from "./postgresql-connector-repository.js";
import {
  createPostgreSqlMemoryProposalRepository,
  createPostgreSqlMemoryRepository,
  createPostgreSqlUserIdentityRepository,
} from "./postgresql-memory-repositories.js";
import type { PlatformRepositories } from "./platform-repositories.js";
import {
  createPostgreSqlApprovalRepository,
  createPostgreSqlScheduleRepository,
  createPostgreSqlTaskRepository,
} from "./postgresql-schedule-repositories.js";
import { createPostgreSqlTeamRepository } from "./postgresql-team-repository.js";

export interface PostgreSqlPlatformRepositoryOptions {
  readonly taskEvents: TaskEventBus;
  readonly memoryEvents: MemoryEventBus;
}

/** PostgreSQL implementation of every durable platform repository port. */
export function createPostgreSqlPlatformRepositories(
  context: PostgreSqlRootRepositoryContext,
  options: PostgreSqlPlatformRepositoryOptions,
): PlatformRepositories {
  return {
    connectorConnections:
      createPostgreSqlConnectorConnectionsRepository(context),
    channelJobs: createPostgreSqlChannelJobRepository(context),
    schedules: createPostgreSqlScheduleRepository(context),
    approvals: createPostgreSqlApprovalRepository(context),
    tasks: createPostgreSqlTaskRepository(context, options.taskEvents),
    memories: createPostgreSqlMemoryRepository(context, options.memoryEvents),
    memoryProposals: createPostgreSqlMemoryProposalRepository(
      context,
      options.memoryEvents,
    ),
    userIdentity: createPostgreSqlUserIdentityRepository(
      context,
      options.memoryEvents,
    ),
    candidates: createPostgreSqlCandidateRepository(context),
    teams: createPostgreSqlTeamRepository(context),
  };
}
