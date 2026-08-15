// The ledger projection behind `x db backfill --list`, driven through `createMemoryDriver()` —
// a real `BackfillLedger` with real start/progress/finish semantics, so a row here got its
// `cursor` and `durationMs` the way a pg ledger would. No `ParsedArgs`, no app, no queue boot.

import { afterEach, describe, expect, test } from 'bun:test';
import type { ReadBuilder } from '@ultimat3/entity';
import { entity, memoryRepo, tableFor, text, uuid } from '@ultimat3/entity';
import type { BackfillStatus, JobDriver } from '@ultimat3/jobs';
import {
  BACKFILL_STATUSES,
  backfill,
  createMemoryDriver,
  resetJobDriver,
  resetJobs,
  setJobDriver,
} from '@ultimat3/jobs';
import {
  listBackfills,
  parseBackfillStatusFlag,
  pendingReport,
  renderBackfillTable,
  renderPendingTable,
  renderPlanTable,
  runBackfills,
} from './db-backfill';
import { BadFlagError } from './errors';
import { msg } from './messages';

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

describe('unit · backfill filter parsing', () => {
  test('every status the ledger can record is accepted, and nothing else is', () => {
    expect(BACKFILL_STATUSES).toEqual(['running', 'completed', 'failed']);
    for (const status of BACKFILL_STATUSES) {
      expect(parseBackfillStatusFlag(status)).toBe(status);
    }
    expect(parseBackfillStatusFlag(undefined)).toBeUndefined();
  });

  test('an unknown --status names the three that exist', () => {
    const thrown: unknown = (() => {
      try {
        return parseBackfillStatusFlag('done');
      } catch (error: unknown) {
        return error;
      }
    })();
    expect(thrown).toBeInstanceOf(BadFlagError);
    expect((thrown as BadFlagError).cause).toContain('running, completed, failed');
    // `x db`, not `x jobs`: the flag was typed on this command, so the error names this command.
    expect((thrown as BadFlagError).cause).toContain('"x db"');
  });

  test('a bad --limit is refused as a db flag, not as a jobs one', async () => {
    const driver = createMemoryDriver();
    const thrown: unknown = await listBackfills(driver, { limit: '0' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(BadFlagError);
    expect((thrown as BadFlagError).cause).toContain('--limit on "x db"');
  });
});

describe('unit · listBackfills', () => {
  test('an empty ledger is an answer, not a failure', async () => {
    expect(await listBackfills(createMemoryDriver())).toEqual([]);
  });

  test('every pass, newest first, with progress and duration as the ledger recorded them', async () => {
    const driver = createMemoryDriver();
    await seed(driver, { runId: 'run_1', name: 'recount-likes', rows: 500, finish: 'completed' });
    await seed(driver, { runId: 'run_2', name: 'reindex-posts', rows: 120, cursor: 'post_120' });

    const rows = await listBackfills(driver);

    expect(rows.map((row) => row.runId)).toEqual(['run_2', 'run_1']);
    expect(rows[0]).toMatchObject({
      name: 'reindex-posts',
      status: 'running',
      rows: 120,
      cursor: 'post_120',
      completedAt: null,
      durationMs: null, // a running pass has no span, and nothing here reads a clock
    });
    expect(rows[1]).toMatchObject({ status: 'completed', rows: 500, cursor: null });
    expect(typeof rows[1]?.durationMs).toBe('number');
  });

  test('--name and --status narrow the ledger, --limit caps it', async () => {
    const driver = createMemoryDriver();
    await seed(driver, { runId: 'run_1', name: 'recount-likes', rows: 10, finish: 'completed' });
    await seed(driver, { runId: 'run_2', name: 'recount-likes', rows: 3 });
    await seed(driver, { runId: 'run_3', name: 'reindex-posts', rows: 7, finish: 'failed' });

    expect((await listBackfills(driver, { name: 'recount-likes' })).map((r) => r.runId)).toEqual([
      'run_2',
      'run_1',
    ]);
    const failed: BackfillStatus = 'failed';
    expect((await listBackfills(driver, { status: failed })).map((r) => r.runId)).toEqual([
      'run_3',
    ]);
    expect(await listBackfills(driver, { limit: '1' })).toHaveLength(1);
  });
});

describe('unit · renderBackfillTable', () => {
  test('the header, one padded row per pass, and the ISO start printed verbatim', async () => {
    const driver = createMemoryDriver();
    await seed(driver, { runId: 'run_2', name: 'reindex-posts', rows: 120, cursor: 'post_120' });
    const rows = await listBackfills(driver);

    const lines = renderBackfillTable(rows);

    expect(lines[0]).toContain('name');
    expect(lines[0]).toContain('started-at');
    expect(lines[0]).toContain('run-id');
    expect(lines[1]).toContain('reindex-posts');
    expect(lines[1]).toContain('post_120');
    // Printed as the ledger stored it — formatting a date needs a zone this command has none of.
    expect(lines[1]).toContain(rows[0]?.startedAt ?? 'missing');
    expect(lines).toHaveLength(2);
  });

  test('a cursor that has not moved and a pass that has not finished render the empty cell', async () => {
    const driver = createMemoryDriver();
    await seed(driver, { runId: 'run_9', name: 'recount-likes' });
    const lines = renderBackfillTable(await listBackfills(driver));
    const cells = (lines[1] ?? '').split(/\s{2,}/);

    expect(cells).toContain(msg('cli.db.backfill.none'));
    expect(cells.filter((cell) => cell === msg('cli.db.backfill.none'))).toHaveLength(2);
    expect(lines.join('\n')).not.toContain('⟦');
  });
});

// ── the diff and the runner ───────────────────────────────────────────────

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
  backfill<Post>({ name, source: sweepSource, handle: () => undefined, ...over });

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
