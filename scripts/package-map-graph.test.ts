// The enforcement half of `scripts/package-map-graph.ts`: this file IS the build error. The gate's
// `unit` step is a bare `bun test` from the repo root, so it is collected with no extra wiring and
// the gate stays at 19 steps. The real page is asserted NON-VACUOUSLY and MUTATED in a scratch
// copy — a parser that read nothing would report "no unbacked arrows", which is the answer a
// correct page gives.

import { describe, expect, test } from 'bun:test';
// `node:` — Bun has neither a temporary-directory nor a path-join primitive of its own.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './lib/run';
import type { GraphWorkspace } from './package-map-graph';
import {
  checkPackageMapGraph,
  cleanMermaid,
  mermaidLines,
  PACKAGE_MAP,
  packageMapGraphFindings,
  readGraphWorkspaces,
  readPackageGraph,
} from './package-map-graph';

const STALE = 'X_DOC_PACKAGE_GRAPH_STALE';
const UNSCANNED = 'X_DOC_PACKAGE_GRAPH_UNSCANNED';

const ROOT = repoRoot();

const TICKS = '```';
const fence = (info: string, body: readonly string[]): string =>
  [`${TICKS}${info}`, ...body, TICKS].join('\n');

const workspace = (dir: string, deps: readonly string[]): GraphWorkspace => ({
  dir,
  name: `@ultimat3/${dir}`,
  version: '6.0.0',
  private: false,
  tier: 0,
  deps: deps.map((name) => `@ultimat3/${name}`),
});

describe('what counts as an arrow', () => {
  test('prose outside the fence is not one — the page writes two wrong edges as examples', () => {
    const markdown = [
      'an arrow that is drawn is real: a `render --> query` and a `ui --> render` sat here.',
      '<!-- a stray html comment --> still ends in an arrow',
      fence('mermaid', ['graph TD', '  render --> cache']),
    ].join('\n');
    const graph = readPackageGraph(markdown);
    expect(graph.edges).toEqual([{ from: 'render', to: 'cache', line: 5 }]);
  });

  test('a ```mermaid nested inside a wider fence is content, never a second graph', () => {
    const markdown = fence('`markdown', [fence('mermaid', ['graph TD', '  ui --> render'])]);
    const graph = readPackageGraph(markdown);
    expect(graph.blocks).toBe(0);
    expect(graph.edges).toEqual([]);
  });

  test('an arrow inside a node label or a %% comment is not an edge', () => {
    const graph = readPackageGraph(
      fence('mermaid', [
        'graph TD',
        '  cli["cli --> everything"]',
        '  %% render --> query was deleted',
        '  cli --> render',
      ]),
    );
    expect(graph.edges).toEqual([{ from: 'cli', to: 'render', line: 5 }]);
    expect(graph.nodes.has('cli')).toBe(true);
  });

  test('a subgraph body declares nodes without drawing any edge', () => {
    const graph = readPackageGraph(
      fence('mermaid', ['graph TD', '  subgraph T1["tier 1"]', '    i18n; money; time', '  end']),
    );
    expect([...graph.nodes].sort()).toEqual(['i18n', 'money', 'time']);
    expect(graph.edges).toEqual([]);
  });

  test('a link operator this rule cannot read is reported, never skipped', () => {
    const graph = readPackageGraph(fence('mermaid', ['graph TD', '  a -.-> b', '  c --> d']));
    expect(graph.unreadable.map((one) => one.line)).toEqual([3]);
  });

  test('cleanMermaid keeps the node name and drops the label', () => {
    expect(cleanMermaid('  create-ultimate["create-ultimate (unlisted)"]')).toBe('create-ultimate');
  });

  test('mermaidLines counts the blocks it opened', () => {
    const markdown = [fence('mermaid', ['graph TD']), fence('ts', ['const a = 1;'])].join('\n');
    expect(mermaidLines(markdown).blocks).toBe(1);
  });
});

