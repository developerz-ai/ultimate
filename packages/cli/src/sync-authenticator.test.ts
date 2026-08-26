// Realtime was single-tenant by wiring: `sync-node.ts` was handed no `authenticate` by any host,
// so every socket carried `actorId: null` and the channel guard, the live-query gate, the presence
// entry and the tenant cap all decided against an anonymous actor. The failure case is first.

import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock, userActor } from '@ultimat3/core';
import { dbUnavailable } from '@ultimat3/db';
import { configureAuthenticator, resetAuthenticator } from '@ultimat3/http';
import type { SyncGrant } from '@ultimat3/realtime/server';
import { GrantBook, sweepGrants } from '@ultimat3/realtime/server';
import { SYNC_GRANT_TTL_MS, syncAuthenticator } from './sync-authenticator';

/** A fixed instant, so an expiry is a number this file can name rather than a range. */
const NOW = 1_760_000_000_000;

afterEach(resetAuthenticator);

const upgrade = (headers: HeadersInit = {}): Request =>
  new Request('http://sync.test/sync', {
    headers: { upgrade: 'websocket', connection: 'Upgrade', ...headers },
  });

describe('the sync node reads the app’s own authenticator', () => {
  test('no authenticator is UNDEFINED, never an anonymous stub', () => {
    // `createSyncNode` logs that it is anonymous when `authenticate` is absent. A stub answering
    // `{ actor: anonymous }` would look configured and silence that line — which is the state the
    // whole framework was in.
    expect(syncAuthenticator('test')).toBeUndefined();
  });

  test('an upgrade request is the request the app’s resolver reads', async () => {
    configureAuthenticator((request) =>
      request.header('cookie') === 'sid=abc' ? userActor({ id: 'u1', roles: ['member'] }) : null,
    );
    const authenticate = syncAuthenticator('test');
    expect(authenticate).toBeDefined();

    const grant = await authenticate?.(upgrade({ cookie: 'sid=abc' }));
    expect(grant?.actor.id).toBe('u1');
  });

  test('null from the app is a decision, and it is passed through as one', async () => {
    configureAuthenticator(() => null);
    const grant = await syncAuthenticator('test')?.(upgrade());
    // `null` means nobody may open this socket; a throw would mean nothing was decided. The node
    // answers those differently, so the adapter must not turn one into the other.
    expect(grant).toBeNull();
  });

  test('the grant expires, so the sweep that closes a revoked socket has something to find', async () => {
    configureAuthenticator(() => userActor({ id: 'u1', roles: ['member'] }));
    const clock = frozenClock(NOW);
    const grant = await syncAuthenticator('test', { clock })?.(upgrade());
    // A grant with no `expiresAt` never appears in `GrantBook.expired()`, so `sweepGrants` — the
    // ONLY path to `hub.onActorChange` and `registry.reauthorize` — never fires for it. `logout`
    // then closes the HTTP session and never the open socket.
    expect(grant?.expiresAt).toBe(NOW + SYNC_GRANT_TTL_MS);
    expect(grant?.refresh).toBeDefined();
  });

  test('logout closes the socket: an expired grant whose credential is gone is REVOKED', async () => {
    const sessions = new Set(['sid=abc']);
    configureAuthenticator((request) =>
      sessions.has(request.header('cookie') ?? '') ? userActor({ id: 'u1' }) : null,
    );
    const clock = frozenClock(NOW);
    const grant = await syncAuthenticator('test', { clock })?.(upgrade({ cookie: 'sid=abc' }));
    const book = new GrantBook();
    book.set('socket-1', grant as SyncGrant);

    // What `revokeSession` does. The socket is still open and the 15s heartbeat keeps it that way.
    sessions.delete('sid=abc');

    const swept = await sweepGrants({
      grants: book,
      clock: frozenClock(NOW + SYNC_GRANT_TTL_MS),
      onActor: async () => undefined,
      onRevoked: () => undefined,
    });
    // Observed before the fix, one YEAR later rather than one TTL: `{ refreshed: 0, revoked: 0 }`.
    expect(swept).toEqual({ refreshed: 0, revoked: 1, failed: 0 });
    expect(book.size).toBe(0);
  });

  test('a live credential is REFRESHED, not revoked — and the window moves forward', async () => {
    configureAuthenticator(() => userActor({ id: 'u1', roles: ['member'] }));
    const clock = frozenClock(NOW);
    const grant = await syncAuthenticator('test', { clock })?.(upgrade({ cookie: 'sid=abc' }));
    const book = new GrantBook();
    book.set('socket-1', grant as SyncGrant);

    // The adapter's clock is at the sweep instant when the resolver answers — frozen at NOW for
    // the whole test, the refreshed grant reports `NOW + TTL`, which is what it already carried,
    // so an implementation returning `expiresAt` UNCHANGED passed the assertion below.
    clock.advance(SYNC_GRANT_TTL_MS);
    const swept = await sweepGrants({
      grants: book,
      clock: frozenClock(NOW + SYNC_GRANT_TTL_MS),
      onActor: async () => undefined,
      onRevoked: () => expect.unreachable('a live session must not be revoked'),
    });
    expect(swept.refreshed).toBe(1);
    // The clock the ADAPTER holds, not the sweep's: the renewed grant is re-decided one TTL after
    // the resolver answered. A refresh that returned the same instant would expire on every pass.
    expect(book.get('socket-1')?.expiresAt).toBe(NOW + 2 * SYNC_GRANT_TTL_MS);
  });

  test('the refresh re-reads the upgrade’s own cookie, never a header it never saw', async () => {
    const seen: (string | undefined)[] = [];
    configureAuthenticator((request) => {
      seen.push(request.header('cookie') ?? undefined);
      return userActor({ id: 'u1' });
    });
    const grant = await syncAuthenticator('test')?.(upgrade({ cookie: 'sid=abc' }));
    await grant?.refresh?.();
    expect(seen).toEqual(['sid=abc', 'sid=abc']);
  });

  test('a refresh that RAISES is a failure, not a denial — the grant is kept and retried', async () => {
    let fail = false;
    // What an app's resolver really raises when the pool behind it is gone: the session lookup's
    // own coded failure, handed to the code under test as INPUT. Never a bare `Error` — this test
    // states its verdicts through `expect`, and a foreign error is not one of them.
    const backendDown = dbUnavailable('the session store did not answer');
    configureAuthenticator(() => {
      if (fail) throw backendDown;
      return userActor({ id: 'u1' });
    });
    const grant = await syncAuthenticator('test', { clock: frozenClock(NOW) })?.(upgrade());
    const book = new GrantBook();
    book.set('socket-1', grant as SyncGrant);
    fail = true;

    const swept = await sweepGrants({
      grants: book,
      clock: frozenClock(NOW + SYNC_GRANT_TTL_MS),
      onActor: async () => undefined,
      onRevoked: () => expect.unreachable('a backend timeout is not a revocation'),
    });
    // Signing every connected user out because the auth backend timed out is a bigger outage than
    // the one it would be responding to. `sweepGrants` owns that rule; the adapter must not
    // convert the throw into a `null` on the way past it.
    expect(swept).toEqual({ refreshed: 0, revoked: 0, failed: 1 });
    expect(book.size).toBe(1);
  });

  test('a throwing resolver is a failure, not a denial — it propagates', async () => {
    // The session lookup's own coded failure, exactly as the refresh case below models it — this
    // is the subject's INPUT, never this test stating a verdict, so it is not a bare `Error`.
    configureAuthenticator(() => {
      throw dbUnavailable('the session store did not answer');
    });
    // Reading a backend timeout as "denied" is the same class of bug as reading a dead pool as a
    // row policy refusing a row. The node catches and reports it; the adapter must not swallow it.
    await expect(syncAuthenticator('test')?.(upgrade())).rejects.toThrow('X_DB_UNAVAILABLE');
  });

  test('the resolver is read at start, not at module load', () => {
    // A watch-mode restart configures the app's resolver again, after this module first evaluated.
    expect(syncAuthenticator('test')).toBeUndefined();
    configureAuthenticator(() => userActor({ id: 'u1' }));
    expect(syncAuthenticator('test')).toBeDefined();
  });
});

