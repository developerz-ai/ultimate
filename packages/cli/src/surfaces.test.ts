import { describe, expect, test } from 'bun:test';
import type { SourceFile } from './surfaces';
import { checkSurfaceRules, surfaceOf } from './surfaces';

const file = (path: string, source: string): SourceFile => ({ path, source });

describe('unit · app boundaries', () => {
  test('site/ importing app/ is a build error, not a warning', () => {
    const findings = checkSurfaceRules([
      file('apps/web/site/pricing/page.tsx', "import { Chart } from '../../app/charts';"),
    ]);
    expect(findings.map((finding) => finding.code)).toEqual(['X_BOUNDARY_SITE_TO_APP']);
    expect(findings[0]?.at).toBe('apps/web/site/pricing/page.tsx');
    expect(findings[0]?.fix.length).toBeGreaterThan(0);
  });

  test('shared/ is a leaf: it may not import a surface', () => {
    const findings = checkSurfaceRules([
      file('apps/web/shared/ui/button.tsx', "import { useSession } from '../../app/session';"),
    ]);
    expect(findings[0]?.code).toBe('X_BOUNDARY_SHARED_LEAF');
  });

  test('app/ may import api/ types but not api/ values', () => {
    const typeOnly = checkSurfaceRules([
      file('apps/web/app/orders/page.tsx', "import type { Order } from '../../api/orders';"),
    ]);
    expect(typeOnly).toEqual([]);
    const runtime = checkSurfaceRules([
      file('apps/web/app/orders/page.tsx', "import { placeOrder } from '../../api/orders';"),
    ]);
    expect(runtime[0]?.code).toBe('X_BOUNDARY_APP_TO_API');
  });

  test('a route may not touch the database', () => {
    const findings = checkSurfaceRules([
      file('apps/web/app/orders/page.tsx', "import { db } from '@acme/db';"),
    ]);
    expect(findings[0]?.code).toBe('X_BOUNDARY_ROUTE_TO_DB');
    expect(findings[0]?.fix).toContain('x g query');
  });

  test('a service may not know about HTTP', () => {
    const findings = checkSurfaceRules([
      file('apps/web/app/orders/service.ts', "import { request } from '@ultimat3/http';"),
    ]);
    expect(findings[0]?.code).toBe('X_BOUNDARY_SERVICE_TO_HTTP');
  });

  test('a legal import graph produces no findings', () => {
    expect(
      checkSurfaceRules([
        file('apps/web/site/page.tsx', "import { Button } from '../shared/ui/button';"),
        file('apps/web/app/orders/repo.ts', "import { db } from '@acme/db';"),
      ]),
    ).toEqual([]);
  });

  test('surfaceOf reads the surface out of a path', () => {
    expect(surfaceOf('apps/web/site/page.tsx')).toBe('site');
    expect(surfaceOf('packages/domain/src/index.ts')).toBe('unknown');
  });
});
