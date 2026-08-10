// planBoundaryCuts, exercised directly over hand-built graphs — no disk I/O, so these pin the
// plan's shape without going through the CLI command or a fixture app at all. The repair tests
// go one step further: they apply the plan to the sources and re-check the result.

import { describe, expect, test } from 'bun:test';
import { importGraph } from '@ultimat3/render';
import type { SourceFile } from './app-boundaries';
import {
  appImportGraph,
  boundaryCodeOf,
  checkImportRules,
  relativeSpecifier,
  resolveSpecifier,
  scanRuntimeImports,
} from './app-boundaries';
import type { BoundaryCut, SpecifierEdit } from './boundary-cuts';
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
    // outer.ts stays in shared/, so its specifier has to reach one surface over.
    expect(split?.edits).toEqual([
      {
        file: 'apps/web/shared/outer.ts',
        imported: 'apps/web/shared/inner.ts',
        specifier: '../app/inner',
      },
    ]);
    // inner.ts's own `../app/detail` lands on the same file from either sibling surface.
    expect(cuts[0]?.edit).toBe(
      "git mv apps/web/shared/inner.ts apps/web/app/inner.ts   # then in apps/web/shared/outer.ts, apps/web/shared/inner.ts → '../app/inner'",
    );
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

  test('every cut carries the code app-boundaries gives the same violation — one mapping', () => {
    const files: readonly SourceFile[] = [
      file('apps/web/site/page.tsx', "import { Chart } from '../app/charts';"),
      file('apps/web/app/charts.ts', "import { list } from '../api/data';"),
      file('apps/web/api/data.ts', 'export const list = [];'),
      file('apps/web/shared/panel.tsx', "import { Chart } from '../app/charts';"),
    ];
    const graph = appImportGraph(files);
    const byAt = new Map(
      checkImportRules(files).map((finding) => [`${finding.code}|${finding.at}`, finding]),
    );
    const cuts = [
      ...planBoundaryCuts('apps/web/site/page.tsx', graph),
      ...planBoundaryCuts('apps/web/shared/panel.tsx', graph),
      ...planBoundaryCuts('apps/web/app/charts.ts', graph),
    ];
    expect(cuts.length).toBeGreaterThan(2);
    for (const cut of cuts) {
      expect(cut.code).toBe(boundaryCodeOf(cut.rule));
      // `x verify` reported the identical code against the identical file.
      expect(byAt.get(`${cut.code}|${cut.at}`)?.code).toBe(cut.code);
    }
  });
});

const file = (path: string, source: string): SourceFile => ({ path, source });

/**
 * The published plan, actually carried out: every rewrite it named, then the `git mv`. The
 * rewrites run first, while each specifier still resolves from the directory it was written in —
 * an edit against the moved module names it at its destination.
 */
function applyCut(files: readonly SourceFile[], cut: BoundaryCut): readonly SourceFile[] {
  const split = cut.split;
  expect(split).not.toBeNull();
  if (split === null) return files;
  const keys = new Set(files.map((entry) => entry.path));
  const editsIn = (path: string): readonly SpecifierEdit[] =>
    split.edits.filter((edit) => (edit.file === split.to ? split.module : edit.file) === path);
  const rewritten = files.map((entry) => {
    const specifiers = scanRuntimeImports(entry);
    const source = editsIn(entry.path).reduce((text, edit) => {
      const written = specifiers.find(
        (s) => resolveSpecifier(entry.path, s, keys) === edit.imported,
      );
      expect(written).toBeDefined();
      return text.replaceAll(`'${written}'`, `'${edit.specifier}'`);
    }, entry.source);
    return { path: entry.path, source };
  });
  return rewritten.map((entry) =>
    entry.path === split.module ? { path: split.to, source: entry.source } : entry,
  );
}

const unresolved = (files: readonly SourceFile[]): readonly string[] => {
  const keys = new Set(files.map((entry) => entry.path));
  return files.flatMap((entry) =>
    scanRuntimeImports(entry)
      .filter((specifier) => specifier.startsWith('.'))
      .filter((specifier) => !keys.has(resolveSpecifier(entry.path, specifier, keys)))
      .map((specifier) => `${entry.path}: ${specifier}`),
  );
};

