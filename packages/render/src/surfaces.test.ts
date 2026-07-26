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

  test('assertSurfaceBoundary is a build error, not a warning', () => {
    const graph = importGraph({
      'apps/web/site/index.tsx': ['apps/web/app/heavy.tsx'],
    });
    expect(() => assertSurfaceBoundary(graph)).toThrow(SurfaceBoundaryError);
    expect(() => assertSurfaceBoundary(importGraph({}))).not.toThrow();
  });
});
