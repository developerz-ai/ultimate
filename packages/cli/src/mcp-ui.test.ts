import { describe, expect, test } from 'bun:test';
import { assertBudgetedRoute, matches } from './mcp-ui';

const ROUTES = [
  { path: '/', file: 'apps/web/site/page.tsx', budgetJs: '0kb' },
  { path: '/dashboard', file: 'apps/web/app/dashboard/page.tsx', budgetJs: '126kb' },
  { path: '/links/:slug', file: 'apps/web/app/links/[slug]/page.tsx', budgetJs: '94kb' },
  { path: '/draft', file: 'apps/web/site/draft/page.tsx', budgetJs: null },
];

describe('unit · ui.shot only photographs a declared, budgeted route', () => {
  test('a param segment matches one path segment, and nothing more', () => {
    expect(matches('/links/:slug', '/links/abc123')).toBe(true);
    expect(matches('/links/:slug', '/links/abc123/edit')).toBe(false);
    expect(matches('/links/:slug', '/links')).toBe(false);
    expect(matches('/', '/')).toBe(true);
    expect(matches('/dashboard', '/dashboards')).toBe(false);
  });

  test('a budgeted route passes, with or without a query string', () => {
    expect(() => assertBudgetedRoute('/dashboard', ROUTES)).not.toThrow();
    expect(() => assertBudgetedRoute('/links/abc123?ref=x', ROUTES)).not.toThrow();
  });

  test('an unknown path is refused by name, with the tool that lists the real ones', () => {
    expect(() => assertBudgetedRoute('/nope', ROUTES)).toThrow(
      expect.objectContaining({ code: 'X_UI_SHOT_ROUTE_UNKNOWN' }),
    );
  });

  test('a route with no budget.js is refused — a picture of a draft judges the wrong thing', () => {
    try {
      assertBudgetedRoute('/draft', ROUTES);
      expect.unreachable('should have refused');
    } catch (error) {
      const refusal = error as { code: string; fix: string; cause: string };
      expect(refusal.code).toBe('X_UI_SHOT_ROUTE_UNBUDGETED');
      expect(refusal.cause).toContain('apps/web/site/draft/page.tsx');
      expect(refusal.fix).toContain('budget: { js:');
    }
  });
});
