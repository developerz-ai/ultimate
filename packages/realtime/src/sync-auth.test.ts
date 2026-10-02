// The half a socket's authority was missing: a grant that expires, and a pass that acts on it.
// Failure case first — an expired grant nobody can renew must end the socket, because "authorized
// once, forever" is what an open websocket meant before this existed.

import { describe, expect, test } from 'bun:test';
import { type Actor, frozenClock, userActor } from '@ultimat3/core';
import { GrantBook, type SyncGrant, sweepGrants } from './sync-auth';
import type { Scheduler } from './thundering-herd';

const alice: Actor = userActor({ id: 'alice', orgId: 'o1' });
const aliceDemoted: Actor = userActor({ id: 'alice', orgId: 'o1', roles: [] });

interface Recorder {
  readonly reauthorized: string[];
  readonly revoked: string[];
  readonly failed: string[];
  readonly actors: (Actor | null)[];
}

function recorder(): Recorder {
  return { reauthorized: [], revoked: [], failed: [], actors: [] };
}

function deps(book: GrantBook, at: number, log: Recorder) {
  return {
    grants: book,
    clock: frozenClock(at),
    onActor: async (socketId: string, actor: Actor): Promise<void> => {
      log.reauthorized.push(socketId);
      log.actors.push(actor);
    },
    onRevoked: (socketId: string): void => {
      log.revoked.push(socketId);
    },
    onRefreshFailed: (socketId: string): void => {
      log.failed.push(socketId);
    },
  };
}

describe('grant expiry', () => {
  test('an expired grant with no way to renew it revokes the socket', async () => {
    const book = new GrantBook();
    book.set('s1', { actor: alice, expiresAt: 1_000 });
    const log = recorder();

    const result = await sweepGrants(deps(book, 1_001, log));

    expect(result).toEqual({ refreshed: 0, revoked: 1, failed: 0 });
    expect(log.revoked).toEqual(['s1']);
    // The book forgets it too: a revoked socket must not be swept again forever.
    expect(book.size).toBe(0);
  });

  test('a grant that refresh() answers null for is revoked, not silently kept', async () => {
    const book = new GrantBook();
    book.set('s1', { actor: alice, expiresAt: 1_000, refresh: async () => null });
    const log = recorder();

    await sweepGrants(deps(book, 5_000, log));

    expect(log.revoked).toEqual(['s1']);
    expect(log.reauthorized).toEqual([]);
  });

  test('a renewed grant hands the new actor over and replaces what the book holds', async () => {
    const book = new GrantBook();
    const renewed: SyncGrant = { actor: aliceDemoted, expiresAt: 9_000 };
    book.set('s1', { actor: alice, expiresAt: 1_000, refresh: async () => renewed });
    const log = recorder();

    const result = await sweepGrants(deps(book, 1_001, log));

    expect(result.refreshed).toBe(1);
    expect(log.reauthorized).toEqual(['s1']);
    expect(log.actors[0]).toBe(aliceDemoted);
    expect(book.get('s1')).toBe(renewed);
  });

  /**
   * The package's central rule, one level up: a denial and a failure never share an answer. Signing
   * every connected user out because the token service timed out is a bigger outage than the one it
   * would be responding to.
   */
  test('a refresh that raises keeps the socket, is reported, and is retried next pass', async () => {
    const book = new GrantBook();
    let attempts = 0;
    book.set('s1', {
      actor: alice,
      expiresAt: 1_000,
      refresh: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('token service unreachable');
        return { actor: alice, expiresAt: 9_000 };
      },
    });
    const log = recorder();

    const first = await sweepGrants(deps(book, 1_001, log));
    expect(first).toEqual({ refreshed: 0, revoked: 0, failed: 1 });
    expect(log.revoked).toEqual([]);
    expect(log.failed).toEqual(['s1']);
    expect(book.size).toBe(1);

    const second = await sweepGrants(deps(book, 1_002, log));
    expect(second.refreshed).toBe(1);
  });

  test('a grant with no expiry is never re-decided on a clock', async () => {
    const book = new GrantBook();
    book.set('s1', { actor: alice });
    const log = recorder();

    const result = await sweepGrants(deps(book, Number.MAX_SAFE_INTEGER, log));

    expect(result).toEqual({ refreshed: 0, revoked: 0, failed: 0 });
    expect(book.get('s1')?.actor).toBe(alice);
  });

  test('a grant still inside its window is left alone', async () => {
    const book = new GrantBook();
    book.set('s1', { actor: alice, expiresAt: 10_000, refresh: async () => null });
    const log = recorder();

    await sweepGrants(deps(book, 9_999, log));

    expect(log.revoked).toEqual([]);
    expect(book.size).toBe(1);
  });
});

