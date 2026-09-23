import { describe, expect, test } from 'bun:test';
import { SurfaceBoundaryError } from './errors';
import { assertSurfaceBoundary, checkSurfaceBoundary, importGraph, surfaceOf } from './surfaces';

describe('surfaceOf', () => {
  test('reads the surface out of a monorepo path', () => {
    expect(surfaceOf('apps/web/site/pricing/page.tsx')).toBe('site');
    expect(surfaceOf('apps/web/app/charts/sparkline.tsx')).toBe('app');
    expect(surfaceOf('apps/web/shared/ui/button.tsx')).toBe('shared');
    expect(surfaceOf('packages/domain/index.ts')).toBe(null);
  });
});

describe('checkSurfaceBoundary', () => {
  // The exact failure this prevents: <Button> grows a <Sparkline> that imports a charting
  // library, and the marketing page silently inherits it three hops away.
  test('catches the transitive site/ → app/ import and names both files', () => {
    const graph = importGraph({
      'apps/web/site/pricing/page.tsx': ['apps/web/shared/ui/button.tsx'],
      'apps/web/shared/ui/button.tsx': ['apps/web/app/charts/sparkline.tsx'],
      'apps/web/app/charts/sparkline.tsx': ['node_modules/chart.js/index.js'],
    });

    const violations = checkSurfaceBoundary(graph);
    const siteViolation = violations.find((v) => v.rule === 'site-imports-app');

    expect(siteViolation).toBeDefined();
    expect(siteViolation?.importer).toBe('apps/web/shared/ui/button.tsx');
    expect(siteViolation?.imported).toBe('apps/web/app/charts/sparkline.tsx');
    expect(siteViolation?.entry).toBe('apps/web/site/pricing/page.tsx');
    expect(siteViolation?.chain.join(' → ')).toBe(
      'apps/web/site/pricing/page.tsx → apps/web/shared/ui/button.tsx → apps/web/app/charts/sparkline.tsx',
    );
    expect(siteViolation?.fix).toContain('x fix boundary apps/web/site/pricing/page.tsx');
  });

  test('shared/ is a leaf, so the same graph also reports the shared → app hop', () => {
    const graph = importGraph({
      'apps/web/site/pricing/page.tsx': ['apps/web/shared/ui/button.tsx'],
      'apps/web/shared/ui/button.tsx': ['apps/web/app/charts/sparkline.tsx'],
    });
    expect(checkSurfaceBoundary(graph).map((v) => v.rule)).toEqual([
      'shared-is-a-leaf',
      'site-imports-app',
    ]);
  });

  test('app/ → api/ is types-only: the type edge passes, the value edge fails', () => {
    const typeOnly = importGraph({
      'apps/web/app/reports/page.tsx': [{ file: 'apps/web/api/reports/actions.ts', type: true }],
    });
    expect(checkSurfaceBoundary(typeOnly)).toEqual([]);

    const runtime = importGraph({
      'apps/web/app/reports/page.tsx': ['apps/web/api/reports/actions.ts'],
    });
    expect(checkSurfaceBoundary(runtime)[0]?.rule).toBe('app-imports-api-at-runtime');
  });

  test('a type-only hop does not carry the boundary onward', () => {
    const graph = importGraph({
      'apps/web/site/pricing/page.tsx': [{ file: 'apps/web/shared/ui/types.ts', type: true }],
      'apps/web/shared/ui/types.ts': ['apps/web/app/charts/sparkline.tsx'],
    });
    expect(checkSurfaceBoundary(graph).some((v) => v.rule === 'site-imports-app')).toBe(false);
  });

  /**
   * The report is sorted so a diff of two runs is a diff of the violations, not of the machine —
   * and `localeCompare` with no locale argument answers from the runtime's ICU default locale and
   * collation version, which orders `_` before a digit and a lowercase letter before its
   * uppercase twin. Code units are the only order two machines agree on. Three importers whose
   * names discriminate: code units give `A`, `_a`, `a`; the ICU default gives `_a`, `a`, `A`.
   */
  test('violations are ordered by code unit, so two machines report the same list', () => {
    const graph = importGraph({
      'apps/web/site/A/page.tsx': ['apps/web/app/heavy.tsx'],
      'apps/web/site/_a/page.tsx': ['apps/web/app/heavy.tsx'],
      'apps/web/site/a/page.tsx': ['apps/web/app/heavy.tsx'],
    });
    expect(checkSurfaceBoundary(graph).map((v) => v.importer)).toEqual([
      'apps/web/site/A/page.tsx',
      'apps/web/site/_a/page.tsx',
      'apps/web/site/a/page.tsx',
    ]);
  });

  test('assertSurfaceBoundary is a build error, not a warning', () => {
    const graph = importGraph({
      'apps/web/site/index.tsx': ['apps/web/app/heavy.tsx'],
    });
    expect(() => assertSurfaceBoundary(graph)).toThrow(SurfaceBoundaryError);
    expect(() => assertSurfaceBoundary(importGraph({}))).not.toThrow();
  });
});

// Plan 08 row u: `SURFACE_SPECS.mayImport` / `mayImportTypes` were read by nothing, so api → site,
// site → api and app → site value imports classified as nothing at all. The table is the rule now.
describe('checkSurfaceBoundary derives every edge from SURFACE_SPECS', () => {
  const rulesOf = (
    record: Readonly<Record<string, readonly (string | { file: string; type: boolean })[]>>,
  ) =>
    checkSurfaceBoundary(importGraph(record)).map((v) => `${v.rule} ${v.importer} → ${v.imported}`);

  test('a value import the importer’s mayImport does not list is a violation', () => {
    expect(
      rulesOf({ 'api/hook/route.ts': ['site/home/copy.ts'], 'site/home/copy.ts': [] }),
    ).toEqual(['surface-imports-surface api/hook/route.ts → site/home/copy.ts']);
    expect(rulesOf({ 'app/a/page.tsx': ['site/b/page.tsx'], 'site/b/page.tsx': [] })).toEqual([
      'surface-imports-surface app/a/page.tsx → site/b/page.tsx',
    ]);
  });

  test('the pairs with a rule of their own keep it, so their codes do not move', () => {
    expect(rulesOf({ 'app/a/page.tsx': ['api/x/route.ts'], 'api/x/route.ts': [] })).toEqual([
      'app-imports-api-at-runtime app/a/page.tsx → api/x/route.ts',
    ]);
    expect(rulesOf({ 'shared/x.ts': ['app/y.ts'], 'app/y.ts': [] })).toEqual([
      'shared-is-a-leaf shared/x.ts → app/y.ts',
    ]);
  });

  test('a type import the table allows is clean; one it does not is a violation', () => {
    expect(rulesOf({ 'app/a/page.tsx': [{ file: 'api/x/route.ts', type: true }] })).toEqual([]);
    expect(rulesOf({ 'site/a/page.tsx': [{ file: 'api/x/route.ts', type: true }] })).toEqual([
      'surface-imports-surface site/a/page.tsx → api/x/route.ts',
    ]);
  });

  test('importing within a surface and from shared/ is always clean', () => {
    expect(
      rulesOf({
        'api/a/route.ts': ['api/b/lib.ts', 'shared/x.ts'],
        'api/b/lib.ts': [],
        'shared/x.ts': [],
      }),
    ).toEqual([]);
  });
});
