import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { evaluate, explain, renderTrace } from './evaluate';
import { actorHas } from './grant-index';
import { clearPermissions, definePermissions } from './permissions';
import type { Policy } from './policy';
import { admitsAnonymous, allow, and, can, deny, not, or, policyPermissions } from './policy';
import { clearRoles, defineRoles, expandRoles } from './roles';
import { testActor } from './test-kit';

interface PostInput {
  readonly postId: string;
  readonly ownerId: string;
}

const input: PostInput = { postId: 'p1', ownerId: 'owner' };

beforeEach(() => {
  clearPermissions();
  clearRoles();
  definePermissions(['post:read', 'post:publish', 'post:delete', 'org:admin'] as const);
  defineRoles({
    viewer: { grants: ['post:read'] },
    editor: { grants: ['post:publish'], inherits: ['viewer'] },
    owner: { grants: ['post:delete'], inherits: ['editor'] },
    root: { grants: ['*'] },
  });
});

const owner = testActor('owner', { roles: ['owner'] }).actor;
const editor = testActor('editor', { roles: ['editor'] }).actor;
const viewer = testActor('viewer', { roles: ['viewer'] }).actor;

// The permission and role registries are process-global by design — one app, one set. A test
// file that leaves them populated makes an unrelated package's `can()` throw
// X_PERMISSION_UNKNOWN, so this file must hand the process back the way it found it.
afterAll(() => {
  clearPermissions();
  clearRoles();
});

describe('roles', () => {
  test('inheritance expands to a flat permission set', () => {
    expect(expandRoles(['owner'])).toEqual(['post:delete', 'post:publish', 'post:read']);
    expect(expandRoles(['viewer'])).toEqual(['post:read']);
  });

  test('a cycle terminates instead of blowing the stack', () => {
    defineRoles({
      a: { grants: ['x:y'], inherits: ['b'] },
      b: { grants: ['y:z'], inherits: ['a'] },
    });
    expect(expandRoles(['a'])).toEqual(['x:y', 'y:z']);
  });

  test('a wildcard grant covers every verb on its resource', () => {
    defineRoles({ mod: { grants: ['post:*'] } });
    const mod = testActor('mod', { roles: ['mod'] }).actor;
    expect(actorHas(mod, 'post:delete')).toBe(true);
    expect(actorHas(mod, 'org:admin')).toBe(false);
  });
});

describe('can()', () => {
  test('denies an anonymous actor before it looks at the predicate', () => {
    const policy = can<PostInput>('post:publish', () => true);
    const result = evaluate(policy, { input, actor: null });
    expect(result.allowed).toBe(false);
    expect(result.decision.allowed ? '' : result.decision.code).toBe('X_UNAUTHENTICATED');
  });

  test('separates "may never" from "may, but not this row"', () => {
    const policy = can<PostInput>('post:publish', (args) => args.actor?.id === args.input.ownerId);
    expect(evaluate(policy, { input, actor: viewer }).decision).toMatchObject({
      allowed: false,
      reason: 'actor lacks post:publish',
    });
    const notOwner = evaluate(policy, { input, actor: editor });
    expect(notOwner.allowed).toBe(false);
    expect(notOwner.decision.allowed ? '' : notOwner.decision.reason).toContain('predicate');
    expect(evaluate(policy, { input, actor: owner }).allowed).toBe(true);
  });

  test('a typo is X_PERMISSION_UNKNOWN at declaration time, not at request time', () => {
    expect(() => can('post:pubish')).toThrow(/X_PERMISSION_UNKNOWN|not in the permission set/);
  });
});

describe('composition', () => {
  const isOwner = can<PostInput>('post:read', (args) => args.actor?.id === args.input.ownerId);
  const canPublish = can<PostInput>('post:publish');

  test('and() short-circuits on the first denial and keeps its reason', () => {
    const policy = and(canPublish, isOwner);
    expect(evaluate(policy, { input, actor: owner }).allowed).toBe(true);
    const denied = evaluate(policy, { input, actor: viewer });
    expect(denied.allowed).toBe(false);
    expect(denied.decision.allowed ? '' : denied.decision.reason).toBe('actor lacks post:publish');
  });

  test('or() allows when any clause allows', () => {
    const policy = or(canPublish, isOwner);
    expect(evaluate(policy, { input, actor: editor }).allowed).toBe(true);
    expect(evaluate(policy, { input, actor: owner }).allowed).toBe(true);
    expect(evaluate(policy, { input, actor: viewer }).allowed).toBe(false);
  });

  // The security case, first: `can()` denies a null actor with X_UNAUTHENTICATED, and `not()`
  // used to invert that into an ALLOW. `and(can(a), not(can(b)))` hid it — the first clause
  // carried the authentication — right up until someone simplified to `not(can(b))` for a
  // "public unless internal" route and shipped an anonymous door into the internal one.
  test('not() refuses an anonymous caller instead of inverting the denial', () => {
    const evaluation = evaluate(not(canPublish), { input, actor: null });
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.decision.allowed ? '' : evaluation.decision.code).toBe('X_UNAUTHENTICATED');
  });

  test('not() refuses an anonymous caller through every wrapping combinator', () => {
    expect(evaluate(not(not(canPublish)), { input, actor: null }).allowed).toBe(false);
    expect(evaluate(and(allow<PostInput>(), not(canPublish)), { input, actor: null }).allowed).toBe(
      false,
    );
  });

  test('not() inverts, and double negation is identity', () => {
    expect(evaluate(not(canPublish), { input, actor: viewer }).allowed).toBe(true);
    expect(evaluate(not(canPublish), { input, actor: editor }).allowed).toBe(false);
    expect(evaluate(not(not(canPublish)), { input, actor: editor }).allowed).toBe(true);
  });

  test('permissions flatten through every combinator, deduped and sorted', () => {
    const policy = and(
      canPublish,
      or(can<PostInput>('post:delete'), canPublish),
      not(can<PostInput>('org:admin')),
    );
    expect(policyPermissions(policy)).toEqual(['org:admin', 'post:delete', 'post:publish']);
    // The bug this closes: `label` is a sentence, never a permission.
    expect(policy.label).not.toBe('post:publish');
  });

  test('allow() and deny() are terminal and say so in the trace', () => {
    expect(evaluate(allow<PostInput>('public'), { input, actor: null }).allowed).toBe(true);
    const stopped = evaluate(deny<PostInput>('read-only mode'), { input, actor: owner });
    expect(stopped.allowed).toBe(false);
    expect(stopped.decision.allowed ? '' : stopped.decision.reason).toBe('read-only mode');
  });

  test('nested composition evaluates left to right, depth first', () => {
    const policy = and(canPublish, or(isOwner, can<PostInput>('org:admin')));
    expect(evaluate(policy, { input, actor: owner }).allowed).toBe(true);
    expect(evaluate(policy, { input, actor: editor }).allowed).toBe(false);
  });
});

