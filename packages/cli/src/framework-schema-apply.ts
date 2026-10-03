// The two ways a boot meets the framework schema (plan 101, s1-con #5): `applyLockedSchema` runs the
// DDL in ONE transaction behind the migration advisory lock with a bounded `lock_timeout`, then
// stamps the build; `verifySchema` runs no DDL and refuses a database this build was never applied
// to. Which boot takes which is `runtime-queue.ts`'s `SchemaMode`.

import { frameworkVersion, logger } from '@ultimat3/core';
import type { DbClient } from '@ultimat3/db';
import {
  literal,
  MIGRATION_LOCK_KEY,
  MIGRATION_LOCK_WAIT_MS,
  poolProfileFor,
  raw,
  withTransaction,
} from '@ultimat3/db';
import { applyFrameworkSchema } from './framework-schema';
import {
  FrameworkSchemaUnappliedError,
  frameworkSchemaHash,
  nextStamp,
  parseStamp,
  STAMP_RELATION,
  type StampEntry,
  stampVerdict,
} from './framework-schema-stamp';

const thisBuild = (): StampEntry => ({
  version: frameworkVersion(),
  schema: frameworkSchemaHash(),
});

/** The stamp as the catalog holds it; `null` when the relation or its comment is absent. */
async function readStamp(client: DbClient): Promise<string | null> {
  const rows = await client.query<{ readonly stamp: string | null }>(
    raw(`select obj_description(to_regclass('${STAMP_RELATION}'), 'pg_class') as stamp`),
  );
  return rows[0]?.stamp ?? null;
}

/**
 * The migration lock, not a lock of its own: a second migrator — another `ROLE=migrate` pod, an
 * `x db migrate` — waits behind this one instead of racing its `create table`s into `23505`. A
 * transaction-scoped lock (`pg_advisory_xact_lock`), so no pinned session: COMMIT releases it.
 *
 * Two `lock_timeout`s: the lock wait is the migrator's own (`MIGRATION_LOCK_WAIT_MS`), and every
 * DDL statement after it is the migrate pool's (`poolProfileFor('migrate')`), so an `alter table`
 * behind an open transaction fails in seconds rather than queueing every enqueue behind it.
 */
export async function applyLockedSchema(client: DbClient): Promise<void> {
  await withTransaction(
    async (tx) => {
      await tx.execute(raw(`set local lock_timeout = ${Math.round(MIGRATION_LOCK_WAIT_MS)}`));
      await tx.execute(raw(`select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`));
      const ddlTimeoutMs = Math.round(poolProfileFor('migrate').lockTimeoutMs);
      await tx.execute(raw(`set local lock_timeout = ${ddlTimeoutMs}`));
      await applyFrameworkSchema((statement) => tx.execute(raw(statement)));
      const stamp = nextStamp(await readStamp(tx), thisBuild());
      await tx.execute(raw(`comment on table ${STAMP_RELATION} is ${literal(stamp).text}`));
    },
    { client },
  );
}

/**
 * One catalog read. A build absent from the stamp is refused with the command that applies it; a
 * fleet straddling a major is reported once and served — refusing it would crash-loop the old pods
 * of every rolling deploy across a breaking release.
 */
export async function verifySchema(client: DbClient): Promise<void> {
  const mine = thisBuild();
  const verdict = stampVerdict(parseStamp(await readStamp(client)), mine);
  if (!verdict.applied) throw new FrameworkSchemaUnappliedError({ mine, newest: verdict.newest });
  if (verdict.skew === undefined) return;
  logger.warn('ultimate framework major skew', {
    cause: `this process runs ${mine.version} and the database's framework schema was last applied by ${verdict.skew.version}: a fleet across a major boundary is mid-rollout or half rolled back`,
    fix: 'kubectl rollout status deployment --selector app.kubernetes.io/component=web',
  });
}
