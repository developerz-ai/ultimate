import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceFile } from './app-boundaries';
import {
  appImportGraph,
  checkAppBoundaries,
  checkImportRules,
  readAppSources,
  resolveSpecifier,
} from './app-boundaries';

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
    // Every fix is a line a caller can paste: a command first, the rest behind a `#`.
    expect(findings[0]?.fix).toStartWith('x g query orders');
  });

  test('a service may not know about HTTP', () => {
    const findings = checkImportRules([
      file('apps/web/app/orders/service.ts', "import { request } from '@ultimat3/http';"),
    ]);
    expect(findings[0]?.code).toBe('X_BOUNDARY_SERVICE_TO_HTTP');
    expect(findings[0]?.fix).toStartWith('x g action orders');
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

describe('unit · readAppSources / appImportGraph', () => {
  const root = join(import.meta.dir, '..', '.app-boundaries-fixture');

  beforeAll(async () => {
    await rm(root, { recursive: true, force: true });
    await Bun.write(
      join(root, 'apps/web/site/page.tsx'),
      "import { Button } from '../shared/ui/button';\n",
    );
    await Bun.write(
      join(root, 'apps/web/shared/ui/button.tsx'),
      'export const Button = () => null;\n',
    );
    await Bun.write(join(root, 'apps/web/app/orders/repo.ts'), "import { db } from '@acme/db';\n");
    // A test file living under a surface must never be treated as app source.
    await Bun.write(
      join(root, 'apps/web/app/orders/repo.test.ts'),
      "import { repo } from './repo';\n",
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('readAppSources reads every surface file and skips *.test.ts', async () => {
    const files = await readAppSources(root);
    const paths = files.map((entry) => entry.path).sort();
    expect(paths).toEqual([
      'apps/web/app/orders/repo.ts',
      'apps/web/shared/ui/button.tsx',
      'apps/web/site/page.tsx',
    ]);
    const page = files.find((entry) => entry.path === 'apps/web/site/page.tsx');
    expect(page?.source).toContain('shared/ui/button');
  });

  test('appImportGraph resolves specifiers onto the files readAppSources returned', async () => {
    const graph = appImportGraph(await readAppSources(root));
    expect(graph.get('apps/web/site/page.tsx')?.map((ref) => ref.file)).toEqual([
      'apps/web/shared/ui/button.tsx',
    ]);
    expect(graph.get('apps/web/app/orders/repo.ts')?.map((ref) => ref.file)).toEqual(['@acme/db']);
  });

  test('checkAppBoundaries is readAppSources + checkImportRules, not a second file walk', async () => {
    const files = await readAppSources(root);
    expect(checkImportRules(files)).toEqual(await checkAppBoundaries(root));
  });
});
