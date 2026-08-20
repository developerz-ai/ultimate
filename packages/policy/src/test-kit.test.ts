import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { actorLabel, hasScope, isAnonymous, userActor } from '@ultimat3/core';
import { clearPermissions, definePermissions } from './permissions';
import { and, can } from './policy';
import { clearRoles, defineRoles } from './roles';
import { policyMatrix, testActor } from './test-kit';

interface Input {
  readonly postId: string;
  readonly ownerId: string;
}

beforeEach(() => {
  clearPermissions();
  clearRoles();
  definePermissions(['post:read', 'post:publish'] as const);
  defineRoles({
    viewer: { grants: ['post:read'] },
    editor: { grants: ['post:publish'], inherits: ['viewer'] },
    root: { grants: ['*'] },
  });
});

const publishOwnPost = () =>
  and(
    can<Input>('post:publish'),
    can<Input>('post:read', (args) => args.actor?.id === args.input.ownerId),
  );

// The permission and role registries are process-global by design — one app, one set. A test
// file that leaves them populated makes an unrelated package's `can()` throw
// X_PERMISSION_UNKNOWN, so this file must hand the process back the way it found it.
afterAll(() => {
  clearPermissions();
  clearRoles();
});

describe('policyMatrix', () => {
  const actors = () => [
    testActor('owner', { roles: ['editor'] }),
    testActor('editor', { roles: ['editor'] }),
    testActor('viewer', { roles: ['viewer'] }),
    testActor('root', { roles: ['root'] }),
    { name: 'anonymous', actor: null },
  ];

  test('produces an assert-ready allow/deny verdict per actor', () => {
    const matrix = policyMatrix(publishOwnPost(), {
      input: { postId: 'p1', ownerId: 'owner' },
      actors: actors(),
    });

    // `root` holds `*`, yet is still denied: a wildcard grant satisfies the permission
    // clause but not the row-level predicate. That asymmetry is the reason a policy has
    // both, and a matrix is how you see it.
    expect(matrix.verdicts).toEqual({
      owner: true,
      editor: false,
      viewer: false,
      root: false,
      anonymous: false,
    });
    expect(matrix.allowedFor('owner')).toBe(true);
    expect(matrix.allowedFor('nobody')).toBe(false);
  });

  test('every denial carries a reason and the clause that decided', () => {
    const matrix = policyMatrix(publishOwnPost(), {
      input: { postId: 'p1', ownerId: 'owner' },
      actors: actors(),
    });
    for (const row of matrix.rows) {
      if (row.allowed) continue;
      expect(row.reason, `${row.actor} denied with no reason`).toBeTruthy();
      expect(row.deciding, `${row.actor} denied with no deciding clause`).toBeTruthy();
    }
    expect(matrix.rows.find((row) => row.actor === 'viewer')?.reason).toBe(
      'actor lacks post:publish',
    );
  });

  test('forwards `row`, so a row-level rule is not reported as denying everyone', () => {
    const ownsRow = can<Input, { readonly authorId: string }>(
      'post:read',
      ({ actor, row }) => row?.authorId === actor?.id,
    );
    const base = { input: { postId: 'p1', ownerId: 'owner' }, actors: actors() };

    // No row: the rule correctly denies — `row` is `null`, not `undefined`.
    expect(policyMatrix(ownsRow, base).allowedFor('owner')).toBe(false);
    // With a row: the same rule allows its author. A matrix that dropped `row` could not
    // tell these two tables apart, and would report the second one wrong.
    expect(policyMatrix(ownsRow, { ...base, row: { authorId: 'owner' } }).allowedFor('owner')).toBe(
      true,
    );
  });

  test('toTable() renders one line per actor for a snapshot', () => {
    const matrix = policyMatrix(publishOwnPost(), {
      input: { postId: 'p1', ownerId: 'owner' },
      actors: actors(),
    });
    const lines = matrix.toTable().split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toStartWith('owner');
    expect(lines[0]).toContain('allow');
    expect(lines[2]).toContain('deny');
  });
});