describe('a socket that closes while its grant is being refreshed', () => {
  test('is not written back into the book, and nothing is re-decided for it', async () => {
    const book = new GrantBook();
    let release!: (grant: SyncGrant) => void;
    const refreshing = new Promise<SyncGrant>((settle) => {
      release = settle;
    });
    book.set('s1', { actor: alice, expiresAt: 1_000, refresh: () => refreshing });
    const log = recorder();

    const pass = sweepGrants(deps(book, 5_000, log));
    // The close callback runs while the token service is answering.
    book.delete('s1');
    release({ actor: aliceDemoted, expiresAt: 9_000 });
    const result = await pass;

    expect(book.size).toBe(0);
    expect(log.reauthorized).toEqual([]);
    expect(result).toEqual({ refreshed: 0, revoked: 0, failed: 0 });
  });

  test('a refresh answering null for a socket already gone revokes nothing twice', async () => {
    const book = new GrantBook();
    let release!: (grant: SyncGrant | null) => void;
    const refreshing = new Promise<SyncGrant | null>((settle) => {
      release = settle;
    });
    book.set('s1', { actor: alice, expiresAt: 1_000, refresh: () => refreshing });
    const log = recorder();

    const pass = sweepGrants(deps(book, 5_000, log));
    book.delete('s1');
    release(null);
    await pass;

    expect(log.revoked).toEqual([]);
  });
});

// The pass is serial and memoised by the node, so one token-service call that never settles used
// to park it for good: no grant behind it was renewed or revoked on that node again.
describe('a refresh that never answers', () => {
  /** Timers fired by hand: a deadline proved by sleeping is a deadline no test proves. */
  const timers = (): { schedule: Scheduler; fire: () => void; armed: () => number } => {
    let armed: { fn: () => void; live: boolean }[] = [];
    return {
      schedule: (fn) => {
        const entry = { fn, live: true };
        armed.push(entry);
        return () => {
          entry.live = false;
        };
      },
      fire: () => {
        const due = armed.filter((entry) => entry.live);
        armed = [];
        for (const entry of due) entry.fn();
      },
      armed: () => armed.filter((entry) => entry.live).length,
    };
  };

  test('is timed out, reported, kept expired — and the grants behind it are still decided', async () => {
    const book = new GrantBook();
    book.set('stuck', { actor: alice, expiresAt: 1_000, refresh: () => new Promise(() => {}) });
    book.set('gone', { actor: alice, expiresAt: 1_000, refresh: async () => null });
    const log = recorder();
    const failures: unknown[] = [];
    const clock = timers();

    const pass = sweepGrants({
      ...deps(book, 5_000, log),
      onRefreshFailed: (_socketId, error) => failures.push(error),
      schedule: clock.schedule,
    });
    await Promise.resolve();
    clock.fire();
    // The second grant's own deadline is armed and never needed.
    const result = await pass;

    expect(result).toEqual({ refreshed: 0, revoked: 1, failed: 1 });
    expect(log.revoked).toEqual(['gone']);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeUltimateError('X_TIMEOUT');
    // Still in the book and still expired, so the next pass asks again.
    expect(book.expired(5_000).map(([socketId]) => socketId)).toEqual(['stuck']);
    expect(clock.armed()).toBe(0);
  });

  test('a refresh that answers disarms its deadline', async () => {
    const book = new GrantBook();
    book.set('s1', {
      actor: alice,
      expiresAt: 1_000,
      refresh: async () => ({ actor: aliceDemoted, expiresAt: 9_000 }),
    });
    const clock = timers();

    await sweepGrants({ ...deps(book, 5_000, recorder()), schedule: clock.schedule });
    await Promise.resolve();

    expect(clock.armed()).toBe(0);
  });
});
