// `x jobs list` paging: `--json` answers core's ONE `Page` — `rows`, `nextCursor`, `hasMore` — and
// the cursor exists only when another row does. A cursor guessed from a full page's row count
// handed the caller a cursor to an EMPTY page whenever the last page happened to be full.

import { afterEach, describe, expect, test } from 'bun:test';
import { MAX_JOB_PAGE, memoryJobDriver, resetJobDriver, resetJobs } from '@ultimat3/jobs';
import { enqueue, runJobs } from './cmd-jobs-fixture';
import { BadFlagError } from './errors';
import { msg } from './messages';

afterEach(() => {
  resetJobDriver();
  resetJobs();
});

interface ListPageJson {
  readonly rows: readonly { readonly id: string }[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

const pageOf = (data: unknown): ListPageJson => data as ListPageJson;

describe('unit · x jobs list paging', () => {
  test('a page with more behind it answers its cursor; the walk visits every row once', async () => {
    const driver = memoryJobDriver();
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) ids.push(await enqueue(driver, 'send-email'));

    const first = await runJobs(driver, { subcommand: 'list', flags: { limit: '2' } });
    const page = pageOf(first.data);
    expect(page.rows).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(typeof page.nextCursor).toBe('string');
    expect(first.lines?.join('\n')).toContain(`x jobs list --after ${page.nextCursor}`);

    const seen = page.rows.map((row) => row.id);
    let after = page.nextCursor;
    let pages = 1;
    while (after !== null) {
      const next = pageOf(
        (await runJobs(driver, { subcommand: 'list', flags: { limit: '2', after } })).data,
      );
      seen.push(...next.rows.map((row) => row.id));
      expect(next.hasMore).toBe(next.nextCursor !== null);
      after = next.nextCursor;
      pages += 1;
    }
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(5);
    expect(pages).toBe(3);
  });

  test('a FULL last page answers no cursor — never one that fetches an empty page', async () => {
    const driver = memoryJobDriver();
    for (let index = 0; index < 4; index += 1) await enqueue(driver, 'send-email');

    const first = pageOf(
      (await runJobs(driver, { subcommand: 'list', flags: { limit: '2' } })).data,
    );
    expect([first.rows.length, first.hasMore]).toEqual([2, true]);
    const last = await runJobs(driver, {
      subcommand: 'list',
      flags: { limit: '2', after: first.nextCursor ?? '' },
    });
    const page = pageOf(last.data);
    expect([page.rows.length, page.nextCursor, page.hasMore]).toEqual([2, null, false]);
    expect(last.lines?.join('\n')).not.toContain(msg('cli.jobs.nextPage', { cursor: '' }).trim());
  });

  test('a queue that fits one default page exactly is one page', async () => {
    const driver = memoryJobDriver();
    for (let index = 0; index < 100; index += 1) await enqueue(driver, 'send-email');

    const page = pageOf((await runJobs(driver, { subcommand: 'list' })).data);
    expect([page.rows.length, page.nextCursor, page.hasMore]).toEqual([100, null, false]);
  });

  // At the queue's own bound there is no room to ask for one extra row (`limit` past
  // `MAX_JOB_PAGE` is refused by the driver), so a full maximal page is settled by a probe.
  test('a full page at MAX_JOB_PAGE knows whether one more row exists', async () => {
    const driver = memoryJobDriver();
    for (let index = 0; index < MAX_JOB_PAGE; index += 1) await enqueue(driver, 'send-email');
    const limit = String(MAX_JOB_PAGE);

    const exact = pageOf((await runJobs(driver, { subcommand: 'list', flags: { limit } })).data);
    expect([exact.rows.length, exact.nextCursor, exact.hasMore]).toEqual([
      MAX_JOB_PAGE,
      null,
      false,
    ]);

    await enqueue(driver, 'send-email');
    const over = pageOf((await runJobs(driver, { subcommand: 'list', flags: { limit } })).data);
    expect([over.rows.length, over.hasMore]).toEqual([MAX_JOB_PAGE, true]);
    const tail = pageOf(
      (
        await runJobs(driver, {
          subcommand: 'list',
          flags: { limit, after: over.nextCursor ?? '' },
        })
      ).data,
    );
    expect([tail.rows.length, tail.nextCursor, tail.hasMore]).toEqual([1, null, false]);
  });

  test('an empty queue is one empty, final page', async () => {
    const page = pageOf((await runJobs(memoryJobDriver(), { subcommand: 'list' })).data);
    expect(page).toMatchObject({ rows: [], nextCursor: null, hasMore: false });
  });

  test('a page past the queue`s bound is a flag error naming the walk', async () => {
    const driver = memoryJobDriver();
    const refusal = await runJobs(driver, { subcommand: 'list', flags: { limit: '201' } }).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(BadFlagError);
    expect((refusal as { fix: string }).fix).toContain('x jobs list --limit 200 --json');
    expect((refusal as { fix: string }).fix).toContain('nextCursor');
  });
});
