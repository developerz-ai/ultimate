// Single responsibility: the LISTEN seam against a real server — the claims `bun-sql.ts` states
// as measured. A notification sent from ANOTHER connection arrives; the listener costs the pool
// no slot; a backend killed under it is re-dialled and says so; `unlisten()` ends the session.
// Skips unless `TEST_DATABASE_URL` is set, like `client.live.test.ts`.

import { afterEach, describe, expect, test } from 'bun:test';
import { type PostgresClient, postgresClient } from './client';
import { sql } from './sql';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

/** Real sockets: the wait is for the wire, bounded so a lost notification fails rather than hangs. */
async function until(condition: () => boolean, budgetMs = 5_000): Promise<void> {
  const deadline = performance.now() + budgetMs;
  while (!condition()) {
    if (performance.now() > deadline) expect.unreachable('the condition never became true');
    await Bun.sleep(5);
  }
}

/** `until` for a condition only the server can answer: polled, on the same bounded budget. */
async function untilSettled<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  budgetMs = 5_000,
): Promise<T> {
  const deadline = performance.now() + budgetMs;
  let value = await read();
  while (!done(value) && performance.now() <= deadline) {
    await Bun.sleep(20);
    value = await read();
  }
  return value;
}

describe.skipIf(!hasPostgres)('live · postgres · LISTEN on a session of its own', () => {
  const clients: PostgresClient[] = [];
  const fresh = (applicationName: string, max = 2): PostgresClient => {
    const client = postgresClient({
      url: url ?? '',
      role: 'web',
      applicationName,
      profile: { max },
    });
    clients.push(client);
    return client;
  };

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  const sessions = (observer: PostgresClient, name: string): Promise<readonly { pid: number }[]> =>
    observer.query<{ pid: number }>(
      sql`select pid from pg_stat_activity
           where application_name = ${name} and query ilike 'listen%'`,
    );

  test('a notification committed on another connection arrives, and a rolled-back one does not', async () => {
    const listener = fresh('x-listen-a', 1);
    const sender = fresh('x-listen-a-sender', 1);
    const got: string[] = [];
    const subscription = await listener.listen('x_listen_live_a', (payload) => got.push(payload));

    // The pool has ONE slot and the listener is not in it: this statement would never return.
    expect(await listener.query(sql`select 1 as one`)).toEqual([{ one: 1 }]);

    const pinned = await sender.reserve();
    await pinned.execute(sql`begin`);
    await pinned.execute(sql`select pg_notify('x_listen_live_a', 'rolled-back')`);
    await pinned.execute(sql`rollback`);
    await pinned.execute(sql`begin`);
    await pinned.execute(sql`select pg_notify('x_listen_live_a', 'committed')`);
    // Not before the commit: a NOTIFY is part of its transaction.
    await Bun.sleep(50);
    expect(got).toEqual([]);
    await pinned.execute(sql`commit`);
    pinned.release();

    await until(() => got.length > 0);
    expect(got).toEqual(['committed']);
    await subscription.unlisten();
  });

  test('a killed listener session is re-dialled, announces itself again, and delivers again', async () => {
    const listener = fresh('x-listen-b');
    const observer = fresh('x-listen-b-observer', 1);
    const got: string[] = [];
    let listening = 0;
    const subscription = await listener.listen(
      'x_listen_live_b',
      (payload) => got.push(payload),
      () => {
        listening += 1;
      },
    );
    expect(listening).toBe(1);
    const [before] = await sessions(observer, 'x-listen-b');
    expect(before).toBeDefined();

    await observer.execute(sql`select pg_terminate_backend(${before?.pid ?? 0})`);
    await until(() => listening === 2);
    const [after] = await sessions(observer, 'x-listen-b');
    expect(after?.pid).not.toBe(before?.pid);

    await observer.execute(sql`select pg_notify('x_listen_live_b', 'after-the-kill')`);
    await until(() => got.length > 0);
    expect(got).toEqual(['after-the-kill']);

    await subscription.unlisten();
    // The backend can linger in `pg_stat_activity` after the UNLISTEN returns: poll the server.
    const left = await untilSettled(
      () => sessions(observer, 'x-listen-b'),
      (rows) => rows.length === 0,
    );
    expect(left).toEqual([]);
  });
});
