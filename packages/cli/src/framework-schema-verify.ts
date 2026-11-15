// A serving role's boot over an external database: no DDL, one statement per attempt once a
// migrate has run — the framework stamp and the app's `x_migrations` ledger together — and the
// wait for the migrate step when either is behind this build (`framework-schema-wait.ts`).

import { recordFrameworkSchema } from '@ultimat3/core';
import type { DbClient } from '@ultimat3/db';
import { isLedgerMissing, LEDGER_TABLE, raw } from '@ultimat3/db';
import {
  AppMigrationsUnappliedError,
  appMigrationsVerdict,
  parseAppliedIds,
  reportAppMigrationsAhead,
} from './app-migrations-verdict';
import { readStamp, reportSkew, thisBuild } from './framework-schema-apply';
import {
  aheadByMajor,
  FrameworkSchemaUnappliedError,
  otherMajor,
  parseStamp,
  STAMP_RELATION,
  type StampEntry,
  stampVerdict,
} from './framework-schema-stamp';
import { type SchemaCheck, type SchemaWaitOptions, waitForSchema } from './framework-schema-wait';

export interface VerifySchemaOptions extends SchemaWaitOptions {
  /** The migration ids this build ships (`readMigrations(root)`), oldest first. None: not read. */
  readonly shipped?: readonly string[];
}

interface BootRead {
  readonly stamp: string | null;
  /** `undefined` when `x_migrations` does not exist. */
  readonly applied: readonly string[] | undefined;
}

/**
 * ONE statement on every database a migrate step has touched: the stamp and the ledger together.
 * A missing ledger fails the whole of it (`42P01`) — Postgres resolves a relation when it PARSES,
 * so no `case when to_regclass(…)` guard can name a table that may not exist — and only then is
 * the stamp read alone: a second statement on a database no migrate has ever run on, never after.
 */
async function readBoot(client: DbClient, withLedger: boolean): Promise<BootRead> {
  if (!withLedger) return { stamp: await readStamp(client), applied: [] };
  try {
    const rows = await client.query<{ readonly stamp: string | null; readonly applied: unknown }>(
      raw(
        `select obj_description(to_regclass('${STAMP_RELATION}'), 'pg_class') as stamp, ` +
          `(select coalesce(json_agg(id order by id), '[]'::json)::text from ${LEDGER_TABLE}) as applied`,
      ),
    );
    return { stamp: rows[0]?.stamp ?? null, applied: parseAppliedIds(rows[0]?.applied) };
  } catch (error) {
    if (!isLedgerMissing(error)) throw error;
    return { stamp: await readStamp(client), applied: undefined };
  }
}

interface Served {
  readonly skew: StampEntry | undefined;
  readonly unknown: readonly string[];
}

function judge(read: BootRead, mine: StampEntry, shipped: readonly string[]): SchemaCheck<Served> {
  const framework = stampVerdict(parseStamp(read.stamp), mine);
  const app = appMigrationsVerdict(shipped, read.applied);
  // Every read, each round of a wait included, scraped off the metrics listener `serveApp` opened
  // before this boot began. `applied` is 0 while the role waits for EITHER half: what the alert
  // reads is "this role is not serving because its schema is not applied".
  recordFrameworkSchema({
    applied: framework.applied && app.missing.length === 0,
    majorSkew: framework.applied
      ? framework.skew !== undefined
      : otherMajor(framework.newest, mine),
  });
  if (!framework.applied) {
    const { newest } = framework;
    return {
      ready: false,
      atOnce: aheadByMajor(newest, mine),
      refuse: (waitedMs) =>
        new FrameworkSchemaUnappliedError({
          mine,
          newest,
          ...(waitedMs === undefined ? {} : { waitedMs }),
        }),
    };
  }
  if (app.missing.length > 0) {
    return {
      ready: false,
      refuse: (waitedMs) =>
        new AppMigrationsUnappliedError({
          missing: app.missing,
          ledger: read.applied !== undefined,
          ...(waitedMs === undefined ? {} : { waitedMs }),
        }),
    };
  }
  return { ready: true, value: { skew: framework.skew, unknown: app.unknown } };
}

/**
 * Served once the framework stamp holds this build and the ledger holds every migration it ships.
 * Behind on either WAITS — a rollout that starts the roles before the migrate Job finishes is a
 * normal deploy, and refusing at once crash-looped it — then is refused with the command that
 * applies. A database a newer major stamped is refused at once. Ahead is served and said once: a
 * fleet straddling a major (`reportSkew`), a ledger holding migrations this build does not ship
 * (`reportAppMigrationsAhead`) — both are the old pods of a rollout or a rollback.
 */
export async function verifySchema(client: DbClient, options: VerifySchemaOptions): Promise<void> {
  const mine = thisBuild();
  const shipped = options.shipped ?? [];
  const served = await waitForSchema(
    async () => judge(await readBoot(client, shipped.length > 0), mine, shipped),
    options,
  );
  reportSkew(mine, served.skew);
  reportAppMigrationsAhead(served.unknown);
}
