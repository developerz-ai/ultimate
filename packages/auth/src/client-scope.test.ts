// The page's client scope id: what a per-request document tells the browser about WHO it was
// rendered for, without telling it who that is.

import { describe, expect, test } from 'bun:test';
import { anonymousActor, userActor } from '@ultimat3/core';
import { clientScopeOf } from './client-scope';

const SECRET = 'x'.repeat(32);
const OTHER_SECRET = 'y'.repeat(32);

describe('clientScopeOf', () => {
  test('anonymous is the empty scope', () => {
    expect(clientScopeOf(anonymousActor(), { secret: SECRET })).toBe('');
  });

  test('a user gets an opaque id that never contains the user id', () => {
    const id = 'alice@example.com';
    const scope = clientScopeOf(userActor({ id }), { secret: SECRET });

    expect(scope).toMatch(/^[0-9a-f]{32}$/);
    expect(scope).not.toContain('alice');
  });

  test('stable for one principal, distinct across principals', () => {
    const alice = clientScopeOf(userActor({ id: 'alice' }), { secret: SECRET });

    expect(clientScopeOf(userActor({ id: 'alice' }), { secret: SECRET })).toBe(alice);
    expect(clientScopeOf(userActor({ id: 'bob' }), { secret: SECRET })).not.toBe(alice);
  });

  test('keyed: the same principal under another secret is another id, so it is not a bare hash', () => {
    const actor = userActor({ id: 'alice' });

    expect(clientScopeOf(actor, { secret: SECRET })).not.toBe(
      clientScopeOf(actor, { secret: OTHER_SECRET }),
    );
    expect(clientScopeOf(actor, { secret: SECRET })).not.toBe(
      new Bun.CryptoHasher('sha256').update('alice').digest('hex').slice(0, 32),
    );
  });

  test('impersonating someone is a different scope from being them', () => {
    const alice = userActor({ id: 'alice' });
    const adminAsAlice = { ...alice, onBehalfOf: { actorId: 'admin', actorKind: 'user' as const } };

    expect(clientScopeOf(adminAsAlice, { secret: SECRET })).not.toBe(
      clientScopeOf(alice, { secret: SECRET }),
    );
    const otherAdminAsAlice = {
      ...alice,
      onBehalfOf: { actorId: 'other-admin', actorKind: 'user' as const },
    };
    expect(clientScopeOf(adminAsAlice, { secret: SECRET })).not.toBe(
      clientScopeOf(otherAdminAsAlice, { secret: SECRET }),
    );
  });

  test('no SESSION_SECRET still answers an opaque id, stable within the process', () => {
    const actor = userActor({ id: 'alice' });
    const first = clientScopeOf(actor, { env: {} });

    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(clientScopeOf(actor, { env: {} })).toBe(first);
  });
});
