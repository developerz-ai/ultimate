// The ledger projection behind `x db backfill --list`, driven through `createMemoryDriver()` —
// a real `BackfillLedger` with real start/progress/finish semantics, so a row here got its
// `cursor` and `durationMs` the way a pg ledger would. No `ParsedArgs`, no app, no queue boot.

import { afterEach, describe, expect, test } from 'bun:test';
import type { DbClient } from '@ultimat3/db';
import { setDbClient } from '@ultimat3/db';
import type { ReadBuilder } from '@ultimat3/entity';
import { entity, memoryRepo, tableFor, text, uuid } from '@ultimat3/entity';
import type { JobDriver } from '@ultimat3/jobs';
import {
  backfill,
  createMemoryDriver,
  resetJobDriver,
  resetJobs,
  setJobDriver,
} from '@ultimat3/jobs';
import {
  pendingReport,
  readAppliedMigrations,
  renderPendingTable,
  renderPlanTable,
  runBackfills,
} from './db-backfill';

interface Seed {
  readonly runId: string;
  readonly name: string;
  readonly rows?: number;
  readonly cursor?: string | null;
  readonly finish?: 'completed' | 'failed';
}

/** Optional chaining, not an assertion: `backfills` is optional on `JobDriver` by design. */
async function seed(driver: JobDriver, input: Seed): Promise<void> {
  await driver.backfills?.start({
    runId: input.runId,
    name: input.name,
    checksum: 'abc123',
    appVersion: '1.2.0',
  });
  if (input.rows !== undefined) {
    await driver.backfills?.progress(input.runId, {
      rows: input.rows,
      cursor: input.cursor ?? null,
    });
  }
  if (input.finish !== undefined) {
    await driver.backfills?.finish(input.runId, { status: input.finish, rows: input.rows ?? 0 });
  }
}

interface Post {
  readonly id: string;
  readonly orgId: string;
  readonly title: string;
}

const ORG = '00000000-0000-7000-8000-0000000000c1';

/**
 * Built INSIDE `source`, which no test here ever calls: `entity()` registers globally, and an
 * entity registered by this file would make `x db gen`'s "an unchanged schema generates nothing"
 * emit a migration for a table only a test knows about. `backfill()` reads `source.toString()`
 * for the checksum and nothing else, so the body stays unevaluated.
 */
const sweepSource = (): ReadBuilder<Post> => {
  const posts = entity('cli_backfill_posts', {
    columns: { id: uuid().primaryKey(), orgId: uuid(), title: text({ max: 40 }) },
  });
  return tableFor(posts, memoryRepo(posts, [])).where({ orgId: ORG });
};

const declareSweep = (name: string, over: Record<string, unknown> = {}) =>
  // `'none'` because these fixtures assert the PLAN — which sweeps are pending, what a dry run
  // reports — and never run a pass, so no read is ever scoped. A sweep with a real tenant is
  // covered where it belongs, in packages/jobs/src/backfill-tenancy.test.ts.
  backfill<Post>({
    name,
    tenant: 'none',
    source: sweepSource,
    handle: () => undefined,
    ...over,
  });

/** Rows waiting on the queue, across every queue — what a dry run must leave at zero. */
const queued = async (driver: JobDriver): Promise<number> =>
  (await driver.stats()).reduce((total, stats) => total + stats.ready + stats.delayed, 0);

/** Every test below declares its own sweeps, so the registry never leaks into the next one. */
afterEach(() => {
  resetJobs();
  resetJobDriver();
});

describe('unit · declared minus completed, joined to the ledger', () => {
  test('a sweep that was merged and never enqueued is pending — the whole point', async () => {
    const driver = createMemoryDriver();
    declareSweep('normalize-titles');

    const report = await pendingReport(driver, 'production');

    expect(report.pending.map((row) => row.name)).toEqual(['normalize-titles']);
    expect(renderPendingTable(report).join('\n')).toContain('normalize-titles');
    expect(renderPendingTable(report).join('\n')).not.toContain('⟦');
  });

  test('a completed pass drops out of the diff, and the ledger row is what says so', async () => {
    const driver = createMemoryDriver();
    const handle = declareSweep('normalize-titles');
    await seed(driver, {
      runId: 'run_1',
      name: 'normalize-titles',
      rows: 4,
      finish: 'completed',
    });

    const report = await pendingReport(driver, 'production');
    expect(report.pending).toEqual([]);
    expect(report.rows[0]?.state).toBe('completed');
    // The declaration's own checksum, so a definition that moved is visible rather than assumed.
    expect(report.rows[0]?.changed).toBe(true);
    expect(handle.name).toBe('normalize-titles');
  });
});

