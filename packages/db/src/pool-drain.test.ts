// The bound on `close()`. `Bun.SQL`'s `end()` waits on an outstanding reserved connection and never
// gives up — measured three runs per case on Bun 1.3.14 AND 1.4.0, no database outage involved
// (#394) — so `releaseQueue` awaiting it meant a role whose database went away mid-shutdown never
// finished shutting down. `pool-drain.live.test.ts` is the other half and the one that proves the
// driver honours the option; this file asserts what the client ASKS FOR, which is where the unit
// bug would live.

import { afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { createPostgresClient } from './client';
import { type DbError, dbUnavailable } from './errors';
import { POOL_PROFILES } from './pool-profile';

interface CloseCall {
  readonly options: { readonly timeout?: number } | undefined;
}

const host = globalThis as unknown as { Bun?: { SQL?: unknown } };
const realSql = host.Bun?.SQL;
afterEach(() => {
  if (host.Bun !== undefined) host.Bun.SQL = realSql;
});

/** A pool that records what `close()` was asked for and takes `delayMs` to answer. */
const fakePool = (calls: CloseCall[], delayMs: number): void => {
  class Fake {
    close(options?: { readonly timeout?: number }): Promise<void> {
      calls.push({ options });
      return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    unsafe(): Promise<unknown> {
      return Promise.resolve([]);
    }
    reserve(): Promise<unknown> {
      return Promise.resolve({ release: () => undefined, unsafe: () => Promise.resolve([]) });
    }
  }
  if (host.Bun !== undefined) host.Bun.SQL = Fake;
};

const clientWith = (drainTimeoutMs: number) =>
  createPostgresClient({
    url: 'postgres://u:p@localhost:5432/db',
    role: 'web',
    profile: { ...POOL_PROFILES.web, drainTimeoutMs },
  });

/** The pool opens lazily, so a close with no statement before it would close nothing. */
const warm = async (client: ReturnType<typeof clientWith>): Promise<void> => {
  await client.ping().catch(() => undefined);
};

describe('unit · close() hands the driver its own drain budget', () => {
  test('the timeout is passed, and it is passed in SECONDS', async () => {
    const calls: CloseCall[] = [];
    fakePool(calls, 0);
    const client = clientWith(5_000);
    await warm(client);
    await client.close().catch(() => undefined);
    expect(calls).toHaveLength(1);
    // 5 seconds, never 5000. `Bun.SQL` reads this field as seconds, so the millisecond spelling is
    // an eighty-three minute shutdown budget — the same hang, with extra steps.
    expect(calls[0]?.options?.timeout).toBe(5);
  });

  test('drainTimeoutMs 0 asks for no bound at all, rather than asking for zero seconds', async () => {
    const calls: CloseCall[] = [];
    fakePool(calls, 0);
    const client = clientWith(0);
    await warm(client);
    await client.close();
    // `{ timeout: 0 }` would be a driver-side instruction, and an ambiguous one. `migrate` and
    // `replicator` mean "wait", which is the bare call.
    expect(calls[0]?.options).toBeUndefined();
  });

  test('a drain that used its whole budget is reported, not swallowed', async () => {
    const calls: CloseCall[] = [];
    // The driver RESOLVES when it gives up rather than rejecting, so elapsed time is the only
    // signal — a drain that silently gave up looks exactly like a clean one.
    fakePool(calls, 60);
    const client = clientWith(40);
    await warm(client);
    let thrown: unknown;
    try {
      await client.close();
    } catch (error) {
      thrown = error;
    }
    expect(isUltimateError(thrown)).toBe(true);
    const error = thrown as DbError;
    expect(error.code).toBe('X_DB_DRAIN_TIMEOUT');
    expect(error.cause).toContain('web');
    // Axiom 4: the fix has to be runnable. "raise the budget" alone leaves an operator with no way
    // to find the statement that would not finish, which is the question they actually have.
    expect(error.fix).toContain('drainTimeoutMs');
    expect(error.fix).toContain('pg_stat_activity');
  });

  test('a drain that finished inside its budget resolves quietly', async () => {
    const calls: CloseCall[] = [];
    fakePool(calls, 0);
    const client = clientWith(5_000);
    await warm(client);
    await expect(client.close()).resolves.toBeUndefined();
  });
});

describe('unit · release() is total, because a bounded drain abandons pinned connections', () => {
  test('a release against a pool that is already gone does not throw', async () => {
    // Measured on Bun 1.3.14 against a real server: `release()` on a closed pool throws
    // `ERR_POSTGRES_CONNECTION_CLOSED`; on 1.4.0 it is silent. `[Symbol.dispose]` IS this
    // function, so a throw here replaces whatever error reached the `using` block — and bounding
    // `close()` is precisely what leaves a pinned connection to be released against nothing.
    class Fake {
      close(): Promise<void> {
        return Promise.resolve();
      }
      unsafe(): Promise<unknown> {
        return Promise.resolve([]);
      }
      reserve(): Promise<unknown> {
        return Promise.resolve({
          release: () => {
            // `dbUnavailable()`, never a bare `Error` — the house rule for a test simulating a
            // DATABASE failure (`packages/db/CLAUDE.md`). What the real driver throws here is its
            // own `PostgresError`; what this asserts is that `release()` propagates NOTHING,
            // whatever shape it caught.
            throw dbUnavailable('Connection closed');
          },
          unsafe: () => Promise.resolve([]),
        });
      }
    }
    if (host.Bun !== undefined) host.Bun.SQL = Fake;
    const connection = await clientWith(5_000).reserve();
    expect(() => connection.release()).not.toThrow();
    // And the disposer is the same call, so `using` is covered by the same guard.
    expect(() => connection[Symbol.dispose]()).not.toThrow();
  });
});

describe('unit · every role declares a drain budget it can live with', () => {
  test('the request-serving roles are bounded — a hang there is a pod that will not drain', () => {
    for (const role of ['web', 'sync', 'worker', 'scheduler'] as const) {
      expect(POOL_PROFILES[role].drainTimeoutMs).toBeGreaterThan(0);
    }
  });

  test('and the run-once roles wait, because cutting off their own session is worse', () => {
    expect(POOL_PROFILES.migrate.drainTimeoutMs).toBe(0);
    expect(POOL_PROFILES.replicator.drainTimeoutMs).toBe(0);
  });
});
