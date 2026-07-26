import { describe, expect, test } from 'bun:test';
import { SEO_ERROR_CODES } from './errors';
import type { RouteRecord } from './routes';
import { assertMeta, validateMeta } from './validate';

function route(partial: Partial<RouteRecord> & Pick<RouteRecord, 'path' | 'file'>): RouteRecord {
  return { surface: 'site', render: 'static', ...partial };
}

const GOOD = route({
  path: '/pricing',
  file: 'apps/web/site/pricing/page.tsx',
  meta: { title: 'Pricing', description: 'What Ultimate costs and why.' },
});

describe('validateMeta', () => {
  test('a site/ route with no description fails and names the exact file', () => {
    const report = validateMeta([
      route({ path: '/about', file: 'apps/web/site/about/page.tsx', meta: { title: 'About' } }),
    ]);
    expect(report.ok).toBe(false);
    const issue = report.issues[0];
    expect(issue?.code).toBe(SEO_ERROR_CODES.metaMissing);
    expect(issue?.file).toBe('apps/web/site/about/page.tsx');
    expect(issue?.cause).toContain('apps/web/site/about/page.tsx');
    expect(issue?.fix).toBe(
      'add description to defineRoute({ meta }) in apps/web/site/about/page.tsx',
    );
  });

  test('assertMeta throws X_SEO_META_MISSING carrying the same strings', () => {
    const report = validateMeta([route({ path: '/x', file: 'site/x/page.tsx' })]);
    try {
      assertMeta(report);
      throw new Error('expected a throw');
    } catch (error) {
      const err = error as { code?: string; fix?: string; cause?: string };
      expect(err.code).toBe(SEO_ERROR_CODES.metaMissing);
      expect(err.fix).toContain('site/x/page.tsx');
    }
  });

  test('app/ and api/ routes are not SEO-checked', () => {
    const report = validateMeta([
      route({ path: '/dashboard', file: 'apps/web/app/dashboard/page.tsx', surface: 'app' }),
      route({ path: '/rpc', file: 'apps/web/api/rpc.ts', surface: 'api' }),
    ]);
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(0);
  });

  test('a noindex route is skipped', () => {
    const report = validateMeta([
      route({ path: '/legal/draft', file: 'site/legal/draft/page.tsx', noindex: true }),
    ]);
    expect(report.ok).toBe(true);
  });

  test('duplicate titles across routes are flagged with every file', () => {
    const report = validateMeta([
      GOOD,
      route({
        path: '/plans',
        file: 'apps/web/site/plans/page.tsx',
        meta: { title: 'Pricing', description: 'A different description entirely here.' },
      }),
    ]);
    const duplicate = report.issues.find((issue) => issue.code === SEO_ERROR_CODES.duplicateMeta);
    expect(duplicate).toBeDefined();
    expect(duplicate?.cause).toContain('apps/web/site/pricing/page.tsx');
    expect(duplicate?.cause).toContain('apps/web/site/plans/page.tsx');
  });

  test('an over-length title is flagged with the rendered template applied', () => {
    const report = validateMeta([
      route({
        path: '/long',
        file: 'site/long/page.tsx',
        meta: {
          title: 'A'.repeat(58),
          titleTemplate: '%s — Ultimate',
          description: 'Long enough to be a real description for this route.',
        },
      }),
    ]);
    const issue = report.issues.find((entry) => entry.code === SEO_ERROR_CODES.metaTooLong);
    expect(issue?.cause).toContain('69-character title');
  });

  test('a canonical that does not match the route is flagged', () => {
    const report = validateMeta(
      [
        route({
          path: '/pricing',
          file: 'site/pricing/page.tsx',
          meta: { title: 'Pricing', description: 'What Ultimate costs.', canonical: '/plans' },
        }),
      ],
      { baseUrl: 'https://ultimate.dev' },
    );
    const issue = report.issues.find((entry) => entry.code === SEO_ERROR_CODES.canonicalMismatch);
    expect(issue?.cause).toContain('https://ultimate.dev/plans');
    expect(issue?.cause).toContain('https://ultimate.dev/pricing');
  });

  test('a complete route table passes and reports what it checked', () => {
    const report = validateMeta([GOOD], { baseUrl: 'https://ultimate.dev' });
    expect(report).toEqual({ ok: true, checked: 1, issues: [] });
  });
});