describe('the rule', () => {
  const page = fence('mermaid', ['graph TD', '  render --> cache', '  cache --> core']);

  test('an arrow no package.json backs is X_DOC_PACKAGE_GRAPH_STALE, at its line', () => {
    const findings = checkPackageMapGraph({
      markdown: page,
      workspaces: [workspace('render', ['cache']), workspace('cache', []), workspace('core', [])],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe(STALE);
    expect(findings[0]?.at).toBe(`${PACKAGE_MAP}:4`);
    expect(findings[0]?.fix).toContain('packages/cache/package.json');
  });

  test('an arrow every package.json backs is silence', () => {
    expect(
      checkPackageMapGraph({
        markdown: page,
        workspaces: [
          workspace('render', ['cache']),
          workspace('cache', ['core']),
          workspace('core', []),
        ],
      }),
    ).toEqual([]);
  });

  test('an endpoint that is no workspace names the typo rather than the dependency', () => {
    const findings = checkPackageMapGraph({
      markdown: fence('mermaid', ['graph TD', '  render --> cach']),
      workspaces: [workspace('render', ['cache'])],
    });
    expect(findings[0]?.cause).toContain('packages/cach is not a workspace');
  });

  test('a publishable package with no node is reported — scraping sat off the map', () => {
    const findings = checkPackageMapGraph({
      markdown: fence('mermaid', ['graph TD', '  render --> cache']),
      workspaces: [
        workspace('render', ['cache']),
        workspace('cache', []),
        { ...workspace('scraping', []), tier: 5 },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('@ultimat3/scraping publishes');
    expect(findings[0]?.fix).toContain('tier-5 subgraph');
  });

  test('a private workspace is not required on the graph', () => {
    expect(
      checkPackageMapGraph({
        markdown: fence('mermaid', ['graph TD', '  render --> cache']),
        workspaces: [
          workspace('render', ['cache']),
          workspace('cache', []),
          { ...workspace('dummy', []), private: true },
        ],
      }),
    ).toEqual([]);
  });

  test('the reverse is deliberately not checked: a dependency need not be drawn', () => {
    expect(
      checkPackageMapGraph({
        markdown: fence('mermaid', ['graph TD', '  render --> cache']),
        workspaces: [workspace('render', ['cache', 'core', 'seo']), workspace('cache', [])],
      }),
    ).toEqual([]);
  });
});

describe('a rule with no input fails rather than passes', () => {
  test('an unreadable page is X_DOC_PACKAGE_GRAPH_UNSCANNED', () => {
    const findings = checkPackageMapGraph({
      markdown: undefined,
      workspaces: [workspace('a', [])],
    });
    expect(findings[0]?.code).toBe(UNSCANNED);
  });

  test('a page with no mermaid block is unscanned, not clean', () => {
    const findings = checkPackageMapGraph({
      markdown: '# package map\n\nno graph here.\n',
      workspaces: [workspace('a', [])],
    });
    expect(findings[0]?.code).toBe(UNSCANNED);
    expect(findings[0]?.cause).toContain('0 ```mermaid block(s)');
  });

  test('no workspace manifest read is unscanned — every arrow would look unbacked', () => {
    const findings = checkPackageMapGraph({ markdown: '```mermaid\n```', workspaces: [] });
    expect(findings[0]?.code).toBe(UNSCANNED);
    expect(findings[0]?.at).toBe('scripts/package-map-graph.ts');
  });
});

describe('the real tree', () => {
  test('every arrow the package map draws is a declared dependency', async () => {
    expect(await packageMapGraphFindings(ROOT)).toEqual([]);
  });

  test('non-vacuous: the page really does draw a graph of the real workspaces', async () => {
    const graph = readPackageGraph(await Bun.file(join(ROOT, PACKAGE_MAP)).text());
    const dirs = new Set((await readGraphWorkspaces(ROOT)).map((one) => one.dir));
    expect(graph.blocks).toBe(1);
    expect(graph.edges.length).toBeGreaterThan(40);
    expect(graph.unreadable).toEqual([]);
    for (const node of graph.nodes) expect(dirs.has(node)).toBe(true);
  });

  /**
   * The mutation proof. A scratch copy of the real page gains one fabricated arrow; the guard must
   * name it at its own line, against the real manifests. The repository's own copy is hashed before
   * and after, because a check that edits the tree it audits is worse than no check.
   */
  test('a fabricated arrow in a scratch copy is caught at its line, and the real page is untouched', async () => {
    const source = join(ROOT, PACKAGE_MAP);
    const before = Bun.SHA256.hash(await Bun.file(source).bytes(), 'hex');
    const original = await Bun.file(source).text();
    const scratch = await mkdtemp(join(tmpdir(), 'ultimate-package-map-'));
    try {
      for (const one of await readGraphWorkspaces(ROOT)) {
        await Bun.write(
          join(scratch, 'packages', one.dir, 'package.json'),
          await Bun.file(join(ROOT, 'packages', one.dir, 'package.json')).text(),
        );
      }
      // `seo` declares `core` and nothing else, so `seo --> money` is an arrow no manifest backs.
      const lines = original.split('\n');
      const anchor = lines.findIndex((line) => line.trim() === 'seo --> core');
      expect(anchor).toBeGreaterThan(-1);
      lines.splice(anchor + 1, 0, '  seo --> money');
      await Bun.write(join(scratch, PACKAGE_MAP), lines.join('\n'));

      const findings = await packageMapGraphFindings(scratch);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe(STALE);
      expect(findings[0]?.at).toBe(`${PACKAGE_MAP}:${String(anchor + 2)}`);
      expect(findings[0]?.cause).toContain('declares no dependency on @ultimat3/money');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    expect(Bun.SHA256.hash(await Bun.file(source).bytes(), 'hex')).toBe(before);
    expect(await Bun.file(source).text()).toBe(original);
  });
});
