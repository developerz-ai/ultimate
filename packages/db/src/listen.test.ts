// Single responsibility: the LISTEN seam against fakes — what each client refuses before a driver
// sees the channel, how a driver failure is typed, and that one subscription ends exactly once.
// The real round trips are `pglite-embedded.test.ts` (embedded) and `listen.live.test.ts` (server).

import { afterEach, describe, expect, test } from 'bun:test';
import { createPostgresClient } from './client';
import { DbError } from './errors';
import { fakeDriver } from './fake-pglite-fixture';
import { assertListenChannel, canListen } from './listen';
import { createPgliteClient } from './pglite';

const host = globalThis as unknown as { Bun: { SQL: unknown } };
const realBunSql = host.Bun.SQL;

afterEach(() => {
  host.Bun.SQL = realBunSql;
});

interface FakeListener {
  readonly channels: string[];
  unlistens: number;
  notify(payload: string): void;
  relisten(): void;
}

/** A `Bun.SQL` whose `listen` hands the callbacks back, so a test plays the server. */
function installListeningSql(failure?: Error): FakeListener {
  let onnotify: (payload: string) => void = () => undefined;
  let onlisten: (() => void) | undefined;
  const fake: FakeListener = {
    channels: [],
    unlistens: 0,
    notify: (payload) => onnotify(payload),
    relisten: () => onlisten?.(),
  };
  host.Bun.SQL = class {
    async listen(
      channel: string,
      notify: (payload: string) => void,
      listening?: () => void,
    ): Promise<{ unlisten(): Promise<void> }> {
      if (failure !== undefined) throw failure;
      fake.channels.push(channel);
      onnotify = notify;
      onlisten = listening;
      listening?.();
      return {
        unlisten: async () => {
          fake.unlistens += 1;
        },
      };
    }
  };
  return fake;
}

const caught = async (work: Promise<unknown>): Promise<DbError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof DbError) return error;
  }
  return expect.unreachable('expected a DbError');
};

describe('unit · the LISTEN seam', () => {
  test('a channel that is not a plain identifier is refused before any driver sees it', async () => {
    const fake = installListeningSql();
    const client = createPostgresClient({ url: 'postgres://app@127.0.0.1:5432/t' });
    for (const channel of ['', 'X_Jobs', 'x-jobs', 'x jobs', '"x"; drop table x', 'a'.repeat(64)]) {
      const error = await caught(client.listen(channel, () => undefined));
      // The caller's argument, spliced unquoted into `LISTEN`: never "the database is down".
      expect(error.code).toBe('X_SQL_UNSAFE');
      expect(error.fix).toContain('client.listen(');
    }
    expect(fake.channels).toEqual([]);
    expect(() => assertListenChannel('x_jobs_wake')).not.toThrow();
    expect(() => assertListenChannel('a'.repeat(63))).not.toThrow();
  });

  test('the pooled client hands the driver the channel and both callbacks, and unlistens once', async () => {
    const fake = installListeningSql();
    const client = createPostgresClient({ url: 'postgres://app@127.0.0.1:5432/t' });
    const got: string[] = [];
    let listening = 0;
    const subscription = await client.listen(
      'x_jobs_wake',
      (payload) => got.push(payload),
      () => {
        listening += 1;
      },
    );

    fake.notify('default');
    // A re-dialled session announces itself again: the caller's cue that it may have missed one.
    fake.relisten();
    expect(fake.channels).toEqual(['x_jobs_wake']);
    expect(got).toEqual(['default']);
    expect(listening).toBe(2);

    const first = subscription.unlisten();
    expect(subscription.unlisten()).toBe(first);
    await first;
    expect(fake.unlistens).toBe(1);
  });

  test('a driver failure is typed, and names the statement — never the bare driver error', async () => {
    installListeningSql(new Error('connect ECONNREFUSED'));
    const client = createPostgresClient({ url: 'postgres://app@127.0.0.1:5432/t' });
    const error = await caught(client.listen('x_jobs_wake', () => undefined));
    expect(error.code).toBe('X_DB_UNAVAILABLE');
    expect(error.cause).toContain('LISTEN x_jobs_wake');
  });

  test('a driver with no listen() is a typed refusal on both clients', async () => {
    host.Bun.SQL = class {};
    const pooled = await caught(
      createPostgresClient({ url: 'postgres://app@127.0.0.1:5432/t' }).listen(
        'x_a',
        () => undefined,
      ),
    );
    expect(pooled.cause).toContain('no listen()');
    expect(pooled.fix).toContain('bun upgrade');

    const embedded = await caught(
      createPgliteClient({ driver: fakeDriver({ rows: [] }) }).listen('x_a', () => undefined),
    );
    expect(embedded.cause).toContain('no listen()');
  });

  test('the embedded client reports the subscription established, and ends it once', async () => {
    let stops = 0;
    const channels: string[] = [];
    let deliver: (payload: string) => void = () => undefined;
    const client = createPgliteClient({
      driver: {
        ...fakeDriver({ rows: [] }),
        async listen(channel, callback) {
          channels.push(channel);
          deliver = callback;
          return async () => {
            stops += 1;
          };
        },
      },
    });
    const got: string[] = [];
    let listening = 0;
    const subscription = await client.listen(
      'x_outbox_wake',
      (payload) => got.push(payload),
      () => {
        listening += 1;
      },
    );
    deliver('');
    expect(channels).toEqual(['x_outbox_wake']);
    expect(got).toEqual(['']);
    expect(listening).toBe(1);
    await Promise.all([subscription.unlisten(), subscription.unlisten()]);
    expect(stops).toBe(1);
  });

  test('canListen separates a client that holds a session from one that cannot', () => {
    expect(canListen(createPgliteClient({ driver: fakeDriver({ rows: [] }) }))).toBe(true);
    expect(canListen({ query: () => Promise.resolve([]) })).toBe(false);
  });
});
