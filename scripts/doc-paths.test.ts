// The failure case first: a published page that names a repo file which is not there. Then what
// must NOT be one — a placeholder, a line suffix, a `**Historical:**` section, an unchecked fence
// line — and the false green: a glob that reads no page answers "every path resolves" over nothing.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun ships no `Bun.*` equivalent for a throwaway directory and its removal.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import {
  checkDocPaths,
  type DocPathGap,
  docPathFindingFor,
  readPublishedPages,
  skipDocPage,
} from './doc-paths';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { HOST_CHECKS } from './verify';

// Reads the real tree once, so it runs on the repo-scan backstop — see `REPO_SCAN_TIMEOUT_MS`.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const TREE: ReadonlySet<string> = new Set([
  'packages/cli/src/runtime-cache.ts',
  'packages/ui/src/tokens',
  'scripts/doc-paths.ts',
  'docs/idea/13-dx.md',
]);
const exists = (path: string): boolean => TREE.has(path);
const page = (text: string, path = 'wiki/Page.md') => ({ path, text });
const gaps = (text: string): readonly DocPathGap[] =>
  checkDocPaths({ files: [page(text)], exists });
const dead = (text: string): readonly string[] => gaps(text).map((gap) => gap.subject);

describe('a published page that names a path which does not exist', () => {
  test('a dead backticked path is the finding, at its page and line', () => {
    const found = gaps('first line\nwhich `packages/cli/src/dev-cache.ts` calls');
    expect(found).toEqual([
      { kind: 'dead', at: 'wiki/Page.md:2', subject: 'packages/cli/src/dev-cache.ts' },
    ]);
  });

  test('an existing file or directory is not', () => {
    expect(dead('`packages/cli/src/runtime-cache.ts` and `packages/ui/src/tokens/`')).toEqual([]);
  });

  test('every prefix is read: packages/, scripts/ and docs/', () => {
    expect(dead('`scripts/db-gen.ts` · `docs/idea/99-gone.md` · `packages/platform/`')).toEqual([
      'scripts/db-gen.ts',
      'docs/idea/99-gone.md',
      'packages/platform',
    ]);
  });

  test('a path inside a command span is still a path', () => {
    expect(dead('run `bun run scripts/gone.ts --json` first')).toEqual(['scripts/gone.ts']);
    expect(dead('run `bun run scripts/doc-paths.ts --json` first')).toEqual([]);
  });

  test('a line, column or anchor suffix and trailing punctuation are not part of the path', () => {
    expect(
      dead(
        '`packages/cli/src/runtime-cache.ts:42` `packages/cli/src/runtime-cache.ts:4:7` ' +
          '`packages/cli/src/runtime-cache.ts:10-20` `docs/idea/13-dx.md#the-env`, ' +
          '`scripts/doc-paths.ts`.',
      ),
    ).toEqual([]);
  });

  test('a placeholder, a glob or an ellipsis names no one file and is not checked', () => {
    expect(
      dead(
        '`packages/<pkg>/src` `packages/*/CLAUDE.md` `packages/{a,b}/x.ts` `packages/db/…` ' +
          '`scripts/lib/...` `packages/$PKG/x`',
      ),
    ).toEqual([]);
  });

  test('a build output is not checked — a fresh clone has none', () => {
    expect(dead('`packages/ui/dist/index.js` `packages/x/node_modules/y`')).toEqual([]);
  });

  test('two spans on one line naming the same dead path are one finding', () => {
    expect(dead('`scripts/gone.ts` then again `scripts/gone.ts`')).toEqual(['scripts/gone.ts']);
  });

  test('a word that merely starts like a prefix is not a path', () => {
    expect(dead('`subpackages/x.ts` `myscripts/y.ts` `packages` `docs`')).toEqual([]);
  });
});

describe('**Historical:** — a section that records a tree that no longer exists', () => {
  test('exempts from the marker to the next heading, and no further', () => {
    const text = [
      '## The 20.x tree',
      '**Historical:** every path below is the 20.x tree.',
      '| `packages/realtime/src/hooks.ts` |',
      '## Today',
      '`packages/realtime/src/hooks.ts`',
    ].join('\n');
    expect(gaps(text)).toEqual([
      { kind: 'dead', at: 'wiki/Page.md:5', subject: 'packages/realtime/src/hooks.ts' },
    ]);
  });

  test('a path on the marker line itself is exempt', () => {
    expect(dead('**Historical:** `packages/cli/src/dev-sync.ts` was renamed')).toEqual([]);
  });

  test('a `#` line inside a fence is not a heading and does not end the section', () => {
    const text = [
      '**Historical:** the old layout.',
      '```sh',
      '# a shell comment',
      '```',
      '`scripts/old.ts`',
    ].join('\n');
    expect(dead(text)).toEqual([]);
  });

  test('the bare word is not the marker — it must be the bold label', () => {
    expect(dead('Historical. `scripts/old.ts`')).toEqual(['scripts/old.ts']);
  });
});

