import { describe, expect, test } from 'bun:test';
import { SEO_ERROR_CODES } from './errors';
import type { RouteRecord } from './routes';
import { assertMeta, type ValidateMetaOptions, validateMeta } from './validate';

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

  test('a titleTemplate with no %s slot is a build error naming the file', () => {
    // Without the slot the template cannot place the title, so every page in the app renders the
    // brand as its <title> — and the duplicate-title check is the only thing that would ever
    // notice, weeks later, in Search Console.
    const report = validateMeta([
      route({
        path: '/about',
        file: 'apps/web/site/about/page.tsx',
        meta: {
          title: 'About',
          description: 'Who we are and what we ship.',
          titleTemplate: 'Ultimate',
        },
      }),
    ]);
    expect(report.ok).toBe(false);
    const issue = report.issues[0];
    expect(issue?.code).toBe(SEO_ERROR_CODES.metaMissing);
    expect(issue?.file).toBe('apps/web/site/about/page.tsx');
    expect(issue?.cause).toContain('%s');
    expect(issue?.fix).toContain('%s — Ultimate');
  });

  test('a titleTemplate that has the slot is not an issue', () => {
    const report = validateMeta([
      route({
        path: '/about',
        file: 'apps/web/site/about/page.tsx',
        meta: {
          title: 'About',
          description: 'Who we are and what we ship.',
          titleTemplate: '%s — Ultimate',
        },
      }),
    ]);
    expect(report.ok).toBe(true);
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

  test('an over-length description is flagged against the default 160-character bound', () => {
    const report = validateMeta([
      route({
        path: '/long',
        file: 'site/long/page.tsx',
        meta: { title: 'Long', description: 'D'.repeat(161) },
      }),
    ]);
    expect(report.ok).toBe(false);
    const issue = report.issues.find((entry) => entry.code === SEO_ERROR_CODES.metaTooLong);
    expect(issue?.cause).toContain('161-character description');
    expect(issue?.cause).toContain('truncate past 160');
    expect(issue?.fix).toBe('shorten meta.description in site/long/page.tsx to <= 160 characters');
  });

  test('descriptionMaxLength overrides the default bound in both directions', () => {
    const meta = { title: 'Long', description: 'D'.repeat(161) };
    const routes = [route({ path: '/long', file: 'site/long/page.tsx', meta })];
    const loose = validateMeta(routes, { descriptionMaxLength: 200 });
    expect(loose.issues.filter((e) => e.code === SEO_ERROR_CODES.metaTooLong)).toEqual([]);
    const tight = validateMeta(routes, { descriptionMaxLength: 10 });
    expect(tight.issues.find((e) => e.code === SEO_ERROR_CODES.metaTooLong)?.cause).toContain(
      'truncate past 10',
    );
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

/**
 * A ceiling is only ever read as `length > ceiling`, and that comparison is false for every string
 * when the ceiling is `NaN` — so `validateMeta(routes, { titleMaxLength: Number(process.env.X) })`
 * with the variable unset reported a clean site whose every title is truncated in the SERP. A rule
 * whose comparison can never fire is not a loose rule, it is no rule.
 */
describe('the length ceilings are screened before anything is compared against them', () => {
  const LONG = route({
    path: '/long',
    file: 'apps/web/site/long/page.tsx',
    meta: { title: 'x'.repeat(200), description: 'y'.repeat(400) },
  });

  const refusedFor = (options: Record<string, number>): string => {
    try {
      validateMeta([LONG], options);
    } catch (error) {
      return String(error);
    }
    return 'no-error-thrown';
  };

  test.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5])(
    'refuses titleMaxLength %p, naming it',
    (titleMaxLength) => {
      const rendered = refusedFor({ titleMaxLength });
      expect(rendered).toContain('X_INVARIANT');
      expect(rendered).toContain('titleMaxLength');
    },
  );

  test.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5])(
    'refuses descriptionMaxLength %p, naming it',
    (descriptionMaxLength) => {
      const rendered = refusedFor({ descriptionMaxLength });
      expect(rendered).toContain('X_INVARIANT');
      expect(rendered).toContain('descriptionMaxLength');
    },
  );

  test('a real ceiling still reports the over-long title it is there to catch', () => {
    const report = validateMeta([LONG], { titleMaxLength: 60 });
    expect(report.ok).toBe(false);
  });
});

/**
 * The mirror of the ceiling above, and the reason `??` is the wrong default beside a guard: it
 * coalesces on `null` as well as `undefined`, so an explicit `null` — what a decoded JSON config
 * carries for a key someone blanked, and what a JavaScript caller passes for "no value" — was
 * swapped for the default BEFORE `finiteCount` could see it. One half of the bug lets a non-number
 * past the guard; this half lets it past the default, and both end in a bound nobody chose.
 */
describe('an explicitly null ceiling is refused, never defaulted', () => {
  const LONG = route({
    path: '/long',
    file: 'apps/web/site/long/page.tsx',
    meta: { title: 'x'.repeat(200), description: 'y'.repeat(400) },
  });

  test.each(['titleMaxLength', 'descriptionMaxLength'])('%s: null names itself', (option) => {
    // Parsed rather than written: `null` is not in the option's type, and the caller this is
    // about is a config file that reached the process as JSON.
    const options: ValidateMetaOptions = JSON.parse(`{"${option}":null}`);
    let rendered = 'no-error-thrown';
    try {
      validateMeta([LONG], options);
    } catch (error) {
      rendered = String(error);
    }
    expect(rendered).toContain('X_INVARIANT');
    expect(rendered).toContain(option);
  });
});
