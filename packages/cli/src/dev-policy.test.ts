// The `/_x` policy matrix, asserted against real registered primitives and real roles. The bug
// this file guards is a CLI that answers "who can do what" from its own reading of the actor
// instead of from `@ultimat3/policy` — a second authz, disagreeing with the request path.

import { afterEach, describe, expect, test } from 'bun:test';
import { action, registerActions, resetRegistry as resetActions, t } from '@ultimat3/action';
import {
  allow,
  can,
  clearPermissions,
  clearRoles,
  definePermissions,
  defineRoles,
} from '@ultimat3/policy';
import { from, query, registerQuery, resetRegistry as resetQueries } from '@ultimat3/query';
import { devActors, devPolicyGates, devPolicyMatrix } from './dev-policy';

afterEach(() => {
  resetActions();
  resetQueries();
  clearRoles();
  clearPermissions();
});

function seed(): void {
  definePermissions(['post:publish', 'feed:read'] as const);
  defineRoles({
    admin: { grants: ['post:publish', 'feed:read'] },
    reader: { grants: ['feed:read'] },
  });
  registerActions({
    publishPost: action({
      input: t.object({}),
      output: t.object({}),
      policy: can('post:publish'),
      async handle() {
        return {};
      },
    }),
  });
  registerQuery(
    'feed',
    query({
      input: t.object({}),
      policy: can('feed:read'),
      // `from(entity, rows)` — the in-memory source takes its rows, and `Builder` projects
      // through `shape()`, never `select()`. The matrix never executes this query; it reads the
      // `policy` above, so the source only has to be a source.
      sql: () => from<{ id: string }>('posts', []).limit(10),
    }),
  );
}

const cell = (
  facts: readonly { permission: string; actorId: string; allowed: boolean }[],
  permission: string,
  actorId: string,
): boolean | undefined =>
  facts.find((fact) => fact.permission === permission && fact.actorId === actorId)?.allowed;

describe('unit · the /_x policy matrix', () => {
  test('one actor per declared role, plus the anonymous caller', () => {
    seed();
    expect(devActors().map((actor) => actor.name)).toEqual(['anonymous', 'admin', 'reader']);
  });

  test('an app that declares no roles still asks about the anonymous caller', () => {
    expect(devActors().map((actor) => actor.name)).toEqual(['anonymous']);
  });

  test('every gated capability is collected from actions AND queries', () => {
    seed();
    expect(devPolicyGates().map((gate) => gate.permission)).toEqual(['feed:read', 'post:publish']);
    expect(devPolicyGates().flatMap((gate) => [...gate.usedBy])).toEqual([
      'query:feed',
      'action:publishPost',
    ]);
  });

  test("the matrix is the app's own roles decided by the app's own policies", () => {
    seed();
    const facts = devPolicyMatrix();

    expect(cell(facts, 'post:publish', 'admin')).toBe(true);
    expect(cell(facts, 'post:publish', 'reader')).toBe(false);
    expect(cell(facts, 'feed:read', 'reader')).toBe(true);
    expect(cell(facts, 'post:publish', 'anonymous')).toBe(false);
    expect(cell(facts, 'feed:read', 'anonymous')).toBe(false);
  });

  test('one fact per capability per actor — the shape the panel pivots', () => {
    seed();
    // 2 capabilities × 3 actors. A duplicated row is a cell the panel silently drops.
    expect(devPolicyMatrix()).toHaveLength(6);
  });

  test('every cell carries the trace that produced it, naming where it is enforced', () => {
    seed();
    const denied = devPolicyMatrix().find(
      (fact) => fact.permission === 'post:publish' && fact.actorId === 'reader',
    );
    expect(denied?.trace[0]).toContain('deny');
    expect(denied?.trace.join('\n')).toContain('enforced in: action:publishPost');
    // The panel must never read a no-row verdict as the final word on a row-level rule.
    expect(denied?.trace.join('\n')).toContain('no row');
  });

  test('two primitives behind one capability and one policy collapse to one row', () => {
    definePermissions(['post:publish'] as const);
    defineRoles({ admin: { grants: ['post:publish'] } });
    const policy = can('post:publish');
    const make = () =>
      action({
        input: t.object({}),
        output: t.object({}),
        policy,
        async handle() {
          return {};
        },
      });
    registerActions({ publishPost: make(), unpublishPost: make() });

    const gates = devPolicyGates();
    expect(gates).toHaveLength(1);
    expect([...(gates[0]?.usedBy ?? [])]).toEqual(['action:publishPost', 'action:unpublishPost']);
  });

  test('a public action is its own row, allowed for everyone — not a hole in the matrix', () => {
    definePermissions(['post:publish'] as const);
    defineRoles({ admin: { grants: ['post:publish'] } });
    registerActions({
      publishPost: action({
        input: t.object({}),
        output: t.object({}),
        policy: can('post:publish'),
        async handle() {
          return {};
        },
      }),
      draftPost: action({
        input: t.object({}),
        output: t.object({}),
        policy: allow('draft:anyone'),
        async handle() {
          return {};
        },
      }),
    });

    const facts = devPolicyMatrix();
    // "who can reach this?" has an answer for a public action too, and the honest answer is
    // everyone — dropping the row would read as a capability nobody has.
    expect(cell(facts, 'draft:anyone', 'anonymous')).toBe(true);
    expect(cell(facts, 'draft:anyone', 'admin')).toBe(true);
    expect(cell(facts, 'post:publish', 'anonymous')).toBe(false);
  });

  test('an app with no registered primitives answers an empty matrix, not a throw', () => {
    expect(devPolicyMatrix()).toEqual([]);
  });
});
