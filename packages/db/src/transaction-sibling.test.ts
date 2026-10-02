// Single responsibility: a nested scope that waits for a sibling which can never finish. Sibling
// scopes take turns (savepoints are a stack), so a body that awaits a sibling queued BEHIND it is
// a cycle — and with no deadline on the turn it was a silent, permanent hang.

import { describe, expect, test } from 'bun:test';
import { createRecordingClient } from './fake';
import { withTransaction } from './transaction';

interface Caught {
  readonly code?: string | undefined;
  readonly cause?: string | undefined;
  readonly fix?: string | undefined;
}

const HUNG = Symbol('hung');
/** Settles `HUNG` when `work` has not settled in `ms` — the test's own verdict on a hang. */
const within = <T>(work: Promise<T>, ms: number): Promise<T | typeof HUNG> =>
  Promise.race([work, Bun.sleep(ms).then((): typeof HUNG => HUNG)]);

describe('sibling nested scopes', () => {
  test('a body awaiting a sibling queued behind it is refused by name, never a hang', async () => {
    const client = createRecordingClient();
    let waiter: Caught | undefined;

    const outcome = await within(
      withTransaction(
        async () => {
          let second: Promise<void> = Promise.resolve();
          const first = withTransaction(async () => {
            // Queued behind this very scope: it cannot start until this body returns.
            await second;
          });
          second = withTransaction(async () => undefined, { siblingWaitMs: 20 });
          second.catch((error: unknown) => {
            waiter = error as Caught;
          });
          await first;
        },
        { client },
      ).then(
        () => undefined,
        (error: unknown) => error as Caught,
      ),
      2_000,
    );

    expect(outcome).not.toBe(HUNG);
    expect(waiter?.code).toBe('X_DB_SIBLING_SCOPE_TIMEOUT');
    // Both scopes named: the one that waited, and the one it waited for.
    expect(waiter?.cause).toContain('x_sp_1');
    expect(waiter?.cause).toContain('20ms');
    expect(waiter?.fix).toContain('await');
    // The waiter never opened: no second savepoint was sent, and the cycle unwound through the
    // first scope's own rollback.
    expect(client.texts).toEqual([
      'BEGIN',
      'SAVEPOINT x_sp_1',
      'ROLLBACK TO SAVEPOINT x_sp_1',
      'ROLLBACK',
    ]);
  });

  test('a sibling that simply takes a while is waited for, inside the deadline', async () => {
    const client = createRecordingClient();
    await withTransaction(
      () =>
        Promise.all([
          withTransaction(() => Bun.sleep(30)),
          withTransaction(async () => undefined, { siblingWaitMs: 1_000 }),
        ]),
      { client },
    );
    expect(client.texts).toEqual([
      'BEGIN',
      'SAVEPOINT x_sp_1',
      'RELEASE SAVEPOINT x_sp_1',
      'SAVEPOINT x_sp_2',
      'RELEASE SAVEPOINT x_sp_2',
      'COMMIT',
    ]);
  });

  test('an abandoned wait gives its place back: the next sibling still gets a turn', async () => {
    const client = createRecordingClient();
    await withTransaction(
      async () => {
        const slow = withTransaction(() => Bun.sleep(60));
        const gaveUp = await withTransaction(async () => undefined, { siblingWaitMs: 10 }).catch(
          (error: unknown) => error as Caught,
        );
        expect(gaveUp?.code).toBe('X_DB_SIBLING_SCOPE_TIMEOUT');
        await slow;
        await withTransaction(async () => undefined);
      },
      { client },
    );
    expect(client.texts.at(-1)).toBe('COMMIT');
    expect(client.texts.filter((text) => text.startsWith('SAVEPOINT'))).toHaveLength(2);
  });

  test('siblingWaitMs: 0 waits without a deadline; a value that is not a count is refused', async () => {
    const client = createRecordingClient();
    await withTransaction(
      () =>
        Promise.all([
          withTransaction(() => Bun.sleep(20)),
          withTransaction(async () => undefined, { siblingWaitMs: 0 }),
        ]),
      { client },
    );
    const refused = await withTransaction(async () => undefined, {
      client,
      siblingWaitMs: Number.NaN,
    }).catch((error: unknown) => error as Caught);
    expect((refused as Caught | undefined)?.code).toBe('X_INVARIANT');
  });
});
