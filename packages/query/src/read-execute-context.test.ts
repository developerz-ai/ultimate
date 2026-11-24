// A source handed out by `sourceFor` is EXECUTED by its caller, later — and a `from()` source's
// rows (a tenant-scoped repository call) run only then. Built as an actor, it must execute as that
// actor: `exerciseQuery` executes outside the build's frame, and a repository call
// there met no actor at all (`X_TENANCY_UNSCOPED`) while the same call in an action was scoped.

import { afterEach, describe, expect, test } from 'bun:test';
import type { AuditRecord } from '@ultimat3/core';
import { tryUseContext, useContext, userActor } from '@ultimat3/core';
import { installAuditSink, resetAuditSink } from '@ultimat3/core/adapter';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { exerciseQuery } from './exercise';
import { query } from './query';
import { sourceFor } from './read';
import { resetQueries } from './registry';
import type { SqlSource } from './source';
import { from } from './source';

const caller = userActor({ id: 'u1', orgId: 'org-a' });
const AS_CALLER = 'u1@org-a';

interface Row {
  readonly id: string;
  readonly rank: number;
  readonly seenBy: string;
}

/** `actor@org` of the context this line runs in, `NONE` outside one. */
const identity = (): string => {
  const actor = tryUseContext()?.actor;
  return actor === undefined ? 'NONE' : `${actor.id}@${actor.orgId ?? 'no-org'}`;
};

/**
 * Two rows tie on `rank`, served in the opposite of their `id` order: only `total()` (rank, then
 * id) reorders them, and only a real seek past `(1, '1')` drops the rows at or before it.
 */
const STORED: readonly Omit<Row, 'seenBy'>[] = [
  { id: '3', rank: 1 },
  { id: '1', rank: 1 },
  { id: '2', rank: 0 },
];

/** The rows are produced at `execute()` — where a tenant-scoped repo derives its tenant. */
const observed: string[] = [];
const target = (audit = false) =>
  query({
    input: t.object({ noop: t.boolean }),
    policy: allow('public'),
    ...(audit ? { audit: true } : {}),
    sql: () =>
      from<Row>('posts', () => {
        const seenBy = identity();
        observed.push(seenBy);
        return STORED.map((row) => ({ ...row, seenBy }));
      }).orderBy('rank', 'asc'),
  }).named('observeExecuteIdentity');

/** What an `execute()` outside any context answers: `id@seenBy` per row. */
const read = async (source: SqlSource<object> | undefined) =>
  ((await source?.execute()) as readonly Row[] | undefined)?.map(
    (row) => `${row.id}@${row.seenBy}`,
  );

afterEach(() => {
  observed.length = 0;
  resetQueries();
  resetAuditSink();
});

describe('a handed-out source executes as the actor it was built for', () => {
  test('execute() outside any context, and its seek and total too', async () => {
    const source = await sourceFor(target(), { noop: true }, { actor: caller });
    expect(await read(source)).toEqual(['2@u1@org-a', '3@u1@org-a', '1@u1@org-a']);
    expect(await read(source.total?.())).toEqual(['2@u1@org-a', '1@u1@org-a', '3@u1@org-a']);
    expect(await read(source.seek?.({ key: [1], id: '1' }, 10))).toEqual(['3@u1@org-a']);
  });

  test('an audited read executes as the actor too, and records that one call', async () => {
    const records: AuditRecord[] = [];
    installAuditSink({ write: (record) => void records.push(record) });
    const source = await sourceFor(target(true), { noop: true }, { actor: caller });
    expect(records).toEqual([]);
    expect(await read(source.seek?.({ key: [1], id: '1' }, 10))).toEqual(['3@u1@org-a']);
    expect(observed).toEqual([AS_CALLER]);
    expect(records.map((record) => record.outcome)).toEqual(['allowed']);
  });

  test("an app's own source that reads useContext() in seek and total reads the build's", async () => {
    const asked: string[] = [];
    const own = (name: string): SqlSource<{ readonly by: string }> => ({
      toSQL: () => ({ sql: 'select 1', params: [] }),
      shape: () => ({ entity: 'posts', filters: [], orderBy: [], limit: null, unsupported: [] }),
      execute: async () => [{ by: `${name}:${identity()}` }],
      total: () => {
        useContext();
        asked.push(`total:${identity()}`);
        return own('total');
      },
      seek: () => {
        useContext();
        asked.push(`seek:${identity()}`);
        return own('seek');
      },
    });
    const custom = query({
      input: t.object({ noop: t.boolean }),
      policy: allow('public'),
      sql: () => own('built'),
    }).named('observeOwnSource');
    const source = await sourceFor(custom, { noop: true }, { actor: caller });
    expect(await source.total?.().execute()).toEqual([{ by: `total:${AS_CALLER}` }]);
    expect(await source.seek?.(null, 5).execute()).toEqual([{ by: `seek:${AS_CALLER}` }]);
    expect(asked).toEqual([`total:${AS_CALLER}`, `seek:${AS_CALLER}`]);
  });

  test('exerciseQuery reads as its declared actor', async () => {
    await exerciseQuery(target(), { actor: caller, runs: 2 });
    expect(observed.length).toBeGreaterThan(0);
    expect(new Set(observed)).toEqual(new Set([AS_CALLER]));
  });
});
