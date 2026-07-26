import { describe, expect, test } from 'bun:test';
import { id, orgId, table, text } from './columns';
import {
  assertScoped,
  describePlan,
  emptyPlan,
  hasOrgPredicate,
  isOrgScoped,
  orgScoped,
} from './tenancy';

const posts = table('posts', { id: id(), orgId: orgId(), title: text() });
const settings = table('settings', { id: id(), key: text() });

describe('detection', () => {
  test('an orgId column is what makes an entity tenant-scoped', () => {
    expect(isOrgScoped(posts)).toBe(true);
    expect(isOrgScoped(settings)).toBe(false);
  });
});

describe('assertScoped', () => {
  test('throws X_TENANCY_UNSCOPED for a scoped entity queried without an org', () => {
    expect(() => assertScoped('post', posts, 'findMany', emptyPlan('post'))).toThrow(
      /X_TENANCY_UNSCOPED|org predicate/,
    );
  });

  test('the fix line names the call that has to change', () => {
    try {
      assertScoped('post', posts, 'findMany', emptyPlan('post'));
      throw new Error('expected a throw');
    } catch (error) {
      expect(String((error as { fix?: string }).fix)).toContain('orgScoped(');
    }
  });

  test('passes once the org predicate is present', () => {
    const plan = orgScoped(emptyPlan('post'), 'org-1');
    expect(hasOrgPredicate(plan)).toBe(true);
    expect(() => assertScoped('post', posts, 'findMany', plan)).not.toThrow();
  });

  test('an unscoped entity is never forced to carry an org', () => {
    expect(() => assertScoped('setting', settings, 'findMany', emptyPlan('setting'))).not.toThrow();
  });
});

describe('orgScoped', () => {
  test('adds the predicate exactly once', () => {
    const once = orgScoped(emptyPlan('post'), 'org-1');
    const twice = orgScoped(once, 'org-1');
    expect(twice.where).toHaveLength(1);
    expect(twice.where[0]).toEqual({ column: 'orgId', op: 'eq', value: 'org-1' });
  });

  test('a plan is safe to log: values are elided', () => {
    const rendered = describePlan(orgScoped(emptyPlan('post'), 'secret-org'));
    expect(rendered).toContain('where orgId eq ?');
    expect(rendered).not.toContain('secret-org');
  });
});
