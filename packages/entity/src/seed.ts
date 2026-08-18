// A seed is the fixture graph, written once and REPLAYED anywhere: a second run writes nothing new
// and raises nothing. Two write verbs, because only the author knows which key identifies a row —
// `insert` where the seed owns the id (`id('post:tenancy')` is a v5 uuid of the label, the same on
// every machine), `upsert` where the table owns it and a natural key is all there is.

import { createHash } from 'node:crypto';
import { type Environment, resolveEnvironment, systemClock } from '@ultimat3/core';
import type { Driver } from './database';
import { memoryDriver } from './database';
import { type EntityCore, SOFT_DELETE_COLUMN } from './entity';
import { EntityError } from './errors';
import type { Predicate } from './tenancy';
import type { ColumnMap, Insertable } from './types';

/** Framework namespace for seed labels. Fixed forever: changing it moves every seeded id. */
const NAMESPACE = 'a3c1f0d6-5c2b-4a3e-9f1b-6d4e7c8a9b02';

/**
 * What a replay never overwrites, unless `preserve` says otherwise. Spelled here as a constant for
 * the reason `SOFT_DELETE_COLUMN` is: the timestamp convention is the framework's, so the column a
 * seed must not reset is decided once.
 */
const CREATED_AT_COLUMN = 'createdAt';

