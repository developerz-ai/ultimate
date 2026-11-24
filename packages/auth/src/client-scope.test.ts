// The page's client scope id: what a per-request document tells the browser about WHO it was
// rendered for, without telling it who that is.

import { describe, expect, test } from 'bun:test';
import { anonymousActor, clientScopeId, userActor } from '@ultimat3/core';
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

  // A scope that named only the person let a page, a store or a queued write rendered under one
  // org be reused under another: the router swaps on an equal scope, and the store keeps its rows.
  test('one person in two orgs is two scopes; each is stable', () => {
    const inA = clientScopeOf(userActor({ id: 'alice', orgId: 'org-a' }), { secret: SECRET });
    const inB = clientScopeOf(userActor({ id: 'alice', orgId: 'org-b' }), { secret: SECRET });

    expect(inA).toMatch(/^[0-9a-f]{32}$/);
    expect(inA).not.toBe(inB);
    expect(clientScopeOf(userActor({ id: 'alice', orgId: 'org-a' }), { secret: SECRET })).toBe(inA);
    expect(inA).not.toBe(clientScopeOf(userActor({ id: 'alice' }), { secret: SECRET }));
    expect(inA).not.toContain('org-a');
  });

  // Known answer: an actor with no org keeps the id it had before the org joined the material, so
  // an app without tenants sees no rescope on upgrade.
  test('no org: the same id as before the org joined the material', () => {
    const material = JSON.stringify(['user', 'alice', null, null]);
    const before = new Bun.CryptoHasher('sha256', SECRET)
      .update(material)
      .digest('hex')
      .slice(0, 32);

    expect(clientScopeOf(userActor({ id: 'alice' }), { secret: SECRET })).toBe(before);
  });

  test('the anonymous page stays the empty scope, whatever org it names', () => {
    expect(clientScopeOf({ ...anonymousActor(), orgId: 'org-a' }, { secret: SECRET })).toBe('');
  });

  test('no SESSION_SECRET still answers an opaque id, stable within the process', () => {
    const actor = userActor({ id: 'alice' });
    const first = clientScopeOf(actor, { env: {} });

    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(clientScopeOf(actor, { env: {} })).toBe(first);
  });

  // `@ultimat3/action` judges a replay with core's function: a second fallback key here would
  // refuse every replay on an app with no SESSION_SECRET.
  test('is the id core derives, under the same fallback key', () => {
    const actor = userActor({ id: 'alice' });
    expect(clientScopeOf(actor, { env: {} })).toBe(clientScopeId(actor, { env: {} }));
  });

  // The floor guarded only the env path: `{ secret: 'x' }` keyed every page's scope with one
  // character. An explicit secret is a caller's value, so it is refused rather than replaced.
  test('an explicit secret under the SESSION_SECRET floor is refused, never used', () => {
    const thrown = (() => {
      try {
        return clientScopeOf(userActor({ id: 'alice' }), { secret: 'x'.repeat(31) });
      } catch (error) {
        return error;
      }
    })();

    expect(thrown).toBeUltimateError('X_CONFIG_INVALID');
    const cause = (thrown as { cause: string }).cause;
    // The floor is named; the length of what was handed over is not.
    expect(cause).toContain('shorter than the 32 characters required');
    expect(cause).not.toContain('31');
  });

  test('the anonymous page needs no key, so a short secret cannot refuse it', () => {
    expect(clientScopeOf(anonymousActor(), { secret: 'x' })).toBe('');
  });
});
