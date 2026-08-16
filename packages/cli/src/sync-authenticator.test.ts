// Realtime was single-tenant by wiring: `sync-node.ts` was handed no `authenticate` by any host,
// so every socket carried `actorId: null` and the channel guard, the live-query gate, the presence
// entry and the tenant cap all decided against an anonymous actor. The failure case is first.

import { afterEach, describe, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import { configureAuthenticator, resetAuthenticator } from '@ultimat3/http';
import { syncAuthenticator } from './sync-authenticator';

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

  test('the grant carries no expiry — the adapter promises only what the app told it', async () => {
    configureAuthenticator(() => userActor({ id: 'u1', roles: ['member'] }));
    const grant = await syncAuthenticator('test')?.(upgrade());
    // `configureAuthenticator` resolves an Actor and says nothing about how long it stays true.
    // Inventing a window would close live sockets that are still authorized; claiming none when
    // the credential has one is what `runtime.syncAuthenticate` exists for.
    expect(grant?.expiresAt).toBeUndefined();
    expect(grant?.refresh).toBeUndefined();
  });

  test('a throwing resolver is a failure, not a denial — it propagates', async () => {
    configureAuthenticator(() => {
      throw new Error('auth backend timeout');
    });
    // Reading a backend timeout as "denied" is the same class of bug as reading a dead pool as a
    // row policy refusing a row. The node catches and reports it; the adapter must not swallow it.
    await expect(syncAuthenticator('test')?.(upgrade())).rejects.toThrow('auth backend timeout');
  });

  test('the resolver is read at start, not at module load', () => {
    // A watch-mode restart configures the app's resolver again, after this module first evaluated.
    expect(syncAuthenticator('test')).toBeUndefined();
    configureAuthenticator(() => userActor({ id: 'u1' }));
    expect(syncAuthenticator('test')).toBeDefined();
  });
});