describe('trace', () => {
  test('names the clause that decided, not just the root', () => {
    const policy = and(can<PostInput>('post:publish'), can<PostInput>('post:delete'));
    const result = evaluate(policy, { input, actor: editor });
    expect(result.allowed).toBe(false);
    expect(result.deciding?.label).toBe('post:delete');
    expect(explain(result)).toContain('by post:delete');
    expect(renderTrace(result).split('\n').length).toBeGreaterThan(1);
  });

  test('a reason is safe to log: it names permissions, never row data', () => {
    const result = evaluate(can<PostInput>('post:delete'), { input, actor: viewer });
    const reason = result.decision.allowed ? '' : result.decision.reason;
    expect(reason).toBe('actor lacks post:delete');
    expect(reason).not.toContain('p1');
  });
});

/**
 * The walk, against the thing it models: every case asserts what the POLICY ITSELF decides for
 * `actor: null`, so a surface's `auth` flag and the runtime's decision cannot drift apart.
 */
describe('admitsAnonymous', () => {
  const guarded = (): Policy => can('post:publish');
  const other = (): Policy => can('post:read');

  /** What the policy object answers an anonymous caller — the ground truth this walk models. */
  const runsForAnonymous = (policy: Policy): boolean =>
    policy.run({ input, actor: null, row: null }).allowed;

  /** Built inside the test, never at module scope: `can()` asserts against `beforeEach`'s set. */
  const cases = (): readonly (readonly [string, Policy])[] => [
    ['allow()', allow()],
    ['deny()', deny('nope')],
    ['can()', guarded()],
    ['or(allow, can)', or(allow(), guarded())],
    ['or(can, allow)', or(guarded(), allow())],
    ['or(can, can)', or(guarded(), other())],
    ['and(allow, can)', and(allow(), guarded())],
    ['and(allow, allow)', and(allow(), allow())],
    ['not(can)', not(guarded())],
    ['not(allow)', not(allow())],
    ['not(deny)', not(deny('nope'))],
    ['or(and(allow, allow), can)', or(and(allow(), allow()), guarded())],
    ['and(or(allow, can), deny)', and(or(allow(), guarded()), deny('nope'))],
  ];

  test('answers exactly what running the policy with no actor answers', () => {
    // Named, never counted: a failure has to say WHICH shape the walk got wrong.
    const wrong = cases()
      .filter(([, policy]) => admitsAnonymous(policy) !== runsForAnonymous(policy))
      .map(([label]) => label);
    expect(wrong).toEqual([]);
  });

  // The case the root-combinator read got wrong, spelled out on its own: it is the shape a
  // "public, but richer when signed in" declaration takes, and `@ultimat3/http`'s auth stage
  // 401'd it before the surface's own evaluation ever ran.
  test('a public branch under `or` admits an anonymous caller', () => {
    expect(admitsAnonymous(or(allow('public'), guarded()))).toBe(true);
  });

  test('a permission clause under `and` still requires authentication', () => {
    expect(admitsAnonymous(and(allow('public'), guarded()))).toBe(false);
  });

  test('a bare permission is unchanged — this is the common case and it must not move', () => {
    expect(admitsAnonymous(guarded())).toBe(false);
  });

  // A foreign `Policy` is a plain object, so `kind` can be any string — including one that reads a
  // function off `Object.prototype` rather than answering `undefined`. `valueOf` is the one that
  // proves the guard: called with no receiver it THROWS, so an unguarded table read would kill a
  // route projection at mount rather than answering "needs a session".
  test('a kind this build has never heard of requires authentication, and never throws', () => {
    for (const kind of ['constructor', 'valueOf', 'toString', 'invented-by-a-provider']) {
      expect(admitsAnonymous({ ...allow(), kind } as unknown as Policy)).toBe(false);
    }
  });
});
