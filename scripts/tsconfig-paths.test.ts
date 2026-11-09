// A package subpath export with no `paths` row in tsconfig.base.json resolves for an app (through
// its workspace symlink) and not at the repo root, where `@ultimat3/*` maps it to a directory that
// does not exist: nine `./adapter` subpaths landed in v31 wave D and `scripts/` answered TS2307.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { checkTsconfigPaths, readSubpathExports, tsconfigPathFindingFor } from './tsconfig-paths';

// Reads every package manifest, so it runs on the repo-scan backstop (`REPO_SCAN_TIMEOUT_MS`).
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const exported = [
  { specifier: '@ultimat3/jobs/adapter', target: './packages/jobs/src/adapter.ts' },
];

describe('unit · every subpath export has its paths row', () => {
  test('a subpath export with no row is the finding, and the fix is the row to paste', () => {
    const [gap] = checkTsconfigPaths(exported, {});
    if (gap === undefined) expect.unreachable('a missing row must be a finding');
    const finding = tsconfigPathFindingFor(gap);
    expect(finding.code).toBe('X_TSCONFIG_PATH_MISSING');
    expect(finding.fix).toContain('"@ultimat3/jobs/adapter": ["./packages/jobs/src/adapter.ts"]');
  });

  test('a row naming the export target is clean', () => {
    const paths = { '@ultimat3/jobs/adapter': ['./packages/jobs/src/adapter.ts'] };
    expect(checkTsconfigPaths(exported, paths)).toEqual([]);
  });

  test('a row pointing at a different file is stale', () => {
    const paths = { '@ultimat3/jobs/adapter': ['./packages/jobs/src/old.ts'] };
    const [gap] = checkTsconfigPaths(exported, paths);
    expect(gap?.kind).toBe('stale');
    expect(tsconfigPathFindingFor(gap as never).code).toBe('X_TSCONFIG_PATH_STALE');
  });

  test('a row for a subpath no package exports is stale too; the wildcards are not rows', () => {
    const paths = {
      '@ultimat3/jobs/gone': ['./packages/jobs/src/gone.ts'],
      '@ultimat3/*': ['./packages/*/src'],
      '@ultimat3/ui/icons/*': ['./packages/ui/src/icons/glyphs/*'],
    };
    const kinds = checkTsconfigPaths([], paths).map((gap) => `${gap.kind} ${gap.specifier}`);
    expect(kinds).toEqual(['stale @ultimat3/jobs/gone']);
  });

  test('NO EXPORT READ is a failure, never a pass', async () => {
    expect(tsconfigPathFindingFor({ kind: 'unscanned', specifier: '', target: '' }).code).toBe(
      'X_TSCONFIG_PATHS_UNSCANNED',
    );
  });
});

describe('unit · against this repo', () => {
  test('the subpath exports are read, including the v31 adapters', async () => {
    const found = (await readSubpathExports(repoRoot())).map((one) => one.specifier);
    expect(found).toContain('@ultimat3/core/adapter');
    expect(found).toContain('@ultimat3/entity/adapter');
  });
});