describe('unit · the published repair is complete', () => {
  // The move alone renames the file every one of these specifiers points at.
  const files: readonly SourceFile[] = [
    file('apps/s2/app/dashboard.tsx', "import { Panel } from '../shared/panel';\n"),
    file('apps/s2/app/deep/report.tsx', "import { Panel } from '../../shared/panel';\n"),
    file(
      'apps/s2/shared/panel.tsx',
      "import { Chart } from '../app/charts';\nimport { fmt } from './format';\n",
    ),
    file('apps/s2/shared/format.ts', 'export const fmt = String;\n'),
    file('apps/s2/app/charts.ts', 'export const Chart = () => null;\n'),
  ];

  test('the git mv is published with the specifier rewrite every importer needs', () => {
    const cuts = planBoundaryCuts('apps/s2/shared/panel.tsx', appImportGraph(files));
    expect(cuts).toHaveLength(1);
    const split = cuts[0]?.split;
    expect(split?.command).toBe('git mv apps/s2/shared/panel.tsx apps/s2/app/panel.tsx');
    expect(split?.edits).toEqual([
      {
        file: 'apps/s2/app/dashboard.tsx',
        imported: 'apps/s2/shared/panel.tsx',
        specifier: './panel',
      },
      {
        file: 'apps/s2/app/deep/report.tsx',
        imported: 'apps/s2/shared/panel.tsx',
        specifier: '../panel',
      },
      // panel.tsx's own sibling import travels with it and has to reach back into shared/.
      {
        file: 'apps/s2/app/panel.tsx',
        imported: 'apps/s2/shared/format.ts',
        specifier: '../shared/format',
      },
    ]);
    // Every rewrite is in the printed fix, not only in the JSON.
    for (const edit of split?.edits ?? []) expect(cuts[0]?.edit).toContain(`'${edit.specifier}'`);
  });

  test('applying the plan leaves no unresolved import and no boundary finding', () => {
    expect(unresolved(files)).toEqual([]);
    const cuts = planBoundaryCuts('apps/s2/shared/panel.tsx', appImportGraph(files));
    const cut = cuts[0];
    expect(cut).toBeDefined();
    if (cut === undefined) return;
    const repaired = applyCut(files, cut);
    expect(repaired.map((entry) => entry.path)).toContain('apps/s2/app/panel.tsx');
    expect(unresolved(repaired)).toEqual([]);
    expect(checkImportRules(repaired)).toEqual([]);
  });

  test('the move alone — without the published rewrites — would leave the tree broken', () => {
    const movedOnly = files.map((entry) =>
      entry.path === 'apps/s2/shared/panel.tsx'
        ? { path: 'apps/s2/app/panel.tsx', source: entry.source }
        : entry,
    );
    expect(unresolved(movedOnly).length).toBeGreaterThan(0);
  });
});

describe('unit · a site-reachable module is never relocated', () => {
  // site/ → shared/a → shared/b → app/rates: moving b into site/ carries the identical
  // site/ → app/ edge with it, so no automatic cut may be offered.
  const files: readonly SourceFile[] = [
    file('apps/s1/site/pricing.tsx', "import { Price } from '../shared/a';\n"),
    file('apps/s1/shared/a.ts', "import { helper } from './b';\n"),
    file('apps/s1/shared/b.ts', "import { rate } from '../app/rates';\n"),
    file('apps/s1/app/rates.ts', 'export const rate = 1;\n'),
  ];

  test('no cut on the offending module proposes a git mv into site/', () => {
    const cuts = planBoundaryCuts('apps/s1/shared/b.ts', appImportGraph(files));
    expect(cuts.map((cut) => cut.rule).sort()).toEqual(['shared-is-a-leaf', 'site-imports-app']);
    for (const cut of cuts) {
      expect(cut.split).toBeNull();
      expect(cut.edit).not.toContain('git mv');
      expect(cut.edit).not.toContain('apps/s1/site/b.ts');
    }
  });

  test('the manual cut names the file, the import to delete and why no move helps', () => {
    const cuts = planBoundaryCuts('apps/s1/site/pricing.tsx', appImportGraph(files));
    expect(cuts).toHaveLength(1);
    expect(cuts[0]?.rule).toBe('site-imports-app');
    expect(cuts[0]?.edit).toBe(
      'apps/s1/shared/b.ts is reached by site, so relocating it keeps the edge: delete the ' +
        'import of apps/s1/app/rates.ts in apps/s1/shared/b.ts — move what it needs into ' +
        'apps/s1/shared/b.ts, or have the caller pass it in',
    );
  });

  test('the same module reached only by app/ still relocates — the cut that does repair', () => {
    const appReached = files.map((entry) =>
      entry.path === 'apps/s1/site/pricing.tsx'
        ? file('apps/s1/app/pricing.tsx', "import { Price } from '../shared/a';\n")
        : entry,
    );
    const cuts = planBoundaryCuts('apps/s1/shared/b.ts', appImportGraph(appReached));
    expect(cuts).toHaveLength(1);
    expect(cuts[0]?.split?.to).toBe('apps/s1/app/b.ts');
    expect(relativeSpecifier('apps/s1/shared/a.ts', 'apps/s1/app/b.ts')).toBe('../app/b');
    expect(unresolved(applyCut(appReached, cuts[0] as BoundaryCut))).toEqual([]);
  });
});
