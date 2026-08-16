import { describe, expect, test } from 'bun:test';
import { assertBudgets, checkBudgets, parseBytes } from './budgets';
import { SEO_ERROR_CODES } from './errors';
import type { RouteRecord } from './routes';

const ROUTES: RouteRecord[] = [
  {
    path: '/',
    file: 'apps/web/site/page.tsx',
    surface: 'site',
    render: 'static',
    budget: { js: '40kb', lcp: 2000 },
  },
  {
    path: '/dashboard',
    file: 'apps/web/app/dashboard/page.tsx',
    surface: 'app',
    render: 'stream',
    budget: { js: 200_000 },
  },
];

describe('parseBytes', () => {
  test('accepts size strings and raw byte counts', () => {
    expect(parseBytes('40kb')).toBe(40960);
    expect(parseBytes('1mb')).toBe(1_048_576);
    expect(parseBytes('512')).toBe(512);
    expect(parseBytes(2048)).toBe(2048);
  });

  test('an unparseable size is a typed throw, not NaN', () => {
    expect(() => parseBytes('lots')).toThrow();
  });
});

describe('checkBudgets', () => {
  test('passes when every measurement is within budget', () => {
    const report = checkBudgets(ROUTES, [{ route: '/', js: 39_000, lcp: 1800, cls: 0.02 }]);
    expect(report).toEqual({ ok: true, checked: 1, violations: [] });
  });

  test('fails over the limit and names the route file and overage', () => {
    const report = checkBudgets(ROUTES, [{ route: '/', js: 51_200, lcp: 2400 }]);
    expect(report.ok).toBe(false);
    expect(report.violations).toHaveLength(2);
    const js = report.violations.find((violation) => violation.metric === 'js');
    expect(js).toEqual({
      route: '/',
      file: 'apps/web/site/page.tsx',
      metric: 'js',
      limit: 40960,
      actual: 51_200,
      overBy: 10_240,
      unit: 'b',
    });
  });

  test('Core Web Vitals defaults apply when a route declares no explicit limit', () => {
    const report = checkBudgets(ROUTES, [{ route: '/dashboard', cls: 0.3, inp: 150 }]);
    expect(report.violations.map((violation) => violation.metric)).toEqual(['cls']);
  });

  test('unmeasured routes are not counted as checked', () => {
    expect(checkBudgets(ROUTES, []).checked).toBe(0);
  });

  test('assertBudgets throws X_SEO_BUDGET_EXCEEDED with an analyze command', () => {
    const report = checkBudgets(ROUTES, [{ route: '/', js: 51_200 }]);
    try {
      assertBudgets(report);
      throw new Error('expected a throw');
    } catch (error) {
      const err = error as { code?: string; fix?: string; cause?: string };
      expect(err.code).toBe(SEO_ERROR_CODES.budgetExceeded);
      // No command: `x analyze` does not exist. Both halves of the repair are edits, and the
      // one that needs a number carries it.
      expect(err.fix).toContain('raise budget.js');
      expect(err.fix).toContain('apps/web/site/page.tsx');
      expect(err.cause).toContain('apps/web/site/page.tsx');
    }
  });
});