describe('fenced blocks', () => {
  test('a file-header comment names where the block lives, and is checked', () => {
    const text = ['```ts', '// packages/db/src/backfills.ts', 'export const a = 1;', '```'].join(
      '\n',
    );
    expect(gaps(text)).toEqual([
      { kind: 'dead', at: 'wiki/Page.md:2', subject: 'packages/db/src/backfills.ts' },
    ]);
  });

  test('every comment leader counts: //, /*, # and --', () => {
    const text = [
      '```',
      '/* packages/a.scss */',
      '# scripts/b.sh',
      '-- packages/c.sql',
      '```',
    ].join('\n');
    expect(dead(text)).toEqual(['packages/a.scss', 'scripts/b.sh', 'packages/c.sql']);
  });

  test('any other fenced line is program text or a transcript, and is not read', () => {
    const text = [
      '```text',
      'X_MIGRATION_DESTRUCTIVE: …',
      '  cause: packages/db/migrations/20260814120000_drop.sql drops a column',
      'import { a } from "packages/x/y";',
      '```',
    ].join('\n');
    expect(dead(text)).toEqual([]);
  });

  test('backticks inside a fence are not inline spans', () => {
    expect(dead(['```md', 'see `scripts/gone.ts`', '```'].join('\n'))).toEqual([]);
  });
});

describe('which pages are published', () => {
  test('dated records and the changelog are not', () => {
    expect(skipDocPage('docs/plans/2026/10/04/x/07-cleanup.md')).toBe(true);
    expect(skipDocPage('docs/history/cli.md')).toBe(true);
    expect(skipDocPage('CHANGELOG.md')).toBe(true);
    expect(skipDocPage('packages/x/node_modules/y/README.md')).toBe(true);
  });

  test('the wiki, the current docs, package pages and root pages are', () => {
    for (const path of ['wiki/Testing.md', 'docs/idea/13-dx.md', 'packages/db/CLAUDE.md']) {
      expect(skipDocPage(path)).toBe(false);
    }
    expect(skipDocPage('CLAUDE.md')).toBe(false);
  });

  test('reads every published page of this tree, and the dated ones not at all', async () => {
    const files = await readPublishedPages(repoRoot());
    // Measured 2026-10-05: 185. A floor, not the count — deleting a page must not trip it.
    expect(files.length).toBeGreaterThan(100);
    const paths = files.map((file) => file.path);
    expect(paths).toContain('wiki/Configuration.md');
    expect(paths).toContain('packages/db/CLAUDE.md');
    expect(paths.some((path) => path.startsWith('docs/plans/'))).toBe(false);
  });
});

describe('the false green', () => {
  test('no page read at all is a finding, never a clean answer', () => {
    const found = checkDocPaths({ files: [], exists });
    expect(found.map((gap) => gap.kind)).toEqual(['unscanned']);
    expect(docPathFindingFor(found[0] as DocPathGap).code).toBe('X_CORPUS_UNSCANNED');
  });
});

describe('the finding', () => {
  test('X_DOC_PATH_DEAD names the page, the path, and both ways out', () => {
    const [gap] = gaps('`scripts/gone.ts`');
    const finding = docPathFindingFor(gap as DocPathGap);
    expect(finding.code).toBe('X_DOC_PATH_DEAD');
    expect(finding.at).toBe('wiki/Page.md:1');
    expect(finding.cause).toContain('scripts/gone.ts');
    expect(finding.fix).toStartWith('bun run doc-paths --json');
    expect(finding.fix).toContain('edit wiki/Page.md:1');
    expect(finding.fix).toContain('**Historical:**');
  });
});

describe('the wiring', () => {
  // A rule with a test and no wiring is a rule `bun run verify` never runs.
  test('a dead path is reported through the manifest step', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-doc-paths-'));
    try {
      await Bun.write(join(dir, 'wiki/Page.md'), 'see `packages/cli/src/dev-cache.ts`\n');
      const manifest = HOST_CHECKS.manifest;
      if (manifest === undefined) return expect.unreachable('the manifest step has no host check');
      const codes = (await manifest(dir)).map((finding) => finding.code);
      expect(codes).toContain('X_DOC_PATH_DEAD');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
