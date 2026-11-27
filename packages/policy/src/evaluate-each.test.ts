// `evaluateEach()` is `evaluate()` once per row and nothing else: one evaluation, one
// `policy.decision` event per row, the same predicate deciding each. A batch that answered once
// for N rows would let the first row's verdict stand for rows the rule never saw.
import { afterEach, describe, expect, test } from 'bun:test';
import type { PolicyDecisionEvent } from '@ultimat3/core';
import { resetInstrumentation, subscribe, userActor } from '@ultimat3/core';
import { PolicyError } from './errors';
import { evaluateEach } from './evaluate';
import { clearPermissions, definePermissions } from './permissions';
import { can, denied } from './policy';
import { clearRoles, defineRoles } from './roles';

interface Post {
  readonly id: string;
  readonly authorId: string;
}

const recordDecisions = (): PolicyDecisionEvent[] => {
  const events: PolicyDecisionEvent[] = [];
  subscribe('policy.decision', (event) => void events.push(event.payload));
  return events;
};

const ownPost = () =>
  can<unknown, Post>('post:edit', ({ actor, row }) =>
    row !== null && row.authorId === actor?.id ? true : denied('not the author', 'X_NOT_AUTHOR'),
  );

const ada = userActor({ id: 'ada', orgId: 'acme', roles: ['editor'] });

describe('evaluateEach()', () => {
  afterEach(() => {
    resetInstrumentation();
    clearPermissions();
    clearRoles();
  });

  function seed(): void {
    definePermissions(['post:edit'] as const);
    defineRoles({ editor: { grants: ['post:edit'] } });
  }

  test('N rows answer N evaluations, in row order, mixed allow and deny', () => {
    seed();
    const rows: Post[] = [
      { id: 'p1', authorId: 'ada' },
      { id: 'p2', authorId: 'bob' },
      { id: 'p3', authorId: 'ada' },
    ];
    const evaluations = evaluateEach(ownPost(), { input: {}, actor: ada, rows });
    expect(evaluations.map((each) => each.allowed)).toEqual([true, false, true]);
    expect(evaluations[1]?.decision).toEqual({
      allowed: false,
      reason: 'not the author',
      code: 'X_NOT_AUTHOR',
    });
  });

  test('one policy.decision event per row, on the surface the caller named', () => {
    seed();
    const events = recordDecisions();
    evaluateEach(
      ownPost(),
      {
        input: {},
        actor: ada,
        rows: [
          { id: 'p1', authorId: 'ada' },
          { id: 'p2', authorId: 'bob' },
        ],
      },
      { surface: 'job' },
    );
    expect(events.map((event) => [event.allowed, event.code, event.surface])).toEqual([
      [true, null, 'job'],
      [false, 'X_NOT_AUTHOR', 'job'],
    ]);
  });

  test('no rows, no evaluations and no events', () => {
    seed();
    const events = recordDecisions();
    expect(evaluateEach(ownPost(), { input: {}, actor: ada, rows: [] })).toEqual([]);
    expect(events).toEqual([]);
  });

  test('an actor the permission refuses is denied on every row, whatever the row says', () => {
    seed();
    const rows: Post[] = [{ id: 'p1', authorId: 'ada' }];
    const [only] = evaluateEach(ownPost(), { input: {}, actor: null, rows });
    expect(only?.allowed).toBe(false);
    expect(only?.decision).toMatchObject({ code: 'X_UNAUTHENTICATED' });
  });

  // Fail closed: a predicate that throws answers no evaluation at all — never a partial list a
  // caller could read as "the rows before the throw were the allowed ones".
  test('a predicate that throws propagates, and no evaluation is returned', () => {
    seed();
    const boom = can<unknown, Post>('post:edit', ({ row }) => {
      if (row?.id === 'p2')
        throw new PolicyError({ code: 'X_FORBIDDEN', cause: 'predicate failed', fix: 'none' });
      return true;
    });
    const rows: Post[] = [
      { id: 'p1', authorId: 'ada' },
      { id: 'p2', authorId: 'ada' },
    ];
    expect(() => evaluateEach(boom, { input: {}, actor: ada, rows })).toThrow('predicate failed');
  });
});
