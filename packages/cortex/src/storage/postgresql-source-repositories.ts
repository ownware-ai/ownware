import type { EvidenceSearchCache } from '../gateway/evidence-search-cache.js'
import {
  DEFAULT_SOURCE_QUOTA_LIMITS,
  type SourceQuotaLimits,
} from '../gateway/source-quota-policy.js'
import type { PostgreSqlRootRepositoryContext } from './postgresql-adapter.js'
import { createPostgreSqlSourceDataViewRepository } from './postgresql-source-data-view-repository.js'
import { createPostgreSqlSourceDeletionRepository } from './postgresql-source-deletion-repository.js'
import {
  createPostgreSqlSourceRepository,
  createPostgreSqlSourceUploadRepository,
} from './postgresql-source-foundation.js'
import { createPostgreSqlSourceJobRepository } from './postgresql-source-job-repository.js'
import type { SourceRepositories } from './source-repositories.js'

export interface PostgreSqlSourceRepositoryOptions {
  readonly quotaLimits?: SourceQuotaLimits
  readonly evidenceSearchCache?: EvidenceSearchCache
}

/** Compose the complete PostgreSQL source authority with one shared quota policy. */
export function createPostgreSqlSourceRepositories(
  context: PostgreSqlRootRepositoryContext,
  options: PostgreSqlSourceRepositoryOptions = {},
): SourceRepositories {
  const quotaLimits = options.quotaLimits ?? DEFAULT_SOURCE_QUOTA_LIMITS
  return {
    sources: createPostgreSqlSourceRepository(context, quotaLimits),
    uploads: createPostgreSqlSourceUploadRepository(
      context,
      quotaLimits,
      options.evidenceSearchCache,
    ),
    jobs: createPostgreSqlSourceJobRepository(context, quotaLimits),
    dataViews: createPostgreSqlSourceDataViewRepository(context, quotaLimits),
    deletions: createPostgreSqlSourceDeletionRepository(
      context,
      options.evidenceSearchCache,
    ),
    quotaLimits,
  }
}
