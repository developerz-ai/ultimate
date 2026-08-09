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

  test('neither a tenant column nor an orgId column leaves the entity unscoped', () => {
    expect(settings.$tenantColumn).toBeNull();
    expect(settings.$describe().orgScoped).toBe(false);
  });
});

describe('an explicitly declared tenant', () => {
  test('names the column itself, and beats both inference rules', () => {
    const docs = entity('tenancy_test_docs', {
      tenant: 'workspaceId',
      columns: {
        id: uuid().primaryKey(),
        // Neither marked nor conventionally named — the declaration is the whole switch.
        workspaceId: uuid(),
        orgId: uuid(),
        title: text(),
      },
    });
    expect(docs.$tenantColumn).toBe('workspaceId');
    expect(docs.$describe().orgScoped).toBe(true);
    expect(tenantColumnOf(docs.$columns)).toBe('orgId');
  });

  test('naming a column that does not exist is a declaration error', () => {
    // `tsc` already refuses the key; the cast is what a JS caller or a renamed column looks like.
    const withRenamedColumn = () =>
      entity('tenancy_test_broken', {
        tenant: 'notAColumn' as 'id',
        columns: { id: uuid().primaryKey(), workspaceId: uuid() },
      });
    try {
      withRenamedColumn();
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('X_INVARIANT_VIOLATED');
      // The cause lists the columns, so the fix is readable without opening the file.
      expect(String((error as { cause?: string }).cause)).toContain('workspaceId');
    }
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
