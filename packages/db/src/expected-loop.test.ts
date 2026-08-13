// Single responsibility: tests for the one suppression mechanism — the scope itself (what it
// carries, across awaits, under nesting and under two loops running at once) and the proof that
// both funnels stamp the reason onto the statements the loop issued. The failure this closes is a
// diagnostic that judges a request after its scopes have all closed and so has to guess.

import { afterEach, describe, expect, test } from 'bun:test';
import { createPostgresClient, setDbClient } from './client';
import { expectedQueryLoop, expectedQueryLoopReason } from './expected-loop';
import type { StatementEvent, StatementObserver } from './observe';
import { setStatementObserver } from './observe';
import { createPgliteClient, type PgliteDriver } from './pglite';
import { sql } from './sql';
import { withTransaction } from './transaction';

const TEST_URL = 'postgres://app@127.0.0.1:5432/ultimate_test';
const REASON = 'admin search runs one indexed lookup per text field';

const host = globalThis as unknown as { Bun: { SQL: unknown } };
const realBunSql = host.Bun.SQL;

/** Enough `Bun.SQL` to answer one statement — the funnel is under test here, not the pool. */
function installFakeSql(fail?: Error): void {
  host.Bun.SQL = class {
    async unsafe(): Promise<unknown> {
      if (fail !== undefined) throw fail;
      return [];
    }
    async close(): Promise<void> {}
  };
}

const fakeDriver = (fail?: Error): PgliteDriver => ({
  query: async () => {
    if (fail !== undefined) throw fail;
    return { rows: [] };
  },
  close: async () => undefined,
});

function recorder(): StatementObserver & { readonly seen: StatementEvent[] } {
  const seen: StatementEvent[] = [];
  return {
    seen,
    onStatement(event: StatementEvent): void {
      seen.push(event);
    },
  };
}

