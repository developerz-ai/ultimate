// Pin derived documentation-count parsing: a changed inventory must leave neither stale prose nor
// a declared path whose prose escaped its claim regex green, while the repository corpus remains a
// valid current-prose baseline.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no `Bun.*` equivalent for a throwaway directory and its removal.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import {
  checkDerivedDocCounts,
  type DerivedDocCounts,
  deriveDocCounts,
  derivedDocCountFindingFor,
  derivedDocCountFindings,
} from './derived-doc-counts';
import { readDocPages } from './doc-commands';

const COUNTS: DerivedDocCounts = { components: 99, seamRows: 26, pipelineStages: 15 };

/** The components `packages/ui/CATALOG.md` prints — the inventory the guard has to derive. */
const catalogComponents = async (root: string): Promise<number> => {
  const catalog = await Bun.file(`${root}/packages/ui/CATALOG.md`).text();
  const line = catalog.split('\n').find((text) => /^\d+ components:/.test(text));
  if (line === undefined) return expect.unreachable('the UI catalog prints no component line');
  return [...line.matchAll(/`[^`]+`/g)].length;
};

const validPages = [
  { path: 'docs/idea/16-app-targets.md', text: '99 source-derived UI components' },
  { path: 'wiki/Home.md', text: '26 seam rows are shipped\n99 source-derived UI components' },
  {
    path: 'llms.txt',
    text: '15 ordered stages\n26 seam rows are shipped\n99 source-derived UI components',
  },
  { path: 'docs/architecture/README.md', text: '15 ordered stages' },
  { path: 'docs/idea/README.md', text: '24 of the 26 seam rows are shipped' },
];

describe('derived documentation counts', () => {
  test('accepts current component, seam-row, and pipeline claims', () => {
    expect(checkDerivedDocCounts(validPages, COUNTS)).toEqual([]);
  });

  test('reports each stale inventory claim', () => {
    const gaps = checkDerivedDocCounts(
      validPages.map((page) => ({ ...page, text: page.text.replace(/99|26|15/g, '1') })),
      COUNTS,
    );
    expect(gaps.map((gap) => gap.kind).sort()).toEqual([
      'components',
      'components',
      'components',
      'pipelineStages',
      'pipelineStages',
      'seamRows',
      'seamRows',
      'seamRows',
    ]);
    for (const gap of gaps) {
      expect(derivedDocCountFindingFor(gap, COUNTS).code).toBe('X_DERIVED_DOC_COUNT_STALE');
    }
  });

  test('refuses a vacuous scan per declared kind and path', () => {
    const gaps = checkDerivedDocCounts([], COUNTS);
    expect(gaps.map((gap) => [gap.kind, gap.at]).sort()).toEqual([
      ['components', 'docs/idea/16-app-targets.md'],
      ['components', 'llms.txt'],
      ['components', 'wiki/Home.md'],
      ['pipelineStages', 'docs/architecture/README.md'],
      ['pipelineStages', 'llms.txt'],
      ['seamRows', 'docs/idea/README.md'],
      ['seamRows', 'llms.txt'],
      ['seamRows', 'wiki/Home.md'],
    ]);
    for (const gap of gaps) {
      expect(derivedDocCountFindingFor(gap, COUNTS).code).toBe('X_DERIVED_DOC_COUNT_UNSCANNED');
    }
  });

  test('reports UNSCANNED at a declared path whose phrasing escapes its claim regex', () => {
    const escaped = validPages.map((page) =>
      page.path === 'wiki/Home.md'
        ? {
            ...page,
            text: page.text.replace(
              '99 source-derived UI components',
              '99 source-derived `@ultimat3/ui` components',
            ),
          }
        : page,
    );
    const gaps = checkDerivedDocCounts(escaped, COUNTS);
    expect(gaps).toEqual([{ kind: 'components', at: 'wiki/Home.md' }]);
    for (const gap of gaps) {
      expect(derivedDocCountFindingFor(gap, COUNTS).code).toBe('X_DERIVED_DOC_COUNT_UNSCANNED');
    }
  });

  test('derives the repository inventories from their executable sources', async () => {
    const root = `${import.meta.dir}/..`;
    const counts = await deriveDocCounts(root);
    expect(counts).toEqual(COUNTS);
    // The component count is the inventory the UI catalog prints, not a count of the files.
    expect(counts.components).toBe(await catalogComponents(root));
  });

  test('derives the component inventory, not the files that hold it', async () => {
    // One file may export two components and another none, so the two counts differ the moment
    // a component is added or removed. A file count would answer 1 for the pair below, and 2
    // once the helper file joins it.
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-derived-components-'));
    try {
      const components = `${dir}/packages/ui/src/components`;
      await mkdir(components, { recursive: true });
      await Bun.write(
        `${components}/Pair.tsx`,
        'export function A(props: AProps) {}\nexport function B(props: BProps) {}\n',
      );
      expect((await deriveDocCounts(dir)).components).toBe(2);
      await Bun.write(
        `${components}/helper.tsx`,
        'export function helper(props: HelperProps) {}\n',
      );
      expect((await deriveDocCounts(dir)).components).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('accepts the current repository prose corpus', async () => {
    const root = `${import.meta.dir}/..`;
    expect(checkDerivedDocCounts(await readDocPages(root), await deriveDocCounts(root))).toEqual(
      [],
    );
  });

  test('a root without the sources derives zero and convicts loudly, never throws', async () => {
    // The HostCheck seam (`frameworkFiles`) runs this rule over fixture roots too: the ENOENT class
    // — a Glob scan or a `.text()` through a missing source — once crashed the whole manifest step
    // instead of reporting. Absent sources derive zero; every declared claim then reads UNSCANNED.
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-derived-docs-'));
    try {
      await Bun.write(join(dir, 'wiki/Notices.md'), 'nothing derived lives here\n');
      expect(await deriveDocCounts(dir)).toEqual({
        components: 0,
        seamRows: 0,
        pipelineStages: 0,
      });
      const findings = await derivedDocCountFindings(dir);
      expect(findings.map((finding) => finding.code)).toEqual(
        Array.from({ length: 8 }, () => 'X_DERIVED_DOC_COUNT_UNSCANNED'),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
