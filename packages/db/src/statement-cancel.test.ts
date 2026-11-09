// Single responsibility: which statements an aborted scope cancels on the pool — a pooled read in
// flight, and nothing else — and what the caller is thrown when it does. Against a fake `Bun.SQL`
// whose query cancels like the real one (`57014`); the server's half is `statement-cancel.live`.

import { afterEach, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, UltimateError } from '@ultimat3/core';
import { type PostgresClient, postgresClient } from './client';
import { sql } from './sql';

const host = globalThis as unknown as { Bun: { SQL: unknown } };
const realBunSql = host.Bun.SQL;

afterEach(() => {
  host.Bun.SQL = realBunSql;
});

/** `57014` as the server sends it: `cancel()` on a query still running rejects it with this. */
const queryCanceled = (): unknown =>
  Object.assign(new Error('canceling statement due to user request'), {
    errno: '57014',
    code: 'ERR_POSTGRES_SERVER_ERROR',
    severity: 'ERROR',
  });

interface Sent {
  readonly text: string;
  cancels: number;
  answer(rows: unknown): void;
}

/** Every query stays pending until answered by hand, and cancels the way `Bun.SQL`'s does. */
function installHeldSql(): Sent[] {
  const sent: Sent[] = [];
  const send = (text: string): Promise<unknown> => {
    let answer: (rows: unknown) => void = () => undefined;
    let fail: (error: unknown) => void = () => undefined;
    const pending = new Promise<unknown>((resolve, reject) => {
      answer = resolve;
      fail = reject;
    });
    const entry: Sent = { text, cancels: 0, answer: (rows) => answer(rows) };
    sent.push(entry);
    return Object.assign(pending, {
      cancel: (): void => {
        entry.cancels += 1;
        fail(queryCanceled());
      },
    });
  };
  host.Bun.SQL = class {
    unsafe(text: string): Promise<unknown> {
      return send(text);
    }
    async reserve(): Promise<unknown> {
      return { unsafe: (text: string) => send(text), release: (): void => undefined };
    }
    async close(): Promise<void> {}
  };
  return sent;
}

const client = (): PostgresClient =>
  postgresClient({ url: 'postgres://app@127.0.0.1:5432/x', role: 'web', env: {} });

/** Runs `fn` inside a context whose signal `controller` owns. */
const scoped = <T>(controller: AbortController, fn: () => T): T =>
  runWithContext(ctxOf({ signal: controller.signal }), fn);

const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};

const errorOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => expect.unreachable('the statement was answered'),
    (error: unknown) => error,
  );

describe('a pooled read is cancelled when its scope aborts', () => {
  test('a hang-up cancels it and the caller is thrown X_ABORTED, not a database outage', async () => {
    const sent = installHeldSql();
    const controller = new AbortController();
    const reading = scoped(controller, () => client().query(sql`select pg_sleep(${5})`));
    await settled();
    controller.abort();
    const error = await errorOf(reading);
    expect(sent[0]?.cancels).toBe(1);
    expect(error).toBeInstanceOf(UltimateError);
    expect((error as UltimateError).code).toBe('X_ABORTED');
  });

  test('a coded abort is thrown as its own reason, the same object', async () => {
    installHeldSql();
    const controller = new AbortController();
    const reason = new UltimateError({ code: 'X_TIMEOUT', cause: 'deadline', fix: 'x' });
    const reading = scoped(controller, () => client().query(sql`select 1`));
    await settled();
    controller.abort(reason);
    expect(await errorOf(reading)).toBe(reason);
  });
});

describe('what an abort never cancels', () => {
  test('a write: a click followed by a navigation must still land', async () => {
    const sent = installHeldSql();
    const controller = new AbortController();
    const writing = scoped(controller, () => client().execute(sql`insert into t values (${1})`));
    await settled();
    controller.abort();
    sent[0]?.answer(Object.assign([], { count: 1 }));
    expect(await writing).toBe(1);
    expect(sent[0]?.cancels).toBe(0);
  });

  test('a read on a pin: cancelling it would abort the transaction around it', async () => {
    const sent = installHeldSql();
    const controller = new AbortController();
    const pool = client();
    const pin = await pool.reserve();
    const reading = scoped(controller, () => pin.query(sql`select 1`));
    await settled();
    controller.abort();
    sent[0]?.answer([{ one: 1 }]);
    expect(await reading).toEqual([{ one: 1 }]);
    expect(sent[0]?.cancels).toBe(0);
    pin.release();
  });

  test('a read sent AFTER the abort: settling work sends past it on purpose', async () => {
    const sent = installHeldSql();
    const controller = new AbortController();
    controller.abort();
    const reading = scoped(controller, () => client().query(sql`select 1`));
    await settled();
    sent[0]?.answer([{ one: 1 }]);
    expect(await reading).toEqual([{ one: 1 }]);
    expect(sent[0]?.cancels).toBe(0);
  });

  test('a read already answered: the listener left with the statement', async () => {
    const sent = installHeldSql();
    const controller = new AbortController();
    const reading = scoped(controller, () => client().query(sql`select 1`));
    await settled();
    sent[0]?.answer([{ one: 1 }]);
    await reading;
    controller.abort();
    expect(sent[0]?.cancels).toBe(0);
  });

  test('a read answered, its caller not yet resumed: no cancel chases the connection', async () => {
    const sent = installHeldSql();
    const controller = new AbortController();
    const reading = scoped(controller, () => client().query(sql`select 1`));
    await settled();
    sent[0]?.answer([{ one: 1 }]);
    // One turn: the query has settled, the pool's own chain above it has not.
    await Promise.resolve();
    controller.abort();
    expect(await reading).toEqual([{ one: 1 }]);
    expect(sent[0]?.cancels).toBe(0);
  });

  test('a read outside any context', async () => {
    const sent = installHeldSql();
    const reading = client().query(sql`select 1`);
    await settled();
    sent[0]?.answer([]);
    expect(await reading).toEqual([]);
    expect(sent[0]?.cancels).toBe(0);
  });
});
