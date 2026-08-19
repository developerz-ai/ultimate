// The operation table, read as data by three surfaces. Its two load-bearing rows: `delete` is the
// only destructive operation (so it is the only one that demands a confirmation token), and every
// operation is audited — there is no "just a read" here.

import { describe, expect, test } from 'bun:test';
import {
  ADMIN_DESTROY,
  ADMIN_OPERATIONS,
  ADMIN_READ,
  ADMIN_WRITE,
  type AdminOperation,
  adminPermissionFor,
  confirmationToken,
  entityPermissionFor,
  isDestructive,
  ruleFor,
} from './permissions';

describe('ruleFor', () => {
  test('every operation has a rule, and every rule is audited', () => {
    for (const op of ADMIN_OPERATIONS) {
      const rule = ruleFor(op);
      // `audited: true` is a literal type, not a flag anyone can turn off — pinned so a future
      // `audited: boolean` cannot quietly ship a read that logs nothing.
      expect(rule.audited).toBe(true);
      expect(rule.labelKey).toBe(`admin.operation.${op}`);
      expect(rule.permission).toBe(adminPermissionFor(op));
      expect(rule.destructive).toBe(isDestructive(op));
    }
  });

  test('the admin-level gate escalates read → write → destroy across the six operations', () => {
    const byOp = Object.fromEntries(
      ADMIN_OPERATIONS.map((op) => [op, ruleFor(op).permission]),
    ) as Record<AdminOperation, string>;
    expect(byOp).toEqual({
      list: ADMIN_READ,
      detail: ADMIN_READ,
      search: ADMIN_READ,
      create: ADMIN_WRITE,
      update: ADMIN_WRITE,
      delete: ADMIN_DESTROY,
    });
  });

  test('delete is the only destructive operation', () => {
    expect(ADMIN_OPERATIONS.filter(isDestructive)).toEqual(['delete']);
  });
});

describe('entityPermissionFor', () => {
  test('the three read operations share one entity permission', () => {
    expect(entityPermissionFor('post', 'list')).toBe('post:read');
    expect(entityPermissionFor('post', 'detail')).toBe('post:read');
    expect(entityPermissionFor('post', 'search')).toBe('post:read');
  });

  test('create and update share the write permission, and delete has its own', () => {
    expect(entityPermissionFor('post', 'create')).toBe('post:write');
    expect(entityPermissionFor('post', 'update')).toBe('post:write');
    // NOT `post:write`: a grant that lets an operator edit must not also let them destroy.
    expect(entityPermissionFor('post', 'delete')).toBe('post:delete');
  });
});

describe('confirmationToken', () => {
  test('it is the record’s own id, which an agent cannot guess', () => {
    expect(confirmationToken('post', 'p_1')).toBe('post:p_1');
  });

  test('two rows of the same entity never share a token', () => {
    expect(confirmationToken('post', 'p_1')).not.toBe(confirmationToken('post', 'p_2'));
  });

  test('a global action with no row still has a token shape', () => {
    expect(confirmationToken('admin', '')).toBe('admin:');
  });
});
