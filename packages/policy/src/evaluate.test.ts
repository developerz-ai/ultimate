// `evaluate.ts` is the single entry point every surface calls; policy.test.ts and
// policy-args.test.ts exercise it end to end through `can()`/combinators. This file covers
// the pure helpers `codeOf()`/`reasonOf()` directly, since nothing else asserts on them in
// isolation from a full evaluation.
import { afterEach, describe, expect, test } from 'bun:test';
import type { PolicyDecisionEvent } from '@ultimat3/core';
import { resetInstrumentation, subscribe, userActor } from '@ultimat3/core';
import { codeOf, evaluate, reasonOf, resetPolicyTracing } from './evaluate';
import { clearPermissions, definePermissions } from './permissions';
import { ALLOWED, can, denied, or } from './policy';
import { clearRoles, defineRoles } from './roles';
import { testActor } from './test-kit';

/** Every `policy.decision` event from here on, in emit order — released by `resetInstrumentation`. */
const recordDecisions = (): { readonly events: PolicyDecisionEvent[] } => {
  const events: PolicyDecisionEvent[] = [];
  subscribe('policy.decision', (event) => void events.push(event.payload));
  return { events };
};

describe('reasonOf() / codeOf()', () => {
  test('an allowed decision has no reason and no code', () => {
    expect(reasonOf(ALLOWED)).toBeNull();
    expect(codeOf(ALLOWED)).toBeNull();
  });

  test('a denied decision surfaces its reason and code', () => {
    const decision = denied('not the author', 'X_FORBIDDEN');
    expect(reasonOf(decision)).toBe('not the author');
    expect(codeOf(decision)).toBe('X_FORBIDDEN');
  });

  test('denied() defaults the code to X_FORBIDDEN when not given', () => {
    const decision = denied('no actor for post:publish');
    expect(codeOf(decision)).toBe('X_FORBIDDEN');
  });

  test('a non-default code round-trips through codeOf()', () => {
    const decision = denied('no actor for post:publish', 'X_UNAUTHENTICATED');
    expect(codeOf(decision)).toBe('X_UNAUTHENTICATED');
  });
});

// A `TraceEntry[]` per evaluation is allocation on the one path with the least slack: a live
// query evaluates policy per subscriber on every change event. Nobody reads it in production —
// unless a `policy.decision` subscriber is, which is the one thing that does.
describe('the trace is opt-in in production', () => {
  const declared = process.env['ULTIMATE_ENV'];

  function inProduction(): void {
    process.env['ULTIMATE_ENV'] = 'production';
    resetPolicyTracing();
  }

  afterEach(() => {
    if (declared === undefined) delete process.env['ULTIMATE_ENV'];
    else process.env['ULTIMATE_ENV'] = declared;
    resetPolicyTracing();
    resetInstrumentation();
    clearPermissions();
    clearRoles();
  });

  function seed(): void {
    definePermissions(['post:publish'] as const);
    defineRoles({ editor: { grants: ['post:publish'] } });
  }

  test('production builds no trace and no deciding entry', () => {
    seed();
    inProduction();
    const evaluation = evaluate(can('post:publish'), {
      input: {},
      actor: testActor('editor', { roles: ['editor'] }).actor,
    });
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.trace).toEqual([]);
    expect(evaluation.deciding).toBeNull();
  });

  test('a policy.decision subscriber turns it back on, in production', () => {
    seed();
    inProduction();
    recordDecisions();
    const evaluation = evaluate(can('post:publish'), {
      input: {},
      actor: testActor('editor', { roles: ['editor'] }).actor,
    });
    expect(evaluation.deciding?.label).toBe('post:publish');
  });

  test('an explicit { trace: true } overrides the environment', () => {
    seed();
    inProduction();
    const evaluation = evaluate(
      can('post:publish'),
      { input: {}, actor: testActor('editor', { roles: ['editor'] }).actor },
      { trace: true },
    );
    expect(evaluation.trace).toHaveLength(1);
  });

  // The whole record, not a field at a time: `reason: null` on an ALLOW is what "there is no code
  // for yes" means, and a subscriber that started receiving a reason on an allow would be publishing a
  // second vocabulary for success — invisible to any assertion that only reads `allowed`.
  test('an allowed decision emits the full event, with no code and no reason', () => {
    seed();
    const events = recordDecisions();

    evaluate(
      can('post:publish'),
      { input: {}, actor: userActor({ id: 'ada', orgId: 'acme', roles: ['editor'] }) },
      { surface: 'http' },
    );

    expect(events.events).toEqual([
      {
        label: 'post:publish',
        allowed: true,
        code: null,
        reason: null,
        actorId: 'ada',
        actorKind: 'user',
        orgId: 'acme',
        surface: 'http',
        deciding: 'post:publish',
      },
    ]);
  });

  test('outside production the trace is on with nothing configured', () => {
    seed();
    process.env['ULTIMATE_ENV'] = 'development';
    resetPolicyTracing();
    const evaluation = evaluate(can('post:publish'), {
      input: {},
      actor: testActor('editor', { roles: ['editor'] }).actor,
    });
    expect(evaluation.trace).toHaveLength(1);
  });
});

// `/_x` and every `explain()` name the clause that DECIDED. In an `or(...)` every clause denied,
// and the decision reports the LAST denial — so the deciding leaf is the one whose reason the
// caller reads, never merely the first leaf that also denied.
describe('who decided an or(...) denial', () => {
  afterEach(() => {
    clearPermissions();
    clearRoles();
  });

  test('the leaf whose reason the decision carries, not the first denying leaf', () => {
    definePermissions(['post:publish', 'post:review'] as const);
    defineRoles({ reader: { grants: [] } });
    const evaluation = evaluate(
      or(can('post:publish'), can('post:review')),
      { input: {}, actor: testActor('reader', { roles: ['reader'] }).actor },
      { trace: true },
    );
    expect(evaluation.allowed).toBe(false);
    expect(reasonOf(evaluation.decision)).toBe('actor lacks post:review');
    expect(evaluation.deciding?.label).toBe('post:review');
  });
});
