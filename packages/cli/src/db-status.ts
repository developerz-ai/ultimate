// `x db status`'s verdict, pure: the app migrations this build ships against the `x_migrations`
// ledger (`appMigrationsVerdict`, the boot's own rule), an applied migration edited since, and the
// framework stamp (`stampVerdict`). A finding only where a serving role would wait or `x db migrate`
// would refuse; the read is `cmd-db-status.ts`'s.

import type { LedgerRow, Migration } from '@ultimat3/db';
import { auditLedger, ledgerAheadOfBuild, migrationChecksum } from '@ultimat3/db';
import { AppMigrationsUnappliedError, appMigrationsVerdict } from './app-migrations-verdict';
import {
  aheadByMajor,
  FrameworkSchemaUnappliedError,
  parseStamp,
  type StampEntry,
  stampVerdict,
} from './framework-schema-stamp';
import { msg } from './messages';
import type { Finding, JsonValue } from './output';
import { findingFrom } from './output';

/** The one read: the stamp comment and the ledger rows, `undefined` when `x_migrations` is absent. */
export interface DbStatusRead {
  readonly stamp: string | null;
  readonly ledger: readonly LedgerRow[] | undefined;
}

export interface FrameworkStatus {
  readonly version: string;
  readonly schema: string;
  readonly applied: boolean;
  /** The newest build the stamp records, when this one is not in it. */
  readonly newest?: StampEntry;
  /** The newest build, when this one is applied and the newest is another major. */
  readonly skew?: StampEntry;
  readonly aheadByMajor: boolean;
}

export interface DbStatus {
  readonly shipped: readonly string[];
  /** `null` when the ledger table does not exist: no migrate step has run here. */
  readonly applied: readonly string[] | null;
  readonly pending: readonly string[];
  readonly ahead: readonly string[];
  /** Applied, and its file now hashes otherwise. */
  readonly edited: readonly string[];
  readonly framework: FrameworkStatus;
}

export function dbStatus(
  read: DbStatusRead,
  migrations: readonly Migration[],
  mine: StampEntry,
): DbStatus {
  const shipped = migrations.map((migration) => migration.id);
  const applied = read.ledger?.map((row) => row.id);
  const verdict = appMigrationsVerdict(shipped, applied);
  const files = new Map(migrations.map((migration) => [migration.id, migration]));
  const edited = (read.ledger ?? []).flatMap((row) => {
    const file = files.get(row.id);
    return file !== undefined && migrationChecksum(file) !== row.checksum ? [row.id] : [];
  });
  const stamp = stampVerdict(parseStamp(read.stamp), mine);
  const framework: FrameworkStatus = stamp.applied
    ? {
        ...mine,
        applied: true,
        ...(stamp.skew === undefined ? {} : { skew: stamp.skew }),
        aheadByMajor: false,
      }
    : {
        ...mine,
        applied: false,
        ...(stamp.newest === undefined ? {} : { newest: stamp.newest }),
        aheadByMajor: aheadByMajor(stamp.newest, mine),
      };
  return {
    shipped,
    applied: applied ?? null,
    pending: verdict.missing,
    ahead: verdict.unknown,
    edited,
    framework,
  };
}

/**
 * The boot's refusals and the migrator's, as findings — each the error the real path throws, so the
 * code and fix are theirs. Ahead is not one: a serving role serves it with a warning (a rollback).
 */
export function dbStatusFindings(
  status: DbStatus,
  migrations: readonly Migration[],
  ledger: DbStatusRead['ledger'],
  /** `ROLLBACK_ALLOW_DESTRUCTIVE` as the migrate role would read it. */
  allow?: string | undefined,
): Finding[] {
  const findings: Finding[] = [];
  const { framework } = status;
  if (!framework.applied) {
    const mine = { version: framework.version, schema: framework.schema };
    findings.push(
      findingFrom(new FrameworkSchemaUnappliedError({ mine, newest: framework.newest })),
    );
  }
  if (status.pending.length > 0) {
    findings.push(
      findingFrom(
        new AppMigrationsUnappliedError({
          missing: status.pending,
          ledger: status.applied !== null,
        }),
      ),
    );
  }
  if (ledger !== undefined) {
    // `x db migrate`'s own two steps, in its order (migrate.ts): a ledger that is exactly a
    // rollback is accepted and audited over its known rows; anything else ahead, and any applied
    // migration edited since, is the conflict it refuses with — never a second spelling of either.
    try {
      const rolledBack = ledgerAheadOfBuild(ledger, migrations, { allow });
      auditLedger(rolledBack?.known ?? ledger, migrations, framework.version);
    } catch (error) {
      findings.push(findingFrom(error));
    }
  }
  return findings;
}

const idsOrNone = (ids: readonly string[]): string =>
  ids.length === 0 ? msg('cli.db.status.none') : ids.join(', ');

export function dbStatusLines(status: DbStatus): readonly string[] {
  const { framework } = status;
  const newest = framework.newest ?? framework.skew;
  return [
    msg('cli.db.status.framework', {
      verdict: msg(framework.applied ? 'cli.db.status.applied' : 'cli.db.status.unapplied'),
      version: framework.version,
      schema: framework.schema,
    }),
    ...(newest === undefined
      ? []
      : [msg('cli.db.status.newest', { version: newest.version, schema: newest.schema })]),
    msg('cli.db.status.migrations', {
      shipped: status.shipped.length,
      applied:
        status.applied === null ? msg('cli.db.status.noLedger') : String(status.applied.length),
    }),
    msg('cli.db.status.pending', { ids: idsOrNone(status.pending) }),
    msg('cli.db.status.ahead', { ids: idsOrNone(status.ahead) }),
    ...(status.edited.length === 0
      ? []
      : [msg('cli.db.status.edited', { ids: status.edited.join(', ') })]),
  ];
}

/** The `--json` body: the same facts the lines print. */
export function dbStatusJson(status: DbStatus): { readonly [key: string]: JsonValue } {
  const entry = (one: StampEntry | undefined): JsonValue =>
    one === undefined ? null : { version: one.version, schema: one.schema };
  return {
    shipped: [...status.shipped],
    applied: status.applied === null ? null : [...status.applied],
    pending: [...status.pending],
    ahead: [...status.ahead],
    edited: [...status.edited],
    framework: {
      version: status.framework.version,
      schema: status.framework.schema,
      applied: status.framework.applied,
      newest: entry(status.framework.newest),
      skew: entry(status.framework.skew),
      aheadByMajor: status.framework.aheadByMajor,
    },
  };
}
