// The enforcement half of `scripts/package-map-graph.ts`: this file IS the build error. The gate's
// `unit` step is a bare `bun test` from the repo root, so it is collected with no extra wiring and
// the gate stays at 19 steps. The real page, asserted NON-VACUOUSLY and mutated in a scratch copy,
// is `package-map-graph-table.test.ts`'s; this file holds the parser and the rule.

import { describe, expect, test } from 'bun:test';
import type { GraphWorkspace } from './package-map-graph';
import {
  checkPackageMapGraph,
  cleanMermaid,
  mermaidLines,
  PACKAGE_MAP,
  readPackageGraph,
} from './package-map-graph';

const STALE = 'X_DOC_PACKAGE_GRAPH_STALE';

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

/**
 * A page carrying BOTH halves the rule reads — the mermaid fence and the `## Every package` table.
 * Every arrow fixture needs the table now, because a page with no table is itself a finding: the
 * table went unread for two majors and `scraping` fell out of it, so an absent table can no longer
 * mean "not under test here".
 */
const pageWith = (
  workspaces: readonly GraphWorkspace[],
  body: readonly string[],
  rows?: readonly string[],
): string =>
  [
    fence('mermaid', body),
    '',
    '## Every package',
    '',
    '| Package | Tier | Responsibility |',
    '|---|---|---|',
    ...(rows ??
      workspaces
        .filter((one) => !one.private)
        .map((one) => `| \`${one.dir}\` | ${String(one.tier)} | what it owns |`)),
  ].join('\n');

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

  /**
   * The five forms an enumeration of link operators missed. Each is a valid mermaid link, so each
   * DRAWS an arrow for a reader; each fell through to the node scan and left no trace at all, which
   * is how a `render === query` could sit on the page under a green gate.
   */
  test.each([
    ['a thick link', '  render === query'],
    ['a longer thick link', '  render ====== query'],
    ['a dotted link of length 2', '  render -..- query'],
    ['a dotted link of length 3', '  render -...- query'],
    ['a dotted ARROW of length 2', '  render -..-> query'],
    ['a dotted link carrying text', '  render -. why .-> query'],
    ['a thick arrow', '  render ==> query'],
    ['a cross link', '  render --x query'],
  ])('%s is reported, never dropped in silence', (_label, line) => {
    const graph = readPackageGraph(fence('mermaid', ['graph TD', line, '  c --> d']));
    expect(graph.unreadable.map((one) => one.line)).toEqual([3]);
    expect(graph.edges).toEqual([{ from: 'c', to: 'd', line: 4 }]);
  });

  test('a hyphenated node name is not a link — one dash is a name, two are an operator', () => {
    const graph = readPackageGraph(
      fence('mermaid', ['graph TD', '  create-ultimate', '  create-ultimate --> cli']),
    );
    expect(graph.unreadable).toEqual([]);
    expect(graph.nodes.has('create-ultimate')).toBe(true);
  });

  test('a directive is read as a directive, never as an unparseable edge', () => {
    const graph = readPackageGraph(
      fence('mermaid', [
        'graph TD',
        '  classDef pinned stroke-dasharray: 5--5',
        '  linkStyle 0 stroke:#333',
        '  a --> b',
      ]),
    );
    expect(graph.unreadable).toEqual([]);
    expect(graph.edges).toHaveLength(1);
  });

  test('cleanMermaid keeps the node name and drops the label', () => {
    expect(cleanMermaid('  create-ultimate["create-ultimate (unlisted)"]')).toBe('create-ultimate');
  });

  test('mermaidLines counts the blocks it opened', () => {
    const markdown = [fence('mermaid', ['graph TD']), fence('ts', ['const a = 1;'])].join('\n');
    expect(mermaidLines(markdown).blocks).toBe(1);
  });
});

const BACKED = [
  workspace('render', ['cache']),
  workspace('cache', ['core']),
  workspace('core', []),
];
const PRIVATE_TOO = [
  workspace('render', ['cache']),
  workspace('cache', []),
  { ...workspace('dummy', []), private: true },
];
const ABRIDGED = [workspace('render', ['cache', 'core', 'seo']), workspace('cache', [])];

describe('the rule', () => {
  const body = ['graph TD', '  render --> cache', '  cache --> core'];

  test('an arrow no package.json backs is X_DOC_PACKAGE_GRAPH_STALE, at its line', () => {
    const workspaces = [
      workspace('render', ['cache']),
      workspace('cache', []),
      workspace('core', []),
    ];
    const findings = checkPackageMapGraph({ markdown: pageWith(workspaces, body), workspaces });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe(STALE);
    expect(findings[0]?.at).toBe(`${PACKAGE_MAP}:4`);
    expect(findings[0]?.fix).toContain('packages/cache/package.json');
  });

  test('an arrow every package.json backs is silence', () => {
    expect(
      checkPackageMapGraph({
        markdown: pageWith(BACKED, body),
        workspaces: BACKED,
      }),
    ).toEqual([]);
  });

  test('an endpoint that is no workspace names the typo rather than the dependency', () => {
    const workspaces = [workspace('render', ['cache'])];
    const findings = checkPackageMapGraph({
      markdown: pageWith(workspaces, ['graph TD', '  render --> cach']),
      workspaces,
    });
    expect(findings[0]?.cause).toContain('packages/cach is not a workspace');
  });

  test('a publishable package with no node is reported — scraping sat off the map', () => {
    const workspaces = [
      workspace('render', ['cache']),
      workspace('cache', []),
      { ...workspace('scraping', []), tier: 5 },
    ];
    const findings = checkPackageMapGraph({
      markdown: pageWith(workspaces, ['graph TD', '  render --> cache']),
      workspaces,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('@ultimat3/scraping publishes');
    expect(findings[0]?.fix).toContain('tier-5 subgraph');
  });

  test('a private workspace is not required on the graph', () => {
    expect(
      checkPackageMapGraph({
        markdown: pageWith(PRIVATE_TOO, ['graph TD', '  render --> cache']),
        workspaces: PRIVATE_TOO,
      }),
    ).toEqual([]);
  });

  test('the reverse is deliberately not checked: a dependency need not be drawn', () => {
    expect(
      checkPackageMapGraph({
        markdown: pageWith(ABRIDGED, ['graph TD', '  render --> cache']),
        workspaces: ABRIDGED,
      }),
    ).toEqual([]);
  });
});
