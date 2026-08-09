import { describe, expect, test } from 'bun:test';
import type { SourceFile } from './app-boundaries';
import { checkImportRules, resolveSpecifier } from './app-boundaries';

const file = (path: string, source: string): SourceFile => ({ path, source });

describe('unit · app boundaries', () => {
  test('site/ importing app/ is a build error, not a warning', () => {
    const findings = checkImportRules([
      file('apps/web/site/pricing/page.tsx', "import { Chart } from '../../app/charts';"),
    ]);
    expect(findings.map((finding) => finding.code)).toEqual(['X_BOUNDARY_SITE_TO_APP']);
    expect(findings[0]?.at).toBe('apps/web/site/pricing/page.tsx');
    expect(findings[0]?.fix.length).toBeGreaterThan(0);
  });

  test('shared/ is a leaf: it may not import a surface', () => {
    const findings = checkImportRules([
      file('apps/web/shared/ui/button.tsx', "import { useSession } from '../../app/session';"),
    ]);
    expect(findings[0]?.code).toBe('X_BOUNDARY_SHARED_LEAF');
  });

  test('app/ may import api/ types but not api/ values', () => {
    const typeOnly = checkImportRules([
      file('apps/web/app/orders/page.tsx', "import type { Order } from '../../api/orders';"),
    ]);
    expect(typeOnly).toEqual([]);
    const runtime = checkImportRules([
      file('apps/web/app/orders/page.tsx', "import { placeOrder } from '../../api/orders';"),
    ]);
    expect(runtime[0]?.code).toBe('X_BOUNDARY_APP_TO_API');
  });

  test('a route may not touch the database', () => {
    const findings = checkImportRules([
      file('apps/web/app/orders/page.tsx', "import { db } from '@acme/db';"),
    ]);
    expect(findings[0]?.code).toBe('X_BOUNDARY_ROUTE_TO_DB');
    expect(findings[0]?.fix).toContain('x g query');
  });

  test('a service may not know about HTTP', () => {
    const findings = checkImportRules([
      file('apps/web/app/orders/service.ts', "import { request } from '@ultimat3/http';"),
    ]);
    expect(findings[0]?.code).toBe('X_BOUNDARY_SERVICE_TO_HTTP');
  });

  test('a legal import graph produces no findings', () => {
    expect(
      checkImportRules([
        file('apps/web/site/page.tsx', "import { Button } from '../shared/ui/button';"),
        file('apps/web/app/orders/repo.ts', "import { db } from '@acme/db';"),
      ]),
    ).toEqual([]);
  });

  // The upgrade over the CLI's own former check: the import that costs you is two hops away
  // from the file anyone reviewed, and a direct-imports-only walk finds nothing.
  test('a transitive site/ -> shared/ -> app/ chain is caught, and the chain is named', () => {
    const findings = checkImportRules([
      file('apps/web/site/pricing.tsx', "import { Price } from '../shared/price';"),
      file('apps/web/shared/price.ts', "import { rate } from '../app/rates';"),
      file('apps/web/app/rates.ts', 'export const rate = 1;'),
    ]);
    const codes = findings.map((finding) => finding.code);
    expect(codes).toContain('X_BOUNDARY_SITE_TO_APP');
    expect(codes).toContain('X_BOUNDARY_SHARED_LEAF');
    const chained = findings.find((finding) => finding.code === 'X_BOUNDARY_SITE_TO_APP');
    expect(chained?.cause).toContain('apps/web/site/pricing.tsx');
    expect(chained?.cause).toContain('apps/web/app/rates.ts');
    expect(chained?.at).toBe('apps/web/shared/price.ts');
  });

  test('a specifier resolves onto the graph key it names, extension and all', () => {
    const keys = new Set(['apps/web/shared/price.ts', 'apps/web/shared/ui/index.tsx']);
    expect(resolveSpecifier('apps/web/site/page.tsx', '../shared/price', keys)).toBe(
      'apps/web/shared/price.ts',
    );
    expect(resolveSpecifier('apps/web/site/page.tsx', '../shared/ui', keys)).toBe(
      'apps/web/shared/ui/index.tsx',
    );
    expect(resolveSpecifier('apps/web/site/page.tsx', '@ultimat3/http', keys)).toBe(
      '@ultimat3/http',
    );
  });
});
