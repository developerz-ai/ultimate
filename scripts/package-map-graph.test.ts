// The enforcement half of `scripts/package-map-graph.ts`: this file IS the build error. The gate's
// `unit` step is a bare `bun test` from the repo root, so it is collected with no extra wiring and
// the gate stays at 19 steps. The real page is asserted NON-VACUOUSLY and MUTATED in a scratch
// copy — a parser that read nothing would report "no unbacked arrows", which is the answer a
// correct page gives.

import { describe, expect, test } from 'bun:test';
// why: `node:` — Bun has neither a temporary-directory nor a path-join primitive of its own.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
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

describe('the `## Every package` table, the second prose copy', () => {
  const body = ['graph TD', '  render --> cache'];
  const drawn = [workspace('render', ['cache']), workspace('cache', [])];

  test('a publishable package with a node but NO table row is reported', () => {
    // The exact shape that shipped: `scraping` was on the graph and absent from the table, so the
    // presence rule beside this one passed while the table stayed wrong.
    const workspaces = [...drawn, { ...workspace('scraping', []), tier: 5 }];
    const findings = checkPackageMapGraph({
      markdown: pageWith(
        workspaces,
        [...body, '  scraping --> core'],
        ['| `render` | 0 | what it owns |', '| `cache` | 0 | what it owns |'],
      ),
      workspaces: [...workspaces, workspace('core', [])],
    });
    const missing = findings.filter((one) => one.cause.includes('carries no row'));
    expect(missing).toHaveLength(2);
    expect(missing[0]?.code).toBe(STALE);
    expect(missing.map((one) => one.cause).join(' ')).toContain('@ultimat3/scraping publishes');
  });

  test('a row whose tier disagrees with the executable table is reported, at its line', () => {
    const workspaces = [{ ...workspace('render', ['cache']), tier: 4 }, workspace('cache', [])];
    const findings = checkPackageMapGraph({
      markdown: pageWith(workspaces, body, [
        '| `render` | 5 | what it owns |',
        '| `cache` | 0 | what it owns |',
      ]),
      workspaces,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('puts render at tier 5');
    expect(findings[0]?.cause).toContain('puts it at 4');
    expect(findings[0]?.at).toBe(`${PACKAGE_MAP}:10`);
  });

  test('a tier cell that qualifies itself reads its number — `unlisted (6)`', () => {
    const workspaces = [{ ...workspace('render', ['cache']), tier: 6 }, workspace('cache', [])];
    expect(
      checkPackageMapGraph({
        markdown: pageWith(workspaces, body, [
          '| `render` | unlisted (6) | what it owns |',
          '| `cache` | 0 | what it owns |',
        ]),
        workspaces,
      }),
    ).toEqual([]);
  });

  test('a tier cell stating no number at all is reported rather than assumed', () => {
    const findings = checkPackageMapGraph({
      markdown: pageWith(drawn, body, [
        '| `render` | — | what it owns |',
        '| `cache` | 0 | what it owns |',
      ]),
      workspaces: drawn,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('no stated tier');
  });

  test('a row for a directory that is no workspace names the typo', () => {
    const findings = checkPackageMapGraph({
      markdown: pageWith(drawn, body, [
        '| `render` | 0 | what it owns |',
        '| `cache` | 0 | what it owns |',
        '| `cach` | 0 | a row nothing backs |',
      ]),
      workspaces: drawn,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('packages/cach is not a workspace');
  });

  test('a renamed heading is UNSCANNED, never a clean page', () => {
    // Without this the rule reads zero rows and every check above passes over nothing — which is
    // the vacuity this file exists to refuse.
    const findings = checkPackageMapGraph({
      markdown: pageWith(drawn, body).replace('## Every package', '## All the packages'),
      workspaces: drawn,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe(UNSCANNED);
    expect(findings[0]?.cause).toContain('no `## Every package` table row');
  });

  test('rows under a LATER heading are not counted as package rows', () => {
    // The table ends where the next `## ` begins; a table further down the page describes
    // something else and must not satisfy this rule.
    const findings = checkPackageMapGraph({
      markdown: [
        fence('mermaid', body),
        '',
        '## Every package',
        '',
        '| Package | Tier | Responsibility |',
        '|---|---|---|',
        '| `render` | 0 | what it owns |',
        '',
        '## Something else',
        '',
        '| `cache` | 0 | a row in a different table |',
      ].join('\n'),
      workspaces: drawn,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('@ultimat3/cache publishes');
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

  test('a manifest that will not parse is a finding that names the FILE, not the cwd', () => {
    const findings = checkPackageMapGraph({
      markdown: fence('mermaid', ['graph TD', '  render --> cache']),
      workspaces: [],
      unreadable: ['packages/render/package.json'],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe(UNSCANNED);
    expect(findings[0]?.at).toBe('packages/render/package.json');
    expect(findings[0]?.fix).toContain('packages/render/package.json');
  });

  /**
   * The half no unit test could reach: `listWorkspaces` reads every manifest FIRST, and its
   * rejection came out of the top of the script — exit 1 with a stack trace, no `ok`, no `code`,
   * nothing under `--json`. A scratch tree with one broken file is the only way to ask.
   */
  test('a broken manifest on disk is a structured finding, not an unhandled rejection', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'ultimate-bad-manifest-'));
    try {
      await Bun.write(
        join(scratch, 'packages/render/package.json'),
        '{ "name": "@ultimat3/render", ',
      );
      await Bun.write(
        join(scratch, 'packages/cache/package.json'),
        '{ "name": "@ultimat3/cache", "version": "1.0.0" }',
      );
      await Bun.write(join(scratch, PACKAGE_MAP), fence('mermaid', ['graph TD', '  a --> b']));
      const read = await readGraphWorkspaces(scratch);
      expect(read.unreadable).toEqual(['packages/render/package.json']);
      const findings = await packageMapGraphFindings(scratch);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe(UNSCANNED);
      expect(findings[0]?.at).toBe('packages/render/package.json');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  /**
   * Valid JSON that is not a manifest. It parses, so `listWorkspaces` is happy and the old cast to
   * `RawManifest` would have read `.dependencies` off an array — `undefined`, i.e. "declares no
   * dependency", turning every arrow out of that package into an unbacked one.
   */
  test('a manifest that parses to a non-object is unreadable, not a package with no deps', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'ultimate-non-object-manifest-'));
    try {
      await Bun.write(join(scratch, 'packages/render/package.json'), '[]');
      await Bun.write(
        join(scratch, 'packages/cache/package.json'),
        '{ "name": "@ultimat3/cache", "version": "1.0.0" }',
      );
      const read = await readGraphWorkspaces(scratch);
      expect(read.unreadable).toEqual(['packages/render/package.json']);
      expect(read.workspaces.map((one) => one.dir)).toEqual(['cache']);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

describe('the real tree', () => {
  test('every arrow the package map draws is a declared dependency', async () => {
    expect(await packageMapGraphFindings(ROOT)).toEqual([]);
  });

  test('non-vacuous: the page really does draw a graph of the real workspaces', async () => {
    const graph = readPackageGraph(await Bun.file(join(ROOT, PACKAGE_MAP)).text());
    const { workspaces, unreadable } = await readGraphWorkspaces(ROOT);
    expect(unreadable).toEqual([]);
    const dirs = new Set(workspaces.map((one) => one.dir));
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
      for (const one of (await readGraphWorkspaces(ROOT)).workspaces) {
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
