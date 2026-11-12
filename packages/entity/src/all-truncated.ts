// Single responsibility: say, in development and test, that `.all()` dropped a next page. `.all()`
// answers one page (`DEFAULT_PAGE_SIZE` rows unless the chain says `.limit(n)`), and a caller that
// meant "every row" learns otherwise only from a missing row. Refusing is a break, so it waits for
// `next`; until then the warning is a `log.record` the exercise step can surface as a finding.

import { DEFAULT_ENVIRONMENT, logger, tryResolveEnvironment } from '@ultimat3/core';
import { DEFAULT_PAGE_SIZE } from './plan';

/** The one log message this writes: a subscriber matches `log.record`'s `message` against it. */
export const ALL_TRUNCATED = 'entity.all.truncated';

/**
 * Called by `.all()` with the page's `nextCursor`. Silent with no next page, when the chain said
 * `.limit(n)` (one page is what it asked for), and in staging or production — the warning is for
 * the author, and staging exists to behave as production does. `env` is the test seam.
 */
export function reportTruncatedAll(
  entity: string,
  next: string | null,
  explicitLimit: boolean,
  env?: Readonly<Record<string, string | undefined>>,
): void {
  if (next === null || explicitLimit) return;
  const environment = tryResolveEnvironment(env === undefined ? undefined : { env });
  const at = environment ?? DEFAULT_ENVIRONMENT;
  if (at !== 'development' && at !== 'test') return;
  logger.warn(ALL_TRUNCATED, {
    entity,
    pageSize: DEFAULT_PAGE_SIZE,
    cause: `${entity}.….all() answered its first ${DEFAULT_PAGE_SIZE} rows and dropped the cursor to the rest`,
    fix: `${entity}.….inBatches(1000) to visit every row, one page per statement — or .limit(${DEFAULT_PAGE_SIZE}) on the chain to state that one page is meant`,
  });
}