describe('unit · runBackfills', () => {
  test('a dry run writes NOTHING — --write is never implied', async () => {
    const driver = createMemoryDriver();
    setJobDriver(driver);
    declareSweep('normalize-titles');

    const rows = await runBackfills({
      driver,
      names: 'all',
      write: false,
      force: false,
      environment: 'production',
      appliedMigrations: undefined,
    });

    expect(rows).toEqual([
      {
        name: 'normalize-titles',
        action: 'planned',
        state: 'pending',
        jobId: null,
        remaining: null,
        finding: null,
      },
    ]);
    // Nothing reached the queue, which is what "dry run" has to mean.
    expect(await queued(driver)).toBe(0);
  });

  test('--write enqueues, and a second --write dedupes onto the live pass', async () => {
    const driver = createMemoryDriver();
    setJobDriver(driver);
    declareSweep('normalize-titles');
    const args = {
      driver,
      names: 'all' as const,
      write: true,
      force: false,
      environment: 'production' as const,
      appliedMigrations: undefined,
    };

    const first = await runBackfills(args);
    expect(first[0]?.action).toBe('enqueued');
    expect(first[0]?.jobId).toBeTruthy();
    expect(first[0]?.finding).toBeNull();

    // One live pass per name: the second enqueue starts nothing, and an operator who asked for a
    // pass has to hear about the one already holding the key.
    const again = await runBackfills(args);
    expect(again[0]?.action).toBe('deduped');
    expect(again[0]?.finding?.code).toBe('X_BACKFILL_RUNNING');
    expect(again[0]?.finding?.fix).toContain('x jobs show');
  });

  test('one blocked sweep does not stop the ones after it', async () => {
    // The reason `--all` isolates per name: a wedged cleanup that threw out of the loop would
    // block every later one forever.
    const driver = createMemoryDriver();
    setJobDriver(driver);
    declareSweep('a-blocked', { requires: '20260101000000_init' });
    declareSweep('b-runs');

    const rows = await runBackfills({
      driver,
      names: ['a-blocked', 'b-runs'],
      write: true,
      force: false,
      environment: 'production',
      appliedMigrations: [],
    });

    expect(rows.map((row) => row.action)).toEqual(['blocked', 'enqueued']);
    expect(rows[0]?.finding?.code).toBe('X_BACKFILL_MIGRATION_PENDING');
    expect(rows[1]?.jobId).toBeTruthy();
    expect(renderPlanTable(rows).join('\n')).not.toContain('⟦');
  });

  test('--all picks its targets by STATE, so a failed sweep is swept and a live one is not', async () => {
    // Pinned because the selection used to be `report.pending.includes(row)` — an object-identity
    // test that held only because the diff filters the array it returns. One `map` inside
    // `pendingBackfills` and `--all` would have found nothing, exited 0, and said so.
    const driver = createMemoryDriver();
    setJobDriver(driver);
    declareSweep('failed-once');
    declareSweep('still-running');
    await seed(driver, { runId: 'run_f', name: 'failed-once', rows: 3, finish: 'failed' });
    await seed(driver, { runId: 'run_r', name: 'still-running', rows: 1 });

    const rows = await runBackfills({
      driver,
      names: 'all',
      write: false,
      force: false,
      environment: 'production',
      appliedMigrations: undefined,
    });

    // `failed` is the alarm; `running` is progress and must not be re-triggered under it.
    expect(rows.map((row) => row.name)).toEqual(['failed-once']);
    expect(rows[0]?.state).toBe('failed');
  });

  test('a completed name is refused without --force and runs again with it', async () => {
    const driver = createMemoryDriver();
    setJobDriver(driver);
    declareSweep('normalize-titles');
    await seed(driver, { runId: 'run_1', name: 'normalize-titles', rows: 4, finish: 'completed' });
    const args = {
      driver,
      names: ['normalize-titles'],
      write: true,
      environment: 'production' as const,
      appliedMigrations: undefined,
    };

    const refused = await runBackfills({ ...args, force: false });
    expect(refused[0]?.action).toBe('blocked');
    expect(refused[0]?.finding?.code).toBe('X_BACKFILL_APPLIED');

    const forced = await runBackfills({ ...args, force: true });
    expect(forced[0]?.action).toBe('enqueued');
  });

  test('a sweep this environment may not run is excluded from --all, never enqueued', async () => {
    const driver = createMemoryDriver();
    setJobDriver(driver);
    declareSweep('prod-only', { environments: ['production'] });

    const swept = await runBackfills({
      driver,
      names: 'all',
      write: true,
      force: false,
      environment: 'staging',
      appliedMigrations: undefined,
    });
    expect(swept).toEqual([]);

    // Asked for BY NAME it is refused rather than silently skipped: the operator typed it.
    const named = await runBackfills({
      driver,
      names: ['prod-only'],
      write: true,
      force: false,
      environment: 'staging',
      appliedMigrations: undefined,
    });
    expect(named[0]?.finding?.code).toBe('X_BACKFILL_ENVIRONMENT');
    expect(await queued(driver)).toBe(0);
  });
});

