// Single responsibility: a write whose RESULT the app still has to judge. A rule with no CHECK
// (`kind: 'assert'`) is asserted on the rows a statement returned — after it was sent — so outside
// a transaction the violating row was committed and the refusal arrived too late to matter.

import { type DbClient, withTransaction } from '@ultimat3/db';
import type { EntityCore } from './entity';
import { hasJsOnlyInvariant } from './invariants';

/**
 * Runs `work` on the connection its statement and its judgement share. With an app-only rule
 * declared that is one transaction — a SAVEPOINT inside an open one — so the throw takes the write
 * with it. With none, a CHECK already refused the statement and this is `direct` and nothing else:
 * no `BEGIN`, no extra round trip.
 *
 * `direct` is resolved by the CALLER first, so a pinned repository inside a transaction opened on
 * some other client is still refused (`X_REPO_CLIENT_PINNED`) before anything opens. `pinned` is
 * that same client when the repository has one: the transaction is opened on it — a SAVEPOINT when
 * one is already open there — never on the ambient pool.
 */
export const judgedWrite = <Row, T>(
  entity: EntityCore<Row>,
  direct: DbClient,
  pinned: DbClient | undefined,
  work: (send: DbClient) => Promise<T>,
): Promise<T> => {
  if (!hasJsOnlyInvariant(entity.$invariants)) return work(direct);
  return withTransaction((tx) => work(tx), pinned === undefined ? {} : { client: pinned });
};
