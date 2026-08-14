// The ledger projection behind `x db backfill --list`, driven through `createMemoryDriver()` —
// a real `BackfillLedger` with real start/progress/finish semantics, so a row here got its
// `cursor` and `durationMs` the way a pg ledger would. No `ParsedArgs`, no app, no queue boot.

import { describe, expect, test } from 'bun:test';
import type { BackfillStatus, JobDriver } from '@ultimat3/jobs';
import { createMemoryDriver } from '@ultimat3/jobs';
import {
  BACKFILL_STATUSES,
  listBackfills,
  parseBackfillStatusFlag,
  renderBackfillTable,
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
