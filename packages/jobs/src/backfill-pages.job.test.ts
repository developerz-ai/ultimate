// `backfill({ pages })` against Postgres: a remote cursor walk as one durable step per page, and a
// scoped pass keyed `<name>:<scope>`. Pins what `recipes.job.test.ts`' hand-written walk proved —
// killed mid-page, it resumes on that page and no earlier page is fetched again — through the
// factory, plus two scopes keeping two ledgers and the checksum moving with `pages`.

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { installJobDriver, resetJobDriver } from './adapter';
import { backfill } from './backfill';
import type { BackfillPage } from './backfill-definition';
import { backfillOrigin } from './backfill-registry';
import type { JobDriver } from './driver';
import { postgresJobDriver } from './driver-pg';
import { embeddedPg } from './embedded-pg-fixture';
import { resetJobs } from './job';
import { type KeyedHarness, TTL_MS, workerOn } from './keyed-concurrency-fixture';
import { resetJobsFacade } from './outbox';

setDefaultTimeout(120_000);

const harness: KeyedHarness = {
  async driver(): Promise<JobDriver> {
    const pg = await embeddedPg();
    await pg.reset();
    return postgresJobDriver({ executor: pg.executor });
  },
  async elapse(_driver, ms): Promise<void> {
    await (await embeddedPg()).age(ms);
  },
};

/** The fake vendor: three pages, cursors `'0' → '2' → '4' → null`. */
const VENDOR: Record<string, BackfillPage<number>> = {
  '0': { rows: [1, 2], next: '2' },
  '2': { rows: [3, 4], next: '4' },
  '4': { rows: [5, 6], next: null },
};

const pageAt = (cursor: string | null): BackfillPage<number> => {
  const page = VENDOR[cursor ?? '0'];
  if (page === undefined) return expect.unreachable(`no page at cursor ${String(cursor)}`);
  return page;
};

interface Gate {
  readonly passed: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open = (): void => undefined;
  const passed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { passed, open: () => open() };
}

let driver: JobDriver;
let minted = 0;
const named = (what: string): string => {
  minted += 1;
  return `pages-${what}-${minted}`;
};

beforeEach(async () => {
  driver = await harness.driver();
  installJobDriver(driver);
});

afterEach(() => {
  resetJobsFacade();
  resetJobDriver();
  resetJobs();
});

afterAll(async () => {
  await (await embeddedPg()).close();
});

describe('a remote source as pages', () => {
  test('killed mid-page, it resumes on that page and no earlier page is fetched again', async () => {
    const fetched: (string | null)[] = [];
    const handled: number[][] = [];
    const killedAt = gate();
    const zombie = gate();
    const handle = backfill<number>({
      name: named('walk'),
      tenant: 'none',
      rate: 1_000,
      // Two: the kill costs the attempt a lapsed lease always costs.
      retry: { attempts: 2, jitter: false },
      async pages({ cursor }) {
        fetched.push(cursor);
        if (cursor === '4' && fetched.filter((at) => at === '4').length === 1) {
          killedAt.open();
          await zombie.passed;
        }
        return pageAt(cursor);
      },
      handle: ({ rows }) => {
        handled.push([...rows]);
      },
    });
    await handle.enqueue({});

    const dead = workerOn(harness, driver, 'w-dead');
    const orphaned = dead.tick();
    await killedAt.passed;
    await harness.elapse(driver, TTL_MS + 1_000);
    const next = workerOn(harness, driver, 'w-next');
    expect((await next.tick()).map((run) => run.result)).toEqual([
      { name: handle.name, batches: 3, rows: 6, skipped: false },
    ]);

    expect(fetched).toEqual([null, '2', '4', '4']);
    expect(handled).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    const ledger = (await driver.backfills?.list({ name: handle.name })) ?? [];
    expect(ledger.map((row) => [row.status, row.rows])).toEqual([['completed', 6]]);
    zombie.open();
    await orphaned;
  });
});

describe('a scoped pass', () => {
  test('two scopes keep two ledgers and two live keys; a completed scope is skipped', async () => {
    const swept: string[] = [];
    const handle = backfill<number, { readonly account: string }>({
      name: named('sync'),
      tenant: 'none',
      rate: 1_000,
      input: t.object({ account: t.string }),
      scope: ({ account }) => account,
      pages: async ({ cursor, input }) => {
        swept.push(`${input.account}@${String(cursor)}`);
        return pageAt(cursor);
      },
      handle: () => undefined,
    });
    const first = await handle.enqueue({ input: { account: 'acct-1' } });
    const second = await handle.enqueue({ input: { account: 'acct-2' } });
    expect(second.id).not.toBe(first.id);
    expect(second.deduped).toBe(false);

    const worker = workerOn(harness, driver, 'w-scoped');
    await worker.tick();
    await worker.tick();
    expect(swept.filter((at) => at.startsWith('acct-1'))).toHaveLength(3);
    expect(swept.filter((at) => at.startsWith('acct-2'))).toHaveLength(3);
    const names = ((await driver.backfills?.list({})) ?? []).map((row) => row.name).sort();
    expect(names).toEqual([`${handle.name}:acct-1`, `${handle.name}:acct-2`]);

    await handle.enqueue({ input: { account: 'acct-1' } });
    expect((await worker.tick()).map((run) => run.result)).toMatchObject([{ skipped: true }]);
    expect(swept).toHaveLength(6);
  });
});

describe('the declaration', () => {
  test('a changed pages function changes the checksum', () => {
    const declare = (next: string | null) =>
      backfill<number>({
        name: named('sum'),
        tenant: 'none',
        pages: async () => ({ rows: [], next }),
        handle: () => undefined,
      });
    const one = backfillOrigin(declare(null))?.checksum;
    const other = backfillOrigin(
      backfill<number>({
        name: named('sum'),
        tenant: 'none',
        pages: async ({ cursor }) => ({ rows: [], next: cursor }),
        handle: () => undefined,
      }),
    )?.checksum;
    expect(one).toBeDefined();
    expect(one).not.toBe(other);
  });

  test('both or neither of source and pages, or input without scope, is X_BACKFILL_SOURCE_INVALID', () => {
    const refused = (definition: unknown): string | undefined => {
      try {
        backfill(definition as Parameters<typeof backfill<number>>[0]);
      } catch (error) {
        return isUltimateError(error) ? error.code : undefined;
      }
      return undefined;
    };
    const base = { name: named('bad'), tenant: 'none', handle: () => undefined };
    const pages = async () => ({ rows: [], next: null });
    expect(refused(base)).toBe('X_BACKFILL_SOURCE_INVALID');
    expect(refused({ ...base, pages, source: () => undefined })).toBe('X_BACKFILL_SOURCE_INVALID');
    expect(refused({ ...base, pages, input: t.object({ account: t.string }) })).toBe(
      'X_BACKFILL_SOURCE_INVALID',
    );
  });
});