const bytesOf = (uuid: string): Uint8Array =>
  Uint8Array.from((uuid.replaceAll('-', '').match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** RFC 4122 v5: SHA-1 of namespace + name, with the version and variant bits pinned. */
export const seedId = (label: string): string => {
  const name = new TextEncoder().encode(label);
  const input = new Uint8Array(16 + name.length);
  input.set(bytesOf(NAMESPACE));
  input.set(name, 16);
  const digest = new Uint8Array(createHash('sha1').update(input).digest());
  const bytes = digest.slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
};

/**
 * Which deploys a seed belongs to, declared as DATA on the seed and never inferred from its name.
 *
 * `reference` is data the app is wrong without — currencies, plans, service tiers, locations — and
 * it ships to production through this same mechanism. `dev` is fixture data, and production is the
 * one environment it must not reach by accident. The word is the seed's; the refusal is the
 * caller's (`x db seed`), because an app that seeds its own database from its boot code has
 * DECIDED to (axiom 8) and a library that overruled that would break it.
 */
export const SEED_TIERS = ['reference', 'dev'] as const;

export type SeedTier = (typeof SEED_TIERS)[number];

/**
 * The tiers a run takes when nothing asked for one: everything, except that production leaves
 * `dev` out. `requested` is both the selection AND the consent, one word doing one job — a cluster
 * that sets `ULTIMATE_ENV=production` on every box (staging included) still loads its dev seeds by
 * naming the tier, instead of by lying about the environment.
 */
export const seedTiersFor = (
  environment: Environment,
  requested?: SeedTier | undefined,
): readonly SeedTier[] => {
  if (requested !== undefined) return [requested];
  return environment === 'production' ? ['reference'] : [...SEED_TIERS];
};

/** What one `upsert` did. `skipped` is a row already stored with these values — no statement. */
export type SeedWrite = 'inserted' | 'updated' | 'skipped';

/** One run's tally, in the three words every seed report is built from. */
export interface SeedMetrics {
  inserted: number;
  updated: number;
  skipped: number;
}

export interface SeedKey<Row> {
  /**
   * The columns of the unique constraint this row is identified by — its NATURAL key, which is the
   * only key a seed writing into an existing table can know. A target no declared constraint
   * matches is refused by `upsertPlan` before a statement is sent (`42P10` otherwise).
   */
  readonly by: readonly (keyof Row & string)[];
  /**
   * Columns a collision leaves alone. `createdAt` by default, and that default is the point: a
   * replay must not reset when a row first arrived. The conflict target, the primary key and the
   * soft-delete stamp are spared by `upsertPlan` already.
   */
  readonly preserve?: readonly (keyof Row & string)[];
}

export interface SeedContext {
  /**
   * Rows whose ids the SEED chose, written in one statement and replayable by primary key: a row
   * already stored is left exactly as it is (`on conflict … do nothing`). The bulk verb — one
   * statement per call, not one per row.
   */
  insert<Row, C extends ColumnMap>(
    entity: EntityCore<Row, C>,
    rows: readonly Insertable<C>[],
  ): Promise<void>;
  /**
   * One row whose id the TABLE owns, matched on the natural key `by` names. Reads first so the
   * answer can be `'skipped'`, then writes with a single `on conflict … do update`, which is what
   * settles the race between two containers booting at once — the read is for the report, never
   * for the decision.
   */
  upsert<Row, C extends ColumnMap>(
    entity: EntityCore<Row, C>,
    key: SeedKey<Row>,
    values: Insertable<C>,
  ): Promise<SeedWrite>;
  /**
   * The other unit of idempotency: the FILE. Bulk volume data has no natural key worth upserting
   * ten thousand rows against, so the guard is a sentinel — `if (await exists(reports)) return;`
   * at the top of the seed.
   */
  exists<Row, C extends ColumnMap>(
    entity: EntityCore<Row, C>,
    where?: Partial<Row>,
  ): Promise<boolean>;
  count<Row, C extends ColumnMap>(
    entity: EntityCore<Row, C>,
    where?: Partial<Row>,
  ): Promise<number>;
  /** Scoped wipe before a regenerate. Refused on a soft-deleting entity — see `softDeleteWipe`. */
  deleteWhere<Row, C extends ColumnMap>(
    entity: EntityCore<Row, C>,
    where: Partial<Row>,
  ): Promise<number>;
  /** Deterministic id for a label. Same label, same uuid, every run. */
  id(label: string): string;
  /** One instant for the whole run, so every row a bulk pass stamps carries the same timestamp. */
  readonly now: Date;
  readonly environment: Environment;
  readonly tier: SeedTier;
  /** Reads still run; every write short-circuits and is counted as what it WOULD have written. */
  readonly dryRun: boolean;
  readonly metrics: SeedMetrics;
}

export interface SeedOptions {
  /** Defaults to a fresh in-memory driver, so a seed runs with no database at all. */
  readonly driver?: Driver;
  readonly dryRun?: boolean;
  /** Injected for a test; `process.env` otherwise. Read once, by `resolveEnvironment`. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

export interface SeedRun {
  readonly name: string;
  readonly tier: SeedTier;
  readonly metrics: SeedMetrics;
}

export interface Seed {
  readonly name: string;
  readonly tier: SeedTier;
  run(options?: SeedOptions): Promise<SeedRun>;
}

export interface SeedInit {
  /** Defaults to `dev`: fixture data is what a seed is until its author says otherwise. */
  readonly tier?: SeedTier;
}

/** What `x db seed` picks out of a module. Same shape rule as `isRouteConfig`. */
export const isSeed = (value: unknown): value is Seed =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { name?: unknown }).name === 'string' &&
  typeof (value as { run?: unknown }).run === 'function' &&
  (SEED_TIERS as readonly unknown[]).includes((value as { tier?: unknown }).tier);

/** Property access on a parsed row without `any`: `$parse` fills every declared column. */
const cellOf = (row: unknown, property: string): unknown =>
  (row as Readonly<Record<string, unknown>>)[property];

/**
 * Two cells, as a replay has to compare them: a `Date` is not `===` a `Date` and money is an
 * object, so both are compared by value and everything else by identity.
 */
const sameCell = (left: unknown, right: unknown): boolean => {
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return left === right;
};

const equalityPredicates = <Row>(where: Partial<Row>): readonly Predicate[] =>
  Object.entries(where).map(([column, value]): Predicate => ({ column, op: 'eq', value }));

/**
 * The entity's own key as a conflict target. `$primaryKey` is `readonly string[]` because an
 * entity does not know its row type at that field, and `onConflict` is typed by the row.
 */
const primaryKeyTarget = <Row>(entity: EntityCore<Row>): readonly (keyof Row & string)[] =>
  entity.$primaryKey as readonly (keyof Row & string)[];

/**
 * A primary key the row leaves to a GENERATED default is a different id on every run, so the
 * conflict target finds nothing and each replay inserts one more copy. `$parse` refuses a key with
 * no value at all; this is the half it cannot see, because filling that column is what it does.
 */
const generatedKey = (entity: EntityCore, missing: string, position: number): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entity.$name} seed row ${position + 1} leaves "${missing}" to a generated default, and a primary key generated fresh on every run is a row every replay inserts a second copy of`,
    fix: `insert(${entity.$name}, rows.map((row, index) => ({ ...row, ${missing}: id(\`${entity.$name}:\${index}\`) })))   # id() is a uuid v5 of the label: same row, same id, every run`,
  });

/**
 * Deleting from a soft-deleting entity inside a seed, refused rather than documented. The stamp is
 * what makes it unrecoverable: `upsertPlan` spares the soft-delete column on purpose and the stored
 * row still occupies its unique key, so the replay that was supposed to bring the rows back writes
 * nothing at all and the fixture is gone until the database is.
 */
const softDeleteWipe = (entity: EntityCore): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entity.$name} declares ${SOFT_DELETE_COLUMN}, so deleteWhere() would stamp its seeded rows rather than remove them — the stamped row keeps its unique key, and no replay of this seed can clear it`,
    fix: 'x db reset --json   # the only wipe a soft-deleting entity has; drop the deleteWhere() call from the seed',
  });

/** The row an update may write: everything the caller named, less what a match must not move. */
const withoutPreserved = <Row>(row: Row, preserve: readonly string[]): Row => {
  const copy: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const property of preserve) delete copy[property];
  // `Repo` is typed for whole rows, and a partial one is exactly what keeps a column OUT of the
  // update set — `namedProperties` reads what the row owns. Same assertion the bulk live test takes.
  return copy as Row;
};

export const defineSeed = (
  name: string,
  build: (context: SeedContext) => Promise<void>,
  init: SeedInit = {},
): Seed => {
  const tier = init.tier ?? 'dev';
  return {
    name,
    tier,
    run: async (options = {}) => {
      const driver = options.driver ?? memoryDriver();
      const dryRun = options.dryRun ?? false;
      const metrics: SeedMetrics = { inserted: 0, updated: 0, skipped: 0 };
      const context: SeedContext = {
        insert: async (entity, rows) => {
          // Judged on the row as WRITTEN, before `$parse` fills the column that would hide it.
          for (const [position, row] of rows.entries()) {
            const missing = entity.$primaryKey.find(
              (property) =>
                entity.$columns[property]?.$meta.default?.kind === 'generated' &&
                !Object.hasOwn(row, property),
            );
            if (missing !== undefined) throw generatedKey(entity, missing, position);
          }
          const parsed = rows.map((row) => entity.$parse(row));
          if (dryRun) {
            metrics.inserted += parsed.length;
            return;
          }
          const written = await driver.repo(entity).upsertAll(parsed, {
            onConflict: primaryKeyTarget(entity),
            // Never `'update'`: a do-nothing conflict needs no tenant column in the target, so this
            // is the one form that replays on a tenant-scoped entity whose unique keys are global.
            onMatch: 'nothing',
          });
          metrics.inserted += written.length;
          metrics.skipped += parsed.length - written.length;
        },

        upsert: async (entity, key, values) => {
          const row = entity.$parse(values);
          const repo = driver.repo(entity);
          const where = Object.fromEntries(
            key.by.map((property) => [property, cellOf(row, property)]),
          );
          const found = await repo.findMany({ where: equalityPredicates(where), limit: 1 });
          const stored = found.rows[0];
          const preserve: readonly string[] = key.preserve ?? [CREATED_AT_COLUMN];
          const compared = Object.keys(row as Record<string, unknown>).filter(
            (property) => !preserve.includes(property),
          );
          if (
            stored !== undefined &&
            compared.every((property) => sameCell(cellOf(stored, property), cellOf(row, property)))
          ) {
            metrics.skipped += 1;
            return 'skipped';
          }
          const write: SeedWrite = stored === undefined ? 'inserted' : 'updated';
          if (!dryRun) {
            await repo.upsertAll([stored === undefined ? row : withoutPreserved(row, preserve)], {
              onConflict: key.by,
              onMatch: 'update',
            });
          }
          metrics[write === 'inserted' ? 'inserted' : 'updated'] += 1;
          return write;
        },

        count: async (entity, where) =>
          driver
            .repo(entity)
            .count(where === undefined ? {} : { where: equalityPredicates(where) }),

        exists: async (entity, where) => (await context.count(entity, where)) > 0,

        deleteWhere: async (entity, where) => {
          if (entity.$softDelete) throw softDeleteWipe(entity);
          if (dryRun) return context.count(entity, where);
          return driver.repo(entity).deleteWhere(where);
        },

        id: seedId,
        now: systemClock.now(),
        environment: resolveEnvironment({ env: options.env }),
        tier,
        dryRun,
        metrics,
      };
      await build(context);
      return { name, tier, metrics };
    },
  };
};