/** Two loops interleave deterministically only if each can hand the turn over on demand. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = (): void => settle();
  });
  return { promise, resolve };
}

afterEach(() => {
  host.Bun.SQL = realBunSql;
  // All three are process-wide: one left installed makes every later test run against this one's.
  setStatementObserver(undefined);
  setDbClient(undefined);
});

describe('unit · the expected-loop scope', () => {
  test('reads undefined outside every scope, which is the whole of an app that never calls it', () => {
    expect(expectedQueryLoopReason()).toBeUndefined();
  });

  test('carries the reason inside, and nothing after the scope closes', () => {
    const returned = expectedQueryLoop(REASON, () => expectedQueryLoopReason());

    expect(returned).toBe(REASON);
    expect(expectedQueryLoopReason()).toBeUndefined();
  });

  test('survives every await, at any depth — the loop is asynchronous or it is not a loop', async () => {
    const nested = async (): Promise<string | undefined> => {
      await Promise.resolve();
      return expectedQueryLoopReason();
    };

    const seen = await expectedQueryLoop(REASON, async () => {
      await Promise.resolve();
      return nested();
    });

    expect(seen).toBe(REASON);
  });

  test('nesting keeps the innermost reason, and the outer one is back afterwards', () => {
    expectedQueryLoop('outer loop', () => {
      expect(expectedQueryLoopReason()).toBe('outer loop');
      expectedQueryLoop('inner loop', () => {
        expect(expectedQueryLoopReason()).toBe('inner loop');
      });
      expect(expectedQueryLoopReason()).toBe('outer loop');
    });
  });

  test('two loops running at once never read each other, so one request cannot silence another', async () => {
    const started = deferred();
    const read = deferred();

    // `first` suspends inside its own scope while `second` runs entirely inside its own.
    const first = expectedQueryLoop('first loop', async () => {
      started.resolve();
      await read.promise;
      return expectedQueryLoopReason();
    });
    const second = expectedQueryLoop('second loop', async () => {
      await started.promise;
      const mine = expectedQueryLoopReason();
      read.resolve();
      return mine;
    });

    expect(await Promise.all([first, second])).toEqual(['first loop', 'second loop']);
    expect(expectedQueryLoopReason()).toBeUndefined();
  });

  test('a throw leaves no scope behind, on either the sync or the async path', async () => {
    expect(() =>
      expectedQueryLoop(REASON, () => {
        throw new Error('the loop body failed');
      }),
    ).toThrow('the loop body failed');
    expect(expectedQueryLoopReason()).toBeUndefined();

    await expect(
      expectedQueryLoop(REASON, async () => {
        throw new Error('the awaited body failed');
      }),
    ).rejects.toThrow('the awaited body failed');
    expect(expectedQueryLoopReason()).toBeUndefined();
  });

  // An exemption with no argument is a comment pragma with extra steps: the next reader cannot
  // tell a considered loop from a silenced one, which is the thing this mechanism exists to fix.
  test('a blank reason is refused, and the body never runs', () => {
    let ran = false;
    let caught: unknown;
    try {
      expectedQueryLoop('   ', () => {
        ran = true;
      });
    } catch (error) {
      caught = error;
    }

    // Asserted on what was caught rather than guarded by a bare `throw`: a scope that accepted the
    // blank reason leaves `caught` undefined, which fails here for the reason it actually failed.
    expect(caught).toBeUltimateError('X_INVARIANT');
    expect(ran).toBe(false);
  });
});

describe('unit · both funnels stamp the reason on what the loop issued', () => {
  test('the pooled client marks a statement issued inside the scope', async () => {
    const observer = recorder();
    setStatementObserver(observer);
    installFakeSql();
    const client = createPostgresClient({ url: TEST_URL });

    await expectedQueryLoop(REASON, () => client.query(sql`select id from members`));
    await client.query(sql`select id from posts`);

    expect(observer.seen.map((event) => event.expected)).toEqual([REASON, undefined]);
  });

  test('the embedded client marks a statement issued inside the scope', async () => {
    const observer = recorder();
    setStatementObserver(observer);
    const client = createPgliteClient({ driver: fakeDriver() });

    await expectedQueryLoop(REASON, () => client.query(sql`select id from members`));
    await client.query(sql`select id from posts`);

    expect(observer.seen.map((event) => event.expected)).toEqual([REASON, undefined]);
  });

  // The embedded funnel's other two paths, which the plain case above never reaches: `BEGIN` and
  // `COMMIT` queue for a turn, and a statement issued while the transaction holds that turn skips
  // the queue entirely. Every one of them settles several `await`s after the scope opened, and the
  // reason has to survive all of them — a store lost at the queue would report the framework's own
  // per-migration transaction as an N+1 nobody argued for.
  test('the embedded client keeps the reason across the turn queue and a transaction', async () => {
    const observer = recorder();
    setStatementObserver(observer);
    const client = createPgliteClient({ driver: fakeDriver() });
    setDbClient(client);

    await expectedQueryLoop(REASON, () =>
      withTransaction(async (tx) => {
        await tx.query(sql`select id from members`);
        // Through the ambient client, so it arrives with a transaction open and runs direct.
        await client.query(sql`select id from posts`);
      }),
    );
    await client.query(sql`select id from posts`);

    expect(observer.seen.map((event) => event.text)).toEqual([
      'BEGIN',
      'select id from members',
      'select id from posts',
      'COMMIT',
      'select id from posts',
    ]);
    expect(observer.seen.map((event) => event.expected)).toEqual([
      REASON,
      REASON,
      REASON,
      REASON,
      undefined,
    ]);
  });

  // Fifty identical timeouts inside a declared loop are still that loop: the failing path carries
  // the reason too, or a detector counting failures reports the one loop that argued for itself.
  test('a failed statement inside the scope still carries the reason, on both funnels', async () => {
    const observer = recorder();
    setStatementObserver(observer);
    installFakeSql(new Error('connection reset'));

    await expect(
      expectedQueryLoop(REASON, () =>
        createPostgresClient({ url: TEST_URL }).query(sql`select id from members`),
      ),
    ).rejects.toBeUltimateError('X_DB_UNAVAILABLE');
    await expect(
      expectedQueryLoop(REASON, () =>
        createPgliteClient({ driver: fakeDriver(new Error('boom')) }).query(sql`select 1`),
      ),
    ).rejects.toBeUltimateError('X_DB_UNAVAILABLE');

    expect(observer.seen.map((event) => event.expected)).toEqual([REASON, REASON]);
    expect(observer.seen.map((event) => event.rows)).toEqual([0, 0]);
  });
});
