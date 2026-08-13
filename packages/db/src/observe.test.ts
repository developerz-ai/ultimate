// Single responsibility: tests for the statement observer seam itself — install, replace,
// uninstall, and the two guarantees the funnels are written against. Uninstalled must read
// `undefined` (the production path), and an installed observer must be handed back by identity:
// a wrapper here would swallow the throw strict test mode depends on. The last block is the
// capstone the seam promises but no single-file test proves alone: with nothing installed, both
// funnels (`client.ts`, `pglite.ts`) never read a clock — the one signal that an event was about
// to be assembled — and a statement returns exactly what it returned before the seam existed.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createPostgresClient } from './client';
import type { StatementEvent, StatementObserver } from './observe';
import { setStatementObserver, statementObserver } from './observe';
import { createPgliteClient, type PgliteDriver } from './pglite';
import { sql } from './sql';

function recorder(): StatementObserver & { readonly seen: StatementEvent[] } {
  const seen: StatementEvent[] = [];
  return {
    seen,
    onStatement(event: StatementEvent): void {
      seen.push(event);
    },
  };
}

const EVENT: StatementEvent = {
  text: 'select * from members where id = $1',
  values: ['m_1'],
  durationMs: 1.5,
  rows: 1,
};

const TEST_URL = 'postgres://app@127.0.0.1:5432/ultimate_test';

// `Bun.SQL` is writable but not configurable, so the seam is assignment plus an afterEach restore.
const host = globalThis as unknown as { Bun: { SQL: unknown } };
const realBunSql = host.Bun.SQL;

function installFakeSql(rows: readonly unknown[] = []): void {
  host.Bun.SQL = class {
    async unsafe(): Promise<unknown> {
      return rows;
    }
    async close(): Promise<void> {}
  };
}

const fakePgliteDriver = (rows: readonly Record<string, unknown>[] = []): PgliteDriver => ({
  query: async () => ({ rows }),
  close: async () => undefined,
});

/** Assigned by the block below, restored here: `performance.now` is process-wide like the other two. */
let clock: ReturnType<typeof spyOn<Performance, 'now'>> | undefined;

afterEach(() => {
  host.Bun.SQL = realBunSql;
  setStatementObserver(undefined);
  // Not after the `expect`: a failed assertion throws first, and a spy left on the clock rewrites
  // it for every test after this one — so the next failure names a test two files down from the
  // real one.
  clock?.mockRestore();
  clock = undefined;
});

describe('statementObserver', () => {
  test('reads undefined when nothing is installed', () => {
    expect(statementObserver()).toBeUndefined();
  });

  test('hands back the installed observer by identity, never a wrapper', () => {
    // The funnels call `.onStatement` on whatever this returns. A guarding facade would contain a
    // throw, and strict test mode is an observer whose throw must fail the test.
    const observer = recorder();
    setStatementObserver(observer);
    expect(statementObserver()).toBe(observer);
  });

  test('propagates a throwing observer to the caller', () => {
    setStatementObserver({
      onStatement(): void {
        throw new Error('n+1 in a strict test');
      },
    });
    expect(() => statementObserver()?.onStatement(EVENT)).toThrow('n+1 in a strict test');
  });

  test('a second install replaces the first, which then sees nothing', () => {
    const first = recorder();
    const second = recorder();
    setStatementObserver(first);
    setStatementObserver(second);
    statementObserver()?.onStatement(EVENT);
    expect(first.seen).toHaveLength(0);
    expect(second.seen).toHaveLength(1);
  });

  test('undefined uninstalls, so the production path is one branch again', () => {
    const observer = recorder();
    setStatementObserver(observer);
    setStatementObserver(undefined);
    statementObserver()?.onStatement(EVENT);
    expect(statementObserver()).toBeUndefined();
    expect(observer.seen).toHaveLength(0);
  });

  // `attribution` is supplied here and nowhere else in a running process: no funnel sets it yet
  // (`observe.ts`). What this pins is the seam's passthrough — a field the seam dropped would be
  // invisible to a funnel test, because a funnel has nothing to drop.
  test('carries the full event through untouched, attribution and error included', () => {
    const observer = recorder();
    setStatementObserver(observer);
    const failure = new Error('statement failed');
    const event: StatementEvent = {
      text: 'insert into members (id) values ($1)',
      values: ['m_2'],
      durationMs: 0.25,
      rows: 0,
      error: failure,
      attribution: { entity: 'members', op: 'insert' },
    };
    statementObserver()?.onStatement(event);
    expect(observer.seen).toEqual([event]);
    expect(observer.seen[0]?.attribution?.entity).toBe('members');
    expect(observer.seen[0]?.error).toBe(failure);
  });
});

// The guarantee `client.ts` and `pglite.ts` document: uninstalled, `runOn`/`statement` costs one
// property read and one branch — no clock read, no span, no event object — and hand straight to
// `sendOn`/`send`. `observer.seen` staying empty (asserted in `client.test.ts`/`pglite.test.ts`)
// proves nothing built reached the observer; it does not prove nothing was built at all. Reading
// the clock is the first thing either funnel does once it decides to assemble an event, so a
// `performance.now()` spy is the closest a unit test gets to proving the allocation itself never
// happened, on the exact same fake statement, with only the installed-or-not bit changed.
describe('the production path — no observer installed', () => {
  test('the pooled client never reads the clock', async () => {
    installFakeSql();
    clock = spyOn(performance, 'now');

    await createPostgresClient({ url: TEST_URL }).query(sql`select 1`);

    expect(clock).not.toHaveBeenCalled();
  });

  test('the embedded client never reads the clock', async () => {
    clock = spyOn(performance, 'now');

    await createPgliteClient({ driver: fakePgliteDriver() }).query(sql`select 1`);

    expect(clock).not.toHaveBeenCalled();
  });

  test('installing an observer is what makes the clock read happen at all', async () => {
    installFakeSql();
    setStatementObserver({ onStatement: () => undefined });
    clock = spyOn(performance, 'now');

    await createPostgresClient({ url: TEST_URL }).query(sql`select 1`);

    // Proves the two tests above are a real fork in the code, not an unreachable spy.
    expect(clock).toHaveBeenCalled();
  });

  test('a silent observer changes nothing about what a statement returns', async () => {
    installFakeSql([{ id: 1 }]);
    const bare = await createPostgresClient({ url: TEST_URL }).query(sql`select ${1}`);

    installFakeSql([{ id: 1 }]);
    setStatementObserver({ onStatement: () => undefined });
    const observed = await createPostgresClient({ url: TEST_URL }).query(sql`select ${1}`);

    // Byte-identical `runOn` behavior: the observed shell hands `sendOn` the same call and returns
    // exactly what it returned, whether or not anything is installed to watch it happen.
    expect(observed).toEqual(bare);
  });
});
