// The app's own migrations, as a serving role judges them at boot: which ones this build ships that
// the `x_migrations` ledger lacks (behind: wait for the migrate step), and which ones the ledger
// holds that this build does not know (ahead: a rollback, served with one warning). Pure; the read
// is `framework-schema-apply.ts`'s, one statement beside the framework stamp.

import { logger, UltimateError } from '@ultimat3/core';
import { LEDGER_TABLE } from '@ultimat3/db';

export interface AppMigrationsVerdict {
  /** Shipped by this build, absent from the ledger — every one when the ledger does not exist. */
  readonly missing: readonly string[];
  /** In the ledger, unknown to this build: a newer release migrated, and this one rolled back. */
  readonly unknown: readonly string[];
}

/** `applied` is `undefined` when the ledger table does not exist: no migrate step has run at all. */
export function appMigrationsVerdict(
  shipped: readonly string[],
  applied: readonly string[] | undefined,
): AppMigrationsVerdict {
  const ledger = new Set(applied ?? []);
  const known = new Set(shipped);
  return {
    missing: shipped.filter((id) => !ledger.has(id)),
    unknown: (applied ?? []).filter((id) => !known.has(id)),
  };
}

/** The ledger's ids as the boot read returns them — a JSON array — and nothing it is not. */
export function parseAppliedIds(value: unknown): readonly string[] {
  if (typeof value !== 'string') return [];
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
}

/** At most this many ids in a line: the count says the rest, and a log line is not a listing. */
const NAMED = 5;

const named = (ids: readonly string[]): string =>
  ids.length <= NAMED
    ? ids.join(', ')
    : `${ids.slice(0, NAMED).join(', ')} and ${String(ids.length - NAMED)} more`;

/** A serving role over a database the migrate step has not yet brought to this build's migrations. */
export class AppMigrationsUnappliedError extends UltimateError {
  constructor(input: {
    readonly missing: readonly string[];
    /** `false` when `x_migrations` does not exist: no migrate step ever ran against this database. */
    readonly ledger: boolean;
    readonly waitedMs?: number;
  }) {
    const waited =
      input.waitedMs === undefined
        ? ''
        : `. This role waited ${String(Math.round(input.waitedMs))}ms (ULTIMATE_SCHEMA_WAIT_MS) for them`;
    super({
      code: 'X_APP_MIGRATIONS_UNAPPLIED',
      cause: `this build ships ${String(input.missing.length)} migration(s) the database has not applied — ${named(input.missing)}${
        input.ledger ? '' : ` (${LEDGER_TABLE} does not exist: no ROLE=migrate has run here)`
      }. Serving would fail on the first statement naming a column they add: the migrate step must run first${waited}`,
      fix: 'x db migrate',
      meta: {
        missing: [...input.missing],
        ledger: input.ledger,
        ...(input.waitedMs === undefined ? {} : { waitedMs: Math.round(input.waitedMs) }),
      },
    });
  }
}

/**
 * Served, said once. A ledger ahead of the build is a rollback — or the old pods of a rollout the
 * migrate step already ran for — and the rolling rail (`X_MIGRATION_ROLLING_UNSAFE`) is what makes
 * that schema one the previous release can run on. Refusing it would crash-loop every old pod of
 * every deploy; serving it silently would hide a rollback nobody finished.
 */
export function reportAppMigrationsAhead(unknown: readonly string[]): void {
  if (unknown.length === 0) return;
  logger.warn('ultimate app migrations ahead', {
    migrations: unknown.length,
    cause: `the database holds ${String(unknown.length)} migration(s) this build does not ship — ${named(unknown)}: a newer release migrated and this one is mid-rollout or rolled back`,
    // The read that lists them beside the framework stamp, and writes nothing.
    fix: 'x db status --json',
  });
}
