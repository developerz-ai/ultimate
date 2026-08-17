// Split out of `pglite.test.ts` to stay under the file-size ceiling, along the seam the source
// already has: `pglite.test.ts` pins the adapter's ordering against fakes, and this file pins the
// one funnel every statement passes through — `observe.ts`'s seam, the attribution and the
// expected-loop reason stamped on the event.

import { afterEach, describe, expect, test } from 'bun:test';
import { withStatementAttribution } from './attribution';
import { setDbClient } from './client';
import { expectedQueryLoop } from './expected-loop';
import { fakeDriver } from './fake-pglite';
import type { StatementEvent, StatementObserver } from './observe';
import { setStatementObserver } from './observe';
import { createPgliteClient } from './pglite';
import { sql } from './sql';
import { withTransaction } from './transaction';

const failure = async (run: () => Promise<unknown>): Promise<{ code: string; fix: string }> => {
  try {
    await run();
  } catch (error) {
    return error as { code: string; fix: string };
  }
  throw new Error('expected the call to reject');
};

function recorder(): StatementObserver & { readonly seen: StatementEvent[] } {
  const seen: StatementEvent[] = [];
  return {
    seen,
    onStatement(event: StatementEvent): void {
      seen.push(event);
    },
  };
}

describe('the statement observer', () => {
  afterEach(() => {
    // Both are process-wide: leaving either installed makes every later test observe this one's.
    setStatementObserver(undefined);
    setDbClient(undefined);
  });

  // `statement()` is the funnel: the queued path, the pinned path and the in-transaction path that
  // skips the queue all land on it. A detector fed by only one of the three would be blind to
  // exactly the reads that happen inside a transaction.
  test('sees every statement once, whichever of the three paths it took', async () => {
    const driver = fakeDriver({ rows: [{ id: 1 }, { id: 2 }], affectedRows: 0 });
    const client = createPgliteClient({ driver });
    setDbClient(client);
    const observer = recorder();
    setStatementObserver(observer);

    await client.query(sql`select id from posts where org = ${'o_1'}`);
    await withTransaction(async (tx) => {
      await tx.execute(sql`insert into posts values (${1})`);
      // Through the ambient client, so it reaches `run()` with a transaction open and skips the
      // queue rather than waiting for a turn the transaction is already holding.
      await client.query(sql`select id from posts`);
    });

    expect(observer.seen.map((event) => event.text)).toEqual([
      'select id from posts where org = $1',
      'BEGIN',
      'insert into posts values ($1)',
      'select id from posts',
      'COMMIT',
    ]);
    expect(observer.seen[0]?.values).toEqual(['o_1']);
    expect(observer.seen[0]?.rows).toBe(2);
    expect(observer.seen[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(observer.seen[0]).not.toHaveProperty('error');
  });

  // The same count `execute()` answers with, from the same helper — a report saying 0 rows for
  // every write while `execute` said 3 would make the two disagree about the same statement.
  test('counts rows the way execute does: the command tag for a write', async () => {
    const client = createPgliteClient({ driver: fakeDriver({ rows: [], affectedRows: 3 }) });
    const observer = recorder();
    setStatementObserver(observer);

    expect(await client.execute(sql`delete from posts`)).toBe(3);
    expect(observer.seen[0]?.rows).toBe(3);
  });

  test('reports a failed statement with the error the caller is about to be thrown', async () => {
    const client = createPgliteClient({
      driver: {
        query: () => Promise.reject(new Error('syntax error')),
        close: async () => undefined,
      },
    });
    const observer = recorder();
    setStatementObserver(observer);

    const error = await failure(() => client.query(sql`selct 1`));

    expect(error.code).toBe('X_DB_UNAVAILABLE');
    // Identity, not shape: the event carries the very error thrown, already wrapped by the funnel.
    expect(observer.seen[0]?.error).toBe(error);
    expect(observer.seen[0]?.rows).toBe(0);
  });

  // Strict test mode is an observer that throws, and the throw must arrive as itself. Notifying
  // inside the statement's own `try` would report a statement that succeeded as X_DB_UNAVAILABLE.
  test('a throwing observer reaches the caller as its own error, not a database failure', async () => {
    const client = createPgliteClient({ driver: fakeDriver({ rows: [] }) });
    setStatementObserver({
      onStatement(): void {
        throw new Error('n+1 in a strict test');
      },
    });

    await expect(client.query(sql`select 1`)).rejects.toThrow('n+1 in a strict test');
  });

  test('booting, reserving and closing are not statements', async () => {
    const driver = fakeDriver({ rows: [] });
    const client = createPgliteClient({ driver });
    const observer = recorder();
    setStatementObserver(observer);

    await client.ping();
    (await client.reserve()).release();
    await client.close();

    expect(observer.seen).toEqual([]);
  });

  test('an uninstalled seam observes nothing, which is the production path', async () => {
    const observer = recorder();
    setStatementObserver(observer);
    setStatementObserver(undefined);

    await createPgliteClient({ driver: fakeDriver({ rows: [] }) }).query(sql`select 1`);

    expect(observer.seen).toEqual([]);
  });

  test('carries the attribution declared by the scope, undefined outside every scope', async () => {
    const client = createPgliteClient({ driver: fakeDriver({ rows: [] }) });
    const observer = recorder();
    setStatementObserver(observer);

    await withStatementAttribution('members', 'findById', () => client.query(sql`select 1`));
    await client.query(sql`select 2`);

    expect(observer.seen.map((event) => event.attribution)).toEqual([
      { entity: 'members', op: 'findById' },
      undefined,
    ]);
  });

  test('the failing statement path still carries the attribution', async () => {
    const client = createPgliteClient({
      driver: { query: () => Promise.reject(new Error('boom')), close: async () => undefined },
    });
    const observer = recorder();
    setStatementObserver(observer);

    await failure(() =>
      withStatementAttribution('members', 'findById', () => client.query(sql`selct 1`)),
    );

    expect(observer.seen[0]?.attribution).toEqual({ entity: 'members', op: 'findById' });
    expect(observer.seen[0]?.rows).toBe(0);
  });

  // Two independent scopes: an expected-loop reason does not crowd out the attribution.
  test('attribution and an expected-loop reason are stamped together, independently', async () => {
    const client = createPgliteClient({ driver: fakeDriver({ rows: [] }) });
    const observer = recorder();
    setStatementObserver(observer);

    await withStatementAttribution('members', 'findMany', () =>
      expectedQueryLoop('one lookup per id', () => client.query(sql`select 1`)),
    );

    expect(observer.seen[0]?.attribution).toEqual({ entity: 'members', op: 'findMany' });
    expect(observer.seen[0]?.expected).toBe('one lookup per id');
  });
});
