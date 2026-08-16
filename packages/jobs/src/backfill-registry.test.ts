// The half the framework did not have: which sweeps EXIST, as against which ones ran. Every test
// here would have passed vacuously before `backfill()` stamped its handle — `registeredBackfills()`
// answering `[]` for an app full of declarations is exactly the silence that let four merged
// rewrites never happen.

import { beforeEach, describe, expect, test } from 'bun:test';
import { entity, memoryRepo, tableFor, text, uuid } from '@ultimat3/entity';
import { t } from '@ultimat3/schema';
import { backfill } from './backfill';
import {
  backfillOrigin,
  declarationOf,
  getBackfill,
  isBackfill,
  registeredBackfills,
} from './backfill-registry';
import { job, resetJobs } from './job';
import { DEFAULT_RETRY } from './retry';

const rows = entity('backfill_registry_rows', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), title: text({ max: 40 }) },
});

type Row = typeof rows.$row;

const ORG = '00000000-0000-7000-8000-0000000000b1';

const source = () => tableFor(rows, memoryRepo(rows, [])).where({ orgId: ORG });

const declareBackfill = (name: string, over: Record<string, unknown> = {}) =>
  backfill<Row>({ name, tenant: 'none', source, handle: () => undefined, ...over });

beforeEach(() => {
  resetJobs();
});

describe('unit · the declaration registry', () => {
  test('an app that declared nothing has nothing pending — the empty case is an ANSWER', () => {
    expect(registeredBackfills()).toEqual([]);
    expect(getBackfill('never-declared')).toBeUndefined();
  });

  test('a plain job is NOT a backfill, however job-shaped it looks', () => {
    // The failure this closes: a structural guard reading `kind: 'job'` would hand every job in
    // the app the pending diff, the gate and the deploy trigger it was never declared for.
    const plain = job({
      tenant: 'none',
      name: 'send-digest',
      input: t.object({}),
      idempotencyKey: () => 'send-digest',
      retry: DEFAULT_RETRY,
      run: () => Promise.resolve(undefined),
    });
    expect(isBackfill(plain)).toBe(false);
    expect(declarationOf(plain)).toBeUndefined();
    expect(registeredBackfills()).toEqual([]);
    expect(getBackfill('send-digest')).toBeUndefined();
  });

  test('a look-alike object never passes the guard', () => {
    expect(isBackfill({ kind: 'job', name: 'rewrite-titles' })).toBe(false);
    expect(isBackfill(undefined)).toBe(false);
  });

  test('a declared backfill enumerates itself, with no register() call from the app', () => {
    const handle = declareBackfill('rewrite-titles');
    expect(isBackfill(handle)).toBe(true);
    expect(getBackfill('rewrite-titles')).toBe(handle);

    const declarations = registeredBackfills();
    expect(declarations.map((row) => row.name)).toEqual(['rewrite-titles']);
    const [only] = declarations;
    expect(only?.kind).toBe('backfill');
    expect(only?.requires).toBeNull();
    expect(only?.environments).toBeNull();
    expect(only?.counts).toBe(false);
    // The checksum is the ledger's own, so a declaration and its row are comparable.
    expect(only?.checksum).toMatch(/^[0-9a-f]{32}$/);
  });

  test('optional declaration fields arrive as DATA, never as an implied convention', () => {
    declareBackfill('drop-legacy', {
      requires: '20260814120000_add_publish_at',
      environments: ['staging', 'production'],
      count: () => 0,
    });
    const [row] = registeredBackfills();
    expect(row?.requires).toBe('20260814120000_add_publish_at');
    expect(row?.environments).toEqual(['staging', 'production']);
    expect(row?.counts).toBe(true);
  });

  test('count() keeps its declaration as `this`, so a method body is not a landmine', async () => {
    // A reference torn off the object literal would run with `this` undefined and throw here.
    const definition = {
      name: 'counted',
      tenant: 'none' as const,
      source,
      handle: () => undefined,
      offset: 7,
      count(): number {
        return this.offset ?? -1;
      },
    };
    const handle = backfill<Row>(definition);
    const origin = backfillOrigin(handle);
    expect(origin?.count).toBeDefined();
    expect(await origin?.count?.({ ctx: {} as never })).toBe(7);
  });

  test('declarations come back sorted by name, because registeredJobs() is', () => {
    declareBackfill('zzz-last');
    declareBackfill('aaa-first');
    expect(registeredBackfills().map((row) => row.name)).toEqual(['aaa-first', 'zzz-last']);
  });
});
