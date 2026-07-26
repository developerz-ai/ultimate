import { afterAll, describe, expect, test } from 'bun:test';
import { text, uuid } from './columns';
import { entity } from './entity';
import { clearRegistry } from './registry';
import {
  assertScoped,
  describePlan,
  emptyPlan,
  hasOrgPredicate,
  isOrgScoped,
  orgScoped,
  tenantColumnOf,
} from './tenancy';

const posts = entity('tenancy_test_posts', {
  columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), title: text() },
});

const settings = entity('tenancy_test_settings', {
  columns: { id: uuid().primaryKey(), key: text() },
});

afterAll(() => {
  clearRegistry();
});

describe('detection', () => {
  test('a tenant column is what makes an entity tenant-scoped', () => {
    expect(isOrgScoped(posts.$columns)).toBe(true);
    expect(isOrgScoped(settings.$columns)).toBe(false);
    expect(tenantColumnOf(posts.$columns)).toBe('orgId');
  });

  test('a column named orgId counts even without .tenant()', () => {
    const comments = entity('tenancy_test_comments', {
      columns: { id: uuid().primaryKey(), orgId: uuid() },
    });
    expect(comments.$tenantColumn).toBe('orgId');
  });
});

describe('assertScoped', () => {
  test('throws X_TENANCY_UNSCOPED for a scoped entity queried without an org', () => {
    expect(() => assertScoped('post', 'orgId', 'findMany', emptyPlan('post'))).toThrow(
      /X_TENANCY_UNSCOPED|org predicate/,
    );
  });

  test('the fix line names the call that has to change', () => {
    try {
      assertScoped('post', 'orgId', 'findMany', emptyPlan('post'));
      throw new Error('expected a throw');
    } catch (error) {
      expect(String((error as { fix?: string }).fix)).toContain('orgScoped(');
    }
  });

  test('passes once the org predicate is present', () => {
    const plan = orgScoped(emptyPlan('post'), 'org-1');
    expect(hasOrgPredicate(plan)).toBe(true);
    expect(() => assertScoped('post', 'orgId', 'findMany', plan)).not.toThrow();
  });

  test('an unscoped entity is never forced to carry an org', () => {
    expect(() => assertScoped('setting', null, 'findMany', emptyPlan('setting'))).not.toThrow();
  });
});

describe('orgScoped', () => {
  test('adds the predicate exactly once', () => {
    const twice = orgScoped(orgScoped(emptyPlan('post'), 'org-1'), 'org-1');
    expect(twice.where).toHaveLength(1);
    expect(twice.where[0]).toEqual({ column: 'orgId', op: 'eq', value: 'org-1' });
  });

  test('a plan is safe to log: values are elided', () => {
    const rendered = describePlan(orgScoped(emptyPlan('post'), 'secret-org'));
    expect(rendered).toContain('where orgId eq ?');
    expect(rendered).not.toContain('secret-org');
  });
});