// An actor's NAME reaches the verdict map as a key, and a plain object literal inherits keys it
// was never given: `allowedFor('constructor')` used to answer the `Object` function — truthy, and
// not a boolean — so a matrix would report allow for an actor nobody granted anything.
describe('an actor name is data, never a prototype key', () => {
  const rule = () => can<Input>('post:read');

  test('allowedFor() answers a boolean for a name every object inherits', () => {
    const matrix = policyMatrix(rule(), {
      input: { postId: 'p1', ownerId: 'owner' },
      actors: [testActor('viewer', { roles: ['viewer'] })],
    });

    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(matrix.allowedFor(name)).toBe(false);
    }
  });

  test('an actor named __proto__ gets its own verdict, stored and read back', () => {
    const matrix = policyMatrix(rule(), {
      input: { postId: 'p1', ownerId: 'owner' },
      actors: [testActor('__proto__', { roles: ['viewer'] }), testActor('nobody')],
    });

    expect(matrix.allowedFor('__proto__')).toBe(true);
    expect(matrix.allowedFor('nobody')).toBe(false);
    expect(Object.getPrototypeOf(matrix.verdicts)).toBe(Object.prototype);
  });
});

// `testActor` used to omit `kind` and `scopes` behind a cast, so every actor it minted crashed
// the two core helpers that read them — a scope-gated policy test failed as a bare TypeError
// escaping `evaluate()` rather than as the denial it was written to assert.
describe('testActor mints an actor core’s own helpers can read', () => {
  test('kind and scopes are present, so hasScope() answers instead of throwing', () => {
    const actor = testActor('reader', { scopes: ['tenancy:cross'] }).actor;
    if (actor === null) throw new Error('testActor always mints an actor');

    expect(actor.kind).toBe('user');
    expect(hasScope(actor, 'tenancy:cross')).toBe(true);
    expect(hasScope(actor, 'billing:refund')).toBe(false);
    expect(isAnonymous(actor)).toBe(false);
  });

  test('an actor with no scopes declared still carries an empty list, never undefined', () => {
    const actor = testActor('nobody').actor;
    if (actor === null) throw new Error('testActor always mints an actor');

    expect(actor.scopes).toEqual([]);
    expect(hasScope(actor, 'anything')).toBe(false);
  });

  test('actorLabel() renders the kind, so a decision log names who was denied', () => {
    const actor = testActor('u1', { orgId: 'org-1' }).actor;
    if (actor === null) throw new Error('testActor always mints an actor');

    expect(actorLabel(actor)).toBe('user:u1@org-1');
  });
});

// The asymmetry that made `testActor()` ship broken: a request's actor is frozen with frozen
// arrays, and every hand-built fixture was a mutable literal — so the fixtures proving authz had a
// shape production never mints, and nothing could notice the missing fields.
describe('a test actor is structurally a production actor', () => {
  const production = userActor({ id: 'ada', roles: ['editor'], permissions: ['post:publish'] });

  test('frozen, with frozen grant lists, exactly as a request-minted actor is', () => {
    const actor = testActor('ada', { roles: ['editor'], permissions: ['post:publish'] }).actor;
    if (actor === null) throw new Error('testActor always mints an actor');

    expect(Object.isFrozen(actor)).toBe(Object.isFrozen(production));
    expect(Object.isFrozen(actor.roles)).toBe(Object.isFrozen(production.roles));
    expect(Object.isFrozen(actor.permissions)).toBe(Object.isFrozen(production.permissions));
    expect(Object.isFrozen(actor)).toBe(true);
  });

  test('carries every key a built actor carries, so a new field cannot be missed here', () => {
    const actor = testActor('ada').actor;
    if (actor === null) throw new Error('testActor always mints an actor');

    // `orgId` is the one deliberate difference — `null` here, `undefined` there — so it is
    // compared as a KEY and not as a value; `@ultimat3/query`'s `orgless()` reads both alike.
    expect(Object.keys(actor).sort()).toEqual(Object.keys(production).sort());
  });
});
