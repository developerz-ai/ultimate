// The table the release workflow derives its publish plan from: its order is the publish order,
// a tier it does not know is refused, and an empty table is a failure rather than a quiet "0".

import { describe, expect, test } from 'bun:test';
import type { Workspace } from './lib/workspaces';
import { workspaceTable } from './list-workspaces';

const ws = (dir: string, tier: number, dependsOn: readonly string[] = []): Workspace => ({
  dir,
  name: `@ultimat3/${dir}`,
  version: '9.0.0',
  private: false,
  path: `/nowhere/packages/${dir}`,
  tier,
  dependsOn,
});

const names = (result: ReturnType<typeof workspaceTable>): readonly unknown[] =>
  (result.data as readonly { readonly name: string }[]).map((row) => row.name);

describe('workspaceTable', () => {
  // `release.yml` groups this table by tier and publishes each group in the order it arrives.
  test('rows arrive in publish order, a sideways dependency first', () => {
    const result = workspaceTable(
      [ws('core', 0, ['@ultimat3/schema']), ws('schema', 0)],
      undefined,
    );
    expect(result.ok).toBe(true);
    expect(names(result)).toEqual(['@ultimat3/schema', '@ultimat3/core']);
  });

  test('a tier the table does not have is refused, never answered "0 workspaces"', () => {
    for (const tier of ['9', 'abc', '', '-1', '1.5']) {
      const result = workspaceTable([ws('core', 0)], tier);
      expect(result.ok).toBe(false);
      expect(result.findings?.map((finding) => finding.code)).toEqual(['X_CLI_BAD_FLAG']);
      expect(result.findings?.[0]?.fix).toBe('bun run scripts/list-workspaces.ts --tier 0 --json');
    }
  });

  test('a known tier narrows the table', () => {
    const result = workspaceTable([ws('core', 0), ws('db', 1)], '1');
    expect(result.ok).toBe(true);
    expect(names(result)).toEqual(['@ultimat3/db']);
  });

  test('a tree that enumerates nothing is a failure, with or without a tier', () => {
    for (const tier of [undefined, '3']) {
      const result = workspaceTable(tier === undefined ? [] : [ws('core', 0)], tier);
      expect(result.ok).toBe(false);
      expect(result.findings?.map((finding) => finding.code)).toEqual(['X_CORPUS_UNSCANNED']);
    }
  });
});
