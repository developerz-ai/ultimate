// A `can()` built at MODULE scope before the app's `definePermissions` module loaded had nothing to
// check its name against, so it was let through — and if the name was not in the set the app then
// declared, every actor was denied with no word why, in whichever test-file orders imported the
// rule first. The check is now made again where the rule is first decided, once a set exists.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { evaluate } from './evaluate';
import { clearPermissions, definePermissions } from './permissions';
import { can } from './policy';
import type { Actor } from './roles';
import { clearRoles, defineRoles } from './roles';

const codeOf = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    return isUltimateError(error) ? error.code : `not coded: ${String(error)}`;
  }
  return 'no refusal';
};

const member: Actor = { id: 'u1', kind: 'user', roles: ['member'], scopes: [], permissions: [] };

beforeEach(() => {
  clearPermissions();
  clearRoles();
});
afterEach(() => {
  clearPermissions();
  clearRoles();
});

describe('can() built before the permission set', () => {
  test('a name the set later lacks is X_PERMISSION_UNKNOWN when decided, not a silent deny', () => {
    const early = can('post:raed' as never);
    definePermissions(['post:read']);
    defineRoles({ member: { grants: ['post:read'] } });
    expect(codeOf(() => evaluate(early, { input: {}, actor: member }))).toBe(
      'X_PERMISSION_UNKNOWN',
    );
  });

  test('a name the set later declares decides as usual', () => {
    const early = can('post:read' as never);
    definePermissions(['post:read']);
    defineRoles({ member: { grants: ['post:read'] } });
    expect(evaluate(early, { input: {}, actor: member }).allowed).toBe(true);
  });

  test('with no set ever declared it still decides, as before', () => {
    const early = can('post:read' as never);
    expect(
      evaluate(early, { input: {}, actor: { ...member, permissions: ['post:read'] } }).allowed,
    ).toBe(true);
  });
});
