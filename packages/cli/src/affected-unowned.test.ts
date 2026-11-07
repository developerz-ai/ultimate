// What a workspace change reaches OUTSIDE the workspace graph: the root's own test directories
// (`scripts/` here), which import packages by relative path and declare no dependency, and the CLI,
// which is the tool every test run goes through. Both were invisible to `x test --affected`.

import { describe, expect, test } from 'bun:test';
import { inScope, planAffected, scopePrefixes } from './affected';
import { unownedDirs } from './affected-unowned';
import type { WorkspaceNode } from './workspace-graph';

const node = (name: string, dir: string, dependencies: readonly string[] = []): WorkspaceNode => ({
  name,
  dir,
  dependencies,
});

const GRAPH: readonly WorkspaceNode[] = [
  node('@ultimat3/core', 'packages/core'),
  node('@ultimat3/db', 'packages/db', ['@ultimat3/core']),
  node('@ultimat3/cli', 'packages/cli', ['@ultimat3/core', '@ultimat3/db']),
  node('@ultimat3/money', 'packages/money'),
  node('@postly/root', 'examples/dummy', ['@ultimat3/cli']),
];

const prefixes = (changed: readonly string[], unowned: readonly string[] = ['scripts']) =>
  scopePrefixes(planAffected(GRAPH, changed, unowned), '/repo', '/repo');

describe('unit · a package change reaches the root tests that import it', () => {
  test('a change in packages/core selects every dependent AND scripts/', () => {
    const plan = planAffected(GRAPH, ['packages/core/src/errors.ts'], ['scripts']);
    expect(plan.workspaces.map((w) => w.name)).toEqual([
      '@postly/root',
      '@ultimat3/cli',
      '@ultimat3/core',
      '@ultimat3/db',
    ]);
    expect(plan.unowned).toEqual(['scripts']);
    expect(inScope('scripts/boundaries.test.ts', prefixes(['packages/core/src/errors.ts']))).toBe(
      true,
    );
  });

  test('a leaf package change still reaches scripts/, and nothing else unrelated', () => {
    const scope = prefixes(['packages/money/src/money.ts']);
    expect(scope).toEqual(['packages/money', 'scripts']);
    expect(inScope('packages/core/src/x.test.ts', scope)).toBe(false);
  });

  test('a doc-only diff selects no workspace, so no root test either', () => {
    const plan = planAffected(GRAPH, ['packages/core/README.md'], ['scripts']);
    expect(plan.unowned).toEqual([]);
    expect(prefixes(['packages/core/README.md'])).toEqual([]);
  });
});

describe('unit · the CLI is the tool, so a change to it runs everything', () => {
  test('a change under packages/cli is root-wide', () => {
    const plan = planAffected(GRAPH, ['packages/cli/src/cmd-test.ts'], ['scripts']);
    expect(plan.rootWide).toEqual(['packages/cli/src/cmd-test.ts']);
    expect(prefixes(['packages/cli/src/cmd-test.ts'])).toEqual(['']);
    expect(inScope('packages/money/src/money.test.ts', prefixes(['packages/cli/x.ts']))).toBe(true);
  });

  test('a root-wide file still selects everything', () => {
    expect(prefixes(['package.json'])).toEqual(['']);
    expect(prefixes(['bun.lock'])).toEqual(['']);
  });
});

describe('unit · which root directories no workspace owns', () => {
  test('a directory holding a workspace, a dot-directory and node_modules are not unowned', () => {
    const entries = ['packages', 'scripts', 'docs', 'examples', 'node_modules', '.git', '.x'];
    expect(unownedDirs(GRAPH, entries)).toEqual(['docs', 'scripts']);
  });

  test('a root that IS a workspace owns everything under it', () => {
    expect(unownedDirs([node('@app/root', '')], ['apps', 'scripts'])).toEqual([]);
    expect(unownedDirs([node('@app/root', '.')], ['apps', 'scripts'])).toEqual([]);
  });
});
