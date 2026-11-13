// Single responsibility: a nested scope that waits for a sibling which can never finish. Sibling
// scopes take turns (savepoints are a stack), so a body that awaits a sibling queued BEHIND it is
// a cycle — and with no deadline on the turn it was a silent, permanent hang. The deadline runs on
// Bun's fake timers and a slow sibling is a gate the test opens: no case waits on the wall clock.

import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { recordingClient } from './fake';
import { withTransaction } from './transaction';

interface Caught {
  readonly code?: string | undefined;
  readonly cause?: string | undefined;
  readonly fix?: string | undefined;
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

/** `setImmediate` stays real under fake timers: one check runs after every pending microtask. */
const flush = (): Promise<void> => new Promise((done) => setImmediate(done));

/** Until the scope under test has armed its deadline — the event, not a guessed delay. */
async function armed(count = 1): Promise<void> {
  for (let check = 0; check < 1_000 && jest.getTimerCount() < count; check += 1) await flush();
  expect(jest.getTimerCount()).toBe(count);
}

function gate(): { readonly opened: Promise<void>; open(): void } {
  let open = (): void => undefined;
  const opened = new Promise<void>((done) => (open = done));
  return { opened, open };
}

describe('sibling nested scopes', () => {
  test('a body awaiting a sibling queued behind it is refused by name, never a hang', async () => {
    const client = recordingClient();
    let waiter: Caught | undefined;

    const outcome = withTransaction(
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
    );

    await armed();
    // The deadline, to the millisecond: not refused a tick early, refused on it.
    jest.advanceTimersByTime(19);
    await flush();
    expect(waiter).toBeUndefined();
    jest.advanceTimersByTime(1);
    await outcome;

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
    const client = recordingClient();
    const slow = gate();
    const done = withTransaction(
      () =>
        Promise.all([
          withTransaction(() => slow.opened),
          withTransaction(async () => undefined, { siblingWaitMs: 1_000 }),
        ]),
      { client },
    );
    await armed();
    // One millisecond inside the deadline, the slow sibling finishes and the waiter goes next.
    jest.advanceTimersByTime(999);
    slow.open();
    await done;
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
    const client = recordingClient();
    const slow = gate();
    let gaveUp: Caught | undefined;
    const done = withTransaction(
      async () => {
        const holder = withTransaction(() => slow.opened);
        gaveUp = await withTransaction(async () => undefined, { siblingWaitMs: 10 }).catch(
          (error: unknown) => error as Caught,
        );
        await holder;
        await withTransaction(async () => undefined);
      },
      { client },
    );
    await armed();
    jest.advanceTimersByTime(10);
    for (let check = 0; check < 1_000 && gaveUp === undefined; check += 1) await flush();
    expect(gaveUp?.code).toBe('X_DB_SIBLING_SCOPE_TIMEOUT');
    slow.open();
    await done;
    expect(client.texts.at(-1)).toBe('COMMIT');
    expect(client.texts.filter((text) => text.startsWith('SAVEPOINT'))).toHaveLength(2);
  });

  test('siblingWaitMs: 0 waits without a deadline; a value that is not a count is refused', async () => {
    const client = recordingClient();
    const slow = gate();
    let finished = false;
    const done = withTransaction(
      () =>
        Promise.all([
          withTransaction(() => slow.opened),
          withTransaction(async () => undefined, { siblingWaitMs: 0 }),
        ]),
      { client },
    ).then(() => {
      finished = true;
    });
    // An hour on the fake clock: a wait with any deadline would have been refused by now.
    for (let check = 0; check < 20; check += 1) await flush();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(3_600_000);
    await flush();
    expect(finished).toBe(false);
    slow.open();
    await done;
    expect(client.texts.at(-1)).toBe('COMMIT');
    const refused = await withTransaction(async () => undefined, {
      client,
      siblingWaitMs: Number.NaN,
    }).catch((error: unknown) => error as Caught);
    expect((refused as Caught | undefined)?.code).toBe('X_INVARIANT');
  });
});
