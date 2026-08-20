// The memo's contract has two halves and both have to hold at once: the role graph is walked
// ONCE per actor per role-map generation (the live-query path evaluates policy per subscriber),
// and a role revoked by a later `defineRoles()` takes effect immediately (no stale-authz window).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { serviceActor, userActor } from '@ultimat3/core';
import { actorHas, actorPermissions } from './grant-index';
import { clearPermissions, definePermissions } from './permissions';
import { and, can } from './policy';
import { clearRoles, defineRoles, grantMatches, type RoleMap } from './roles';
import { testActor } from './test-kit';

/** Counts every read of `grants` — one read is one walk of that role's node. */
let walks = 0;

const countingRole = (grants: readonly string[], inherits?: readonly string[]) => ({
  get grants(): readonly string[] {
    walks += 1;
    return grants;
  },
  ...(inherits === undefined ? {} : { inherits }),
});

beforeEach(() => {
  clearRoles();
  clearPermissions();
  walks = 0;
});

afterEach(() => {
  clearRoles();
  clearPermissions();
});

describe('the per-actor grant index', () => {
  test('N can() clauses walk the role graph ONCE, not N times', () => {
    definePermissions(['post:read', 'post:publish', 'post:delete'] as const);
    defineRoles({
      viewer: countingRole(['post:read']),
      editor: countingRole(['post:publish'], ['viewer']),
      owner: countingRole(['post:delete'], ['editor']),
    } as RoleMap);
    walks = 0; // `defineRoles` itself reads nothing; a conflict check would.

    const actor = testActor('owner', { roles: ['owner'] }).actor;
    const policy = and(can('post:read'), can('post:publish'), can('post:delete'));
    expect(policy.run({ input: {}, actor, row: null }).allowed).toBe(true);

    // Three nodes in the hierarchy, walked once between them — not once per clause.
    expect(walks).toBe(3);
  });

  test('a second actor is never served the first actor’s grants', () => {
    definePermissions(['post:publish'] as const);
    defineRoles({ editor: { grants: ['post:publish'] }, guest: { grants: [] } });
    const editor = testActor('e', { roles: ['editor'] }).actor;
    const guest = testActor('g', { roles: ['guest'] }).actor;
    expect(actorHas(editor, 'post:publish')).toBe(true);
    expect(actorHas(guest, 'post:publish')).toBe(false);
  });

  // The property `@ultimat3/auth` gives the framework for free by re-reading the user row each
  // request: a revoked role is gone on the next call, never one cache TTL later.
  test('a later defineRoles() invalidates the memo — no stale-authz window', () => {
    definePermissions(['post:publish'] as const);
    defineRoles({ editor: { grants: ['post:publish'] } });
    const actor = testActor('e', { roles: ['editor', 'auditor'] }).actor;
    expect(actorHas(actor, 'post:publish')).toBe(true);
    expect(actorPermissions(actor)).toEqual(['post:publish']);

    defineRoles({ auditor: { grants: ['audit:read'] } });
    expect(actorPermissions(actor)).toEqual(['audit:read', 'post:publish']);
  });

  // `readonly string[]` is a compile-time claim and nothing else. The memoised array WAS the
  // per-actor authz cache, so a `push` through a widened reference granted a permission for the
  // life of that request — to `actorHas` too, since a caller may hand the mutated list back.
  test('the returned list cannot be pushed into the memo', () => {
    definePermissions(['post:publish'] as const);
    defineRoles({ editor: { grants: ['post:publish'] } });
    const actor = testActor('e', { roles: ['editor'] }).actor;

    const first = actorPermissions(actor);
    (first as string[]).push('org:administer');

    expect(actorPermissions(actor)).toEqual(['post:publish']);
    // And a second read is not the same object either, or the next caller inherits this one.
    expect(actorPermissions(actor)).not.toBe(first);
  });

  test('an explicit map override is never answered from the global map’s entry', () => {
    defineRoles({ local: { grants: ['x:y'] } });
    const actor = testActor('u', { roles: ['local'] }).actor;
    const other: RoleMap = { local: { grants: ['a:b'] } };
    expect(actorPermissions(actor)).toEqual(['x:y']);
    expect(actorPermissions(actor, other)).toEqual(['a:b']);
    expect(actorPermissions(actor)).toEqual(['x:y']);
  });

  // The index replaces `.some(grantMatches)`, so it has to agree with it on every grant shape,
  // multi-colon wildcards included.
  test('the Set fast path agrees with grantMatches() on every grant shape', () => {
    const grants = ['post:read', 'post:*', 'a:b:*', 'not-a-grant', '*'];
    const wanted = ['post:read', 'post:delete', 'a:x', 'org:admin', 'not-a-grant'];
    for (const grant of grants) {
      const actor = testActor(`holder-${grant}`, { permissions: [grant] }).actor;
      for (const permission of wanted) {
        expect(actorHas(actor, permission as `${string}:${string}`)).toBe(
          grantMatches(grant, permission),
        );
      }
    }
  });
});

// The seam this package and core share. `permissions` used to be declared HERE, on
// `PolicyActorFields`, and core's `Actor` had no such field — so an actor holding a direct grant
// could not be built by the one thing that builds actors. Every caller wrote
// `{ ...userActor({ id }), permissions: [...] }`, which is a spread over a frozen object producing
// an unfrozen one: a shape no production path ever mints, in the fixtures that prove authz.
describe('a direct grant is minted by core’s own builder', () => {
  beforeEach(() => {
    defineRoles({ viewer: { grants: ['post:read'] } });
  });

  test('a service token built with serviceActor() holds the grant policy reads', () => {
    const token = serviceActor({ id: 'svc-1', permissions: ['post:publish'] });
    expect(actorHas(token, 'post:publish')).toBe(true);
    expect(actorHas(token, 'post:delete')).toBe(false);
  });

  test('roles and direct grants combine on one actor, deduped and sorted', () => {
    const both = userActor({ id: 'u1', roles: ['viewer'], permissions: ['post:publish'] });
    expect(actorPermissions(both)).toEqual(['post:publish', 'post:read']);
  });

  test('the actor a policy decides about is frozen, exactly as a request-minted one is', () => {
    const token = serviceActor({ id: 'svc-1', permissions: ['post:publish'] });
    expect(Object.isFrozen(token)).toBe(true);
    expect(actorHas(token, 'post:publish')).toBe(true);
  });

  test('an actor minted with no grants is denied rather than throwing', () => {
    const nobody = userActor({ id: 'u2' });
    expect(actorPermissions(nobody)).toEqual([]);
    expect(actorHas(nobody, 'post:publish')).toBe(false);
  });
});
