import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { memoryDecisionSink, resetDecisionSink, setDecisionSink } from './decisions';
import { evaluate } from './evaluate';
import { clearPermissions, definePermissions } from './permissions';
import type { Policy } from './policy';
import { allow, and, can, deny, not, or } from './policy';
import { decideBeforeInput, enforceBeforeInput } from './pre-input';
import type { Actor } from './roles';
import { clearRoles, defineRoles } from './roles';
import { testActor } from './test-kit';

interface Input {
  readonly ownerId: string;
}

beforeEach(() => {
  clearPermissions();
  clearRoles();
  definePermissions(['post:read', 'post:publish', 'staff:refund'] as const);
  defineRoles({ reader: { grants: ['post:read'] }, staff: { grants: ['staff:refund'] } });
});

afterAll(() => {
  clearPermissions();
  clearRoles();
  resetDecisionSink();
});

const reader = testActor('reader', { roles: ['reader'] }).actor;
const staff = testActor('staff', { roles: ['staff'] }).actor;

/** A predicate that throws on the input it is never supposed to see before the parse. */
const owns = ({ actor, input }: { actor: Actor | null; input: Input }): boolean =>
  input.ownerId === actor?.id;

describe('decideBeforeInput decides only what reads no input', () => {
  test('can() without a predicate is decided either way', () => {
    expect(decideBeforeInput(can('staff:refund'), { actor: reader })).toMatchObject({
      allowed: false,
      code: 'X_FORBIDDEN',
      reason: 'actor lacks staff:refund',
    });
    expect(decideBeforeInput(can('staff:refund'), { actor: staff })).toEqual({ allowed: true });
    expect(decideBeforeInput(can('staff:refund'), { actor: null })).toMatchObject({
      allowed: false,
      code: 'X_UNAUTHENTICATED',
    });
  });

  test('can() with a predicate denies a caller without the permission, and waits for one with it', () => {
    const rule = can<Input>('post:read', owns);
    expect(decideBeforeInput(rule, { actor: staff })).toMatchObject({ allowed: false });
    // The predicate would have to run: undecided, never a guess.
    expect(decideBeforeInput(rule, { actor: reader })).toBeUndefined();
  });

  test('combinators decide exactly when every relevant clause is decided', () => {
    const rule = can<Input>('post:read', owns);
    // One definite denial sinks a conjunction, even right of an undecided clause.
    expect(decideBeforeInput(and(rule, can('staff:refund')), { actor: reader })).toMatchObject({
      allowed: false,
      reason: 'actor lacks staff:refund',
    });
    expect(decideBeforeInput(and(rule, can('post:read')), { actor: reader })).toBeUndefined();
    // One allowance carries a disjunction; one undecided clause holds it open.
    expect(decideBeforeInput(or(rule, can('staff:refund')), { actor: staff })).toEqual({
      allowed: true,
    });
    expect(decideBeforeInput(or(rule, can('staff:refund')), { actor: reader })).toBeUndefined();
    expect(decideBeforeInput(not(can('staff:refund')), { actor: staff })).toMatchObject({
      allowed: false,
    });
    expect(decideBeforeInput(not(rule), { actor: reader })).toBeUndefined();
    expect(decideBeforeInput(not(can('staff:refund')), { actor: null })).toMatchObject({
      code: 'X_UNAUTHENTICATED',
    });
  });

  test('a policy this package did not build is always undecided', () => {
    const foreign: Policy = {
      kind: 'deny',
      label: 'hand-built',
      permissions: [],
      children: [],
      run: () => ({ allowed: false, reason: 'no', code: 'X_FORBIDDEN' }),
    };
    expect(decideBeforeInput(foreign, { actor: reader })).toBeUndefined();
    expect(decideBeforeInput(and(foreign, can('post:read')), { actor: reader })).toBeUndefined();
  });

  test('every decision agrees with the full evaluation over any input', () => {
    const rule = can<Input>('post:read', owns);
    const trees: readonly Policy<Input>[] = [
      rule,
      can('staff:refund'),
      and(rule, can('staff:refund')),
      or(rule, can('staff:refund')),
      or(deny('closed'), allow()),
      not(or(can('staff:refund'), deny('read-only'))),
      and(not(rule), can('post:read')),
      or(and(can('post:read'), not(can('staff:refund'))), rule),
    ];
    const inputs: readonly Input[] = [{ ownerId: 'reader' }, { ownerId: 'someone-else' }];
    for (const tree of trees) {
      for (const actor of [reader, staff, null]) {
        const early = decideBeforeInput(tree, { actor });
        if (early === undefined) continue;
        for (const input of inputs) {
          const full = evaluate(tree, { input, actor }, { trace: false }).decision;
          expect({ tree: tree.label, allowed: full.allowed }).toEqual({
            tree: tree.label,
            allowed: early.allowed,
          });
          if (!full.allowed && !early.allowed) expect(early.code).toBe(full.code);
        }
      }
    }
  });
});

describe('enforceBeforeInput renders the surface denial, once', () => {
  test('a denied caller gets the same HTTP problem the full evaluation gives', () => {
    const denial = enforceBeforeInput('http', can('staff:refund'), { actor: reader });
    expect(denial).toMatchObject({
      surface: 'http',
      status: 403,
      problem: { code: 'X_FORBIDDEN', detail: 'actor lacks staff:refund' },
    });
  });

  test('an allowed or undecided caller passes, and emits no decision', () => {
    const sink = memoryDecisionSink();
    setDecisionSink(sink);
    expect(enforceBeforeInput('mcp', can('staff:refund'), { actor: staff })).toBeUndefined();
    expect(enforceBeforeInput('mcp', can<Input>('post:read', owns), { actor: reader })).toBe(
      undefined,
    );
    expect(sink.events).toEqual([]);
    enforceBeforeInput('job', can('staff:refund'), { actor: reader });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({ allowed: false, deciding: 'staff:refund' });
    resetDecisionSink();
  });
});
