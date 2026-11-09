// Who the pass runs a primitive as: an actor that holds the grant is chosen even when its
// predicate cannot pass on an empty input, refusal by design needs nobody to hold it, a job's
// worker is nobody, and an actor named as a row takes a seeded row's id.

import { describe, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import type { NamedActor } from '@ultimat3/policy';
import { can, definePermissions, testActor } from '@ultimat3/policy';
import { asSeededRow, chooseActor } from './exercise-actor';
import { testName } from './test-types';

// Declared here, never left to another file: the permission set is one per process, and once
// any file declares one, `can()` refuses a name nobody declared (X_PERMISSION_UNKNOWN) — so in
// one process, which file was imported first decided whether this one loaded.
definePermissions(['exa:write', 'exa:admin']);

const grants = (tenant: string): readonly NamedActor[] => [
  { name: 'anonymous', actor: null },
  testActor('writer', { permissions: ['exa:write'], orgId: tenant }),
];
// A row rule: false on the empty input `x policy explain` evaluates with.
const rowRule = can<{ readonly id?: string }>('exa:write', ({ input }) => input.id !== undefined);

describe(testName('unit', 'chooseActor'), () => {
  test('a holder of the grant is chosen when only the row rule says no', () => {
    const choice = chooseActor(rowRule, ['exa:write'], grants, 't1', undefined);
    expect(choice).toMatchObject({ kind: 'actor', name: 'writer' });
  });

  test('nobody holding the grant is refused by design', () => {
    const choice = chooseActor(can('exa:admin'), ['exa:admin'], grants, 't1', undefined);
    expect(choice.kind).toBe('refused');
  });

  test('a job drains as nobody, as a served worker does', () => {
    expect(chooseActor(undefined, [], grants, 't1', undefined)).toMatchObject({ actor: null });
  });

  test('an override actor is moved into the tenant', () => {
    const choice = chooseActor(rowRule, [], grants, 't9', { actor: userActor({ id: 'a' }) });
    expect(choice.kind === 'actor' && choice.actor?.orgId).toBe('t9');
  });
});

describe(testName('unit', 'asSeededRow'), () => {
  test('an actor takes the id of a seeded row in its tenant, one carrying its role first', () => {
    const rows = {
      entity: { $name: 'members', $primaryKey: ['id'] },
      rows: [
        { tenant: 't1', row: { id: 'm-author', role: 'author' } },
        { tenant: 't1', row: { id: 'm-owner', role: 'owner' } },
        { tenant: 't2', row: { id: 'm-elsewhere', role: 'owner' } },
      ],
    };
    const owner = userActor({ id: 'owner', roles: ['owner'] });
    expect(asSeededRow(owner, 't1', rows)?.id).toBe('m-owner');
    expect(asSeededRow(null, 't1', rows)).toBeNull();
  });
});

describe(testName('unit', 'asSeededRow · a user column'), () => {
  test("with `column`, the actor's id is the row's user, not the row's own key", () => {
    const rows = {
      entity: { $name: 'memberships', $primaryKey: ['id'] },
      column: 'userId',
      rows: [
        { tenant: 't1', row: { id: 'ms-1', userId: 'u-member', role: 'member' } },
        { tenant: 't1', row: { id: 'ms-2', userId: 'u-owner', role: 'owner' } },
      ],
    };
    const owner = userActor({ id: 'owner', roles: ['owner'] });
    expect(asSeededRow(owner, 't1', rows)?.id).toBe('u-owner');
  });

  test('a composite key with a user column still binds', () => {
    const rows = {
      entity: { $name: 'members', $primaryKey: ['orgId', 'userId'] },
      column: 'userId',
      rows: [{ tenant: 't1', row: { orgId: 't1', userId: 'u-1' } }],
    };
    expect(asSeededRow(userActor({ id: 'x' }), 't1', rows)?.id).toBe('u-1');
  });
});