/**
 * The grant's window, when it is not a number — the sharpest failure in this file, because it is a
 * credential lifetime and the guard it feeds is an EXPIRY check.
 *
 * `??` guards nullish and `NaN` is not, so a `ttlMs` computed from a deployment value reaches
 * `clock.now().getTime() + ttlMs`, which is `NaN`. `GrantBook.expired()` asks
 * `grant.expiresAt <= now`, and that is FALSE for every `now` — so the grant never appears in the
 * sweep, `sweepGrants` never calls `refresh`, and `logout` / `revokeSession` / `disableUser` /
 * `updatePrivileges` close the HTTP session and never the websocket. Measured before the screen
 * landed, with the session deleted and the clock advanced one YEAR:
 * `{ refreshed: 0, revoked: 0, failed: 0 }` and the book still holding the socket — the exact hole
 * `expiresAt` was added to close, reopened by a number nobody checked.
 */
describe('a grant window that is not a number is not a window', () => {
  const NOT_A_BOUND = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

  test('a non-finite ttlMs is refused when the node is wired, not when a socket is swept', () => {
    configureAuthenticator(() => userActor({ id: 'u1' }));
    for (const ttlMs of NOT_A_BOUND) {
      expect(() => syncAuthenticator('test', { ttlMs })).toThrow('X_INVARIANT');
    }
  });

  test('a ttlMs of 0 is refused — a grant expired at the instant it is minted is not one', () => {
    configureAuthenticator(() => userActor({ id: 'u1' }));
    expect(() => syncAuthenticator('test', { ttlMs: 0 })).toThrow('X_INVARIANT');
    expect(syncAuthenticator('test', { ttlMs: 1 })).toBeDefined();
  });

  test('the window the deployment declared is still the one the grant carries', async () => {
    configureAuthenticator(() => userActor({ id: 'u1' }));
    const clock = frozenClock(NOW);
    const grant = await syncAuthenticator('test', { clock, ttlMs: 30_000 })?.(upgrade());
    expect(grant?.expiresAt).toBe(NOW + 30_000);
  });

  // The refusal must land before an authenticator exists, not on the first upgrade: a node that
  // accepted the wiring and refused every socket is an outage, and one that accepted both is the
  // hole above.
  test('an unwired app is still UNDEFINED, and the bound is judged only where there is one', () => {
    resetAuthenticator();
    expect(syncAuthenticator('test', { ttlMs: Number.NaN })).toBeUndefined();
  });
});