describe('unit · remaining — the one number a dry run reports', () => {
  const plan = async (driver: JobDriver, names: readonly string[]) =>
    runBackfills({
      driver,
      names,
      write: false,
      force: false,
      environment: 'production',
      appliedMigrations: undefined,
    });

  test('a declared count() is what the dry run reports', async () => {
    const driver = createMemoryDriver();
    setJobDriver(driver);
    declareSweep('counted', { count: () => 42 });

    const rows = await plan(driver, ['counted']);
    expect(rows[0]?.action).toBe('planned');
    expect(rows[0]?.remaining).toBe(42);
  });

  test('a count() that throws reports null and still plans — a dry run never invents a number', async () => {
    // A tenanted sweep counts within one org and the CLI's context carries no actor, so the throw
    // is expected. Reporting `0` there would be the dry run lying, which is the failure `count()`
    // exists to close.
    const driver = createMemoryDriver();
    setJobDriver(driver);
    declareSweep('uncountable', {
      count: () => {
        throw new RangeError('this sweep is tenanted and the CLI context carries no org');
      },
    });

    const rows = await plan(driver, ['uncountable']);
    expect(rows[0]?.action).toBe('planned');
    expect(rows[0]?.remaining).toBeNull();
    expect(rows[0]?.finding).toBeNull();
  });

  test('a declaration with no count() reports null, and the table renders it as a value', async () => {
    const driver = createMemoryDriver();
    setJobDriver(driver);
    declareSweep('uncounted');

    const rows = await plan(driver, ['uncounted']);
    expect(rows[0]?.remaining).toBeNull();
    expect(renderPlanTable(rows).join('\n')).not.toContain('⟦');
  });

  test('remaining survives the enqueue, so --write reports what the dry run reported', async () => {
    const driver = createMemoryDriver();
    setJobDriver(driver);
    declareSweep('counted-write', { count: () => 7 });

    const rows = await runBackfills({
      driver,
      names: ['counted-write'],
      write: true,
      force: false,
      environment: 'production',
      appliedMigrations: undefined,
    });
    expect(rows[0]?.action).toBe('enqueued');
    expect(rows[0]?.remaining).toBe(7);
  });
});

describe('unit · reading x_migrations', () => {
  /** A client whose only job is to fail the ledger read the way a real one would. */
  const failingClient = (error: unknown): DbClient =>
    ({
      query: () => Promise.reject(error),
      execute: () => Promise.reject(error),
      close: () => Promise.resolve(),
    }) as unknown as DbClient;

  const undefinedTable = (): Error =>
    Object.assign(new Error('relation does not exist'), {
      code: '42P01',
    });

  afterEach(() => {
    setDbClient(undefined);
  });

  test('a database is not opened at all when nothing declares requires', async () => {
    declareSweep('no-requirement');
    setDbClient(failingClient(new Error('this client must never be asked')));
    // `undefined` means "there is nothing to check", which the gate reads as no obstacle.
    expect(await readAppliedMigrations()).toBeUndefined();
  });

  test('an absent x_migrations is an ANSWER — nothing applied, so every requires is unsatisfied', async () => {
    declareSweep('needs-migration', { requires: '20260814120000_add_publish_at' });
    setDbClient(failingClient(undefinedTable()));
    // `[]` and deliberately not `undefined`: a database this app has never migrated genuinely has
    // no applied migration, so the gate should block rather than wave the sweep through.
    expect(await readAppliedMigrations()).toEqual([]);
  });

  test('a read that FAILED propagates — "I could not ask" is never "it is applied"', async () => {
    // The silent pass this slice exists to remove: a permission error, a timeout or a dropped
    // connection treated as an empty answer lets a sweep run against the shape it waits for.
    declareSweep('needs-migration-2', { requires: '20260814120000_add_publish_at' });
    for (const error of [
      Object.assign(new Error('permission denied for table x_migrations'), { code: '42501' }),
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      new Error('statement timeout'),
    ]) {
      setDbClient(failingClient(error));
      const thrown: unknown = await readAppliedMigrations().then(
        () => undefined,
        (raised: unknown) => raised,
      );
      expect(thrown).toBe(error);
    }
  });
});
