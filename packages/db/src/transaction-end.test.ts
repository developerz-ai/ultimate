// Single responsibility: how a transaction scope ENDS when the database does not cooperate — a
// `ROLLBACK TO` that fails, a COMMIT whose answer never arrives, a COMMIT the server refuses — and
// what a nested scope may ask for. Scripted clients, because each of these is one answer a real
// server gives only when something else has already gone wrong.

import { describe, expect, test } from 'bun:test';
import type { DbClient } from './client';
import { dbUnavailable, driverError } from './errors';
import { recordingClient } from './fake';
import { reservableOver } from './fake-reservable-fixture';
import { sql } from './sql';
import { withTransaction } from './transaction';

interface Caught {
  readonly code?: string | undefined;
  readonly cause?: string | undefined;
  readonly sourceError?: unknown;
}

const caught = (work: Promise<unknown>): Promise<Caught | undefined> =>
  work.then(
    () => undefined,
    (error: unknown) => error as Caught,
  );

/** A client whose statements matching `fails` reject with `error`; everything else is recorded. */
function failingOn(fails: RegExp, error: unknown): { client: DbClient; texts: string[] } {
  const texts: string[] = [];
  const send = async (text: string): Promise<void> => {
    texts.push(text);
    if (fails.test(text)) throw error;
  };
  return {
    texts,
    client: {
      query: async (fragment) => {
        await send(fragment.text);
        return [];
      },
      one: async (fragment) => {
        await send(fragment.text);
        return null;
      },
      execute: async (fragment) => {
        await send(fragment.text);
        return 0;
      },
    },
  };
}

/** What the server says, as a driver hands it over: the SQLSTATE on `code`. */
const serverError = (state: string, message: string): unknown =>
  driverError('a statement', Object.assign(new RangeError(message), { code: state }));

describe('a ROLLBACK TO SAVEPOINT that fails', () => {
  test('surfaces the body error, and the root COMMIT is refused rather than sent', async () => {
    const { client, texts } = failingOn(/^ROLLBACK TO/, dbUnavailable('the socket closed'));
    const body = new RangeError('the nested body failed');
    const fired: string[] = [];
    let inner: unknown;

    const error = await caught(
      withTransaction(
        async (tx) => {
          tx.onCommit(() => fired.push('commit'));
          tx.onRollback(() => fired.push('rollback'));
          inner = await withTransaction(async () => {
            throw body;
          }).catch((reason: unknown) => reason);
        },
        { client },
      ),
    );

    // The caller of the nested scope still reads the failure that caused the rollback.
    expect(inner).toBe(body);
    expect(error?.code).toBe('X_DB_TRANSACTION_ABORTED');
    expect(error?.cause).toContain('the socket closed');
    expect(texts).toEqual([
      'BEGIN',
      'SAVEPOINT x_sp_1',
      'ROLLBACK TO SAVEPOINT x_sp_1',
      'ROLLBACK',
    ]);
    expect(fired).toEqual(['rollback']);
  });

  test('a ROLLBACK TO that succeeds clears the abort, so the root commits', async () => {
    const { client, texts } = failingOn(/^insert/, serverError('23505', 'duplicate key'));
    await withTransaction(
      async () => {
        await withTransaction(async (nested) => {
          await nested.execute(sql`insert into posts default values`);
        }).catch(() => undefined);
      },
      { client },
    );
    expect(texts.at(-1)).toBe('COMMIT');
  });
});

describe('a failure that is not the server refusing a statement', () => {
  test('leaves the transaction committable: nothing was aborted', async () => {
    // No SQLSTATE: the statement never reached a server that could abort anything.
    const { client, texts } = failingOn(/^insert/, new RangeError('refused before the send'));
    await withTransaction(
      async (tx) => {
        await tx.execute(sql`insert into posts default values`).catch(() => undefined);
      },
      { client },
    );
    expect(texts.at(-1)).toBe('COMMIT');
  });
});

describe('a COMMIT that rejects', () => {
  test('with no SQLSTATE the outcome is unknown: neither list runs, the pin comes back', async () => {
    const boom = dbUnavailable('statement failed: COMMIT');
    const { client: reservable, pins } = reservableOver(failingOn(/^COMMIT$/, boom).client);
    const fired: string[] = [];
    let late: ((effect: () => void) => void) | undefined;

    const error = await caught(
      withTransaction(
        async (tx) => {
          tx.onRollback(() => fired.push('undo'));
          tx.onCommit(() => fired.push('commit'));
          late = (effect) => tx.onCommit(effect);
        },
        { client: reservable },
      ),
    );

    expect(error?.code).toBe('X_DB_COMMIT_UNKNOWN');
    expect(error?.sourceError).toBe(boom);
    late?.(() => fired.push('straggler'));
    expect(fired).toEqual([]);
    expect(pins).toEqual({ reserves: 1, releases: 1 });
  });

  test('with a SQLSTATE the server refused it: rolled back, undos run, the refusal surfaces', async () => {
    const refused = serverError('23503', 'a deferred foreign key failed at commit');
    const { client } = failingOn(/^COMMIT$/, refused);
    const fired: string[] = [];

    const error = await caught(
      withTransaction(
        async (tx) => {
          tx.onRollback(() => fired.push('undo'));
          tx.onCommit(() => fired.push('commit'));
        },
        { client },
      ),
    );

    expect(error).toBe(refused as Caught);
    expect(fired).toEqual(['undo']);
  });

  test('is never retried as a lost race, whatever the budget', async () => {
    const { client } = failingOn(/^COMMIT$/, dbUnavailable('statement failed: COMMIT'));
    let attempts = 0;
    const error = await caught(
      withTransaction(
        async () => {
          attempts += 1;
        },
        { client, retry: 3, sleep: async () => undefined },
      ),
    );
    expect(error?.code).toBe('X_DB_COMMIT_UNKNOWN');
    expect(attempts).toBe(1);
  });
});

describe('what a nested scope may ask for', () => {
  const nestedWith = async (
    options: Parameters<typeof withTransaction>[1],
  ): Promise<{ error: Caught | undefined; texts: readonly string[] }> => {
    const outer = recordingClient();
    const error = await caught(
      withTransaction(() => withTransaction(async () => undefined, options), { client: outer }),
    );
    return { error, texts: outer.texts };
  };

  test.each([
    ['isolation', { isolation: 'serializable' }],
    ['readOnly', { readOnly: true }],
    ['deferrable', { deferrable: true }],
    ['another client', { client: recordingClient() }],
  ] as const)('%s is refused: a SAVEPOINT cannot honour it', async (_name, options) => {
    const { error, texts } = await nestedWith(options);
    expect(error?.code).toBe('X_INVARIANT');
    // Refused before the savepoint, so the outer scope sent nothing on its behalf.
    expect(texts).toEqual(['BEGIN', 'ROLLBACK']);
  });

  test('the client the root was opened on is not a second database, and is accepted', async () => {
    const outer = recordingClient();
    await withTransaction(() => withTransaction(async () => undefined, { client: outer }), {
      client: outer,
    });
    expect(outer.texts).toEqual([
      'BEGIN',
      'SAVEPOINT x_sp_1',
      'RELEASE SAVEPOINT x_sp_1',
      'COMMIT',
    ]);
  });
});
