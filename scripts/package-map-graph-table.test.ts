// The package map's second prose copy — the `## Every package` table — held to the tree, a rule
// with no input failing rather than passing, and the real tree. Split from package-map-graph.test.ts.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: `node:` — Bun has neither a temporary-directory nor a path-join primitive of its own.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import type { GraphWorkspace } from './package-map-graph';
import {
  checkPackageMapGraph,
  PACKAGE_MAP,
  packageMapGraphFindings,
  readGraphWorkspaces,
  readPackageGraph,
} from './package-map-graph';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

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
