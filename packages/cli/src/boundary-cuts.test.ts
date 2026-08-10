// planBoundaryCuts, exercised directly over hand-built graphs — no disk I/O, so these pin the
// plan's shape without going through the CLI command or a fixture app at all.

import { describe, expect, test } from 'bun:test';
import { importGraph } from '@ultimat3/render';
import { planBoundaryCuts } from './boundary-cuts';

describe('unit · planBoundaryCuts', () => {
  test('a direct site/ -> app/ import with no shared/ hop names the edge, no split attempted', () => {
    const graph = importGraph({
      'apps/web/site/page.tsx': ['apps/web/app/widget.ts'],
      'apps/web/app/widget.ts': [],
    });
    const cuts = planBoundaryCuts('apps/web/site/page.tsx', graph);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]?.rule).toBe('site-imports-app');
    expect(cuts[0]?.edge).toEqual({ from: 'apps/web/site/page.tsx', to: 'apps/web/app/widget.ts' });
    expect(cuts[0]?.split).toBeNull();
    expect(cuts[0]?.edit).toBe(
      'delete the import of apps/web/app/widget.ts in apps/web/site/page.tsx',
    );
  });

  test('a violation whose chain never touches the target is not returned', () => {
    const graph = importGraph({
      'apps/web/site/page.tsx': ['apps/web/app/widget.ts'],
      'apps/web/app/widget.ts': [],
      'apps/web/site/other.tsx': [],
    });
    expect(planBoundaryCuts('apps/web/site/other.tsx', graph)).toEqual([]);
  });

  test('app/ -> api/ at runtime reuses the typed-client fix as the edit, no split attempted', () => {
    const graph = importGraph({
      'apps/web/app/orders/page.tsx': ['apps/web/api/orders.ts'],
      'apps/web/api/orders.ts': [],
    });
    const cuts = planBoundaryCuts('apps/web/app/orders/page.tsx', graph);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]?.rule).toBe('app-imports-api-at-runtime');
    expect(cuts[0]?.split).toBeNull();
    expect(cuts[0]?.edit).toContain('import type');
  });

  test('a shared/ module reached through another shared/ hop still resolves to the one real surface', () => {
    const graph = importGraph({
      'apps/web/app/page.tsx': ['apps/web/shared/outer.ts'],
      'apps/web/shared/outer.ts': ['apps/web/shared/inner.ts'],
      'apps/web/shared/inner.ts': ['apps/web/app/detail.ts'],
      'apps/web/app/detail.ts': [],
    });
    const cuts = planBoundaryCuts('apps/web/shared/inner.ts', graph);
    expect(cuts).toHaveLength(1);
    const split = cuts[0]?.split;
    expect(split?.surface).toBe('app');
    expect(split?.to).toBe('apps/web/app/inner.ts');
    expect(split?.command).toBe('git mv apps/web/shared/inner.ts apps/web/app/inner.ts');
    // outer.ts holds the specifier to inner.ts, not page.tsx — only outer.ts needs an edit.
    expect(split?.importers).toEqual(['apps/web/shared/outer.ts']);
  });

  test('the same shared/ module reached by app/ and site/ produces two cuts for one edge, neither a split', () => {
    const graph = importGraph({
      'apps/web/app/dashboard.tsx': ['apps/web/shared/panel.tsx'],
      'apps/web/site/promo.tsx': ['apps/web/shared/panel.tsx'],
      'apps/web/shared/panel.tsx': ['apps/web/app/charts.ts'],
      'apps/web/app/charts.ts': [],
    });
    const cuts = planBoundaryCuts('apps/web/shared/panel.tsx', graph);
    expect(cuts).toHaveLength(2);
    expect(new Set(cuts.map((cut) => cut.rule))).toEqual(
      new Set(['shared-is-a-leaf', 'site-imports-app']),
    );
    for (const cut of cuts) {
      expect(cut.edge).toEqual({ from: 'apps/web/shared/panel.tsx', to: 'apps/web/app/charts.ts' });
      expect(cut.split).toBeNull();
      expect(cut.edit).not.toContain('git mv');
    }
  });
});
