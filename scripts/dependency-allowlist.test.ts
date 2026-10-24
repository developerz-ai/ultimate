// The enforcement half of `scripts/dependency-allowlist.ts`: this file IS the build error. The
// gate's `unit` step runs every `scripts/**/*.test.ts`, so a new dependency fails the gate.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temporary-directory API, so the fixture root needs node:os.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
// why: Bun ships no temporary-directory API, so the fixture root needs node:os.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import {
  checkDependencyAllowlist,
  type DependencyDeclaration,
  dependencyAllowlistFindings,
} from './dependency-allowlist';

const declaration = (
  name: string,
  field: DependencyDeclaration['field'] = 'dependencies',
): DependencyDeclaration => ({ manifest: 'packages/core/package.json', field, name });

describe('an external dependency', () => {
  test('an allowlisted dependency passes', () => {
    const findings = checkDependencyAllowlist({
      declarations: [declaration('typescript')],
      workspaceNames: new Set(['@ultimat3/core']),
      allowlist: {
        'packages/core/package.json#dependencies#typescript': { reason: 'the compiler' },
      },
    });
    expect(findings).toEqual([]);
  });

  test('an unallowlisted dependencies entry fails', () => {
    const findings = checkDependencyAllowlist({
      declarations: [declaration('left-pad')],
      workspaceNames: new Set(['@ultimat3/core']),
      allowlist: {},
    });
    expect(findings[0]?.code).toBe('X_DEPENDENCY_NOT_ALLOWLISTED');
  });

  test('an unallowlisted devDependencies entry fails', () => {
    const findings = checkDependencyAllowlist({
      declarations: [declaration('left-pad', 'devDependencies')],
      workspaceNames: new Set(['@ultimat3/core']),
      allowlist: {},
    });
    expect(findings[0]?.code).toBe('X_DEPENDENCY_NOT_ALLOWLISTED');
  });

  test('an internal dependency needs no allowlist row', () => {
    const findings = checkDependencyAllowlist({
      declarations: [declaration('@ultimat3/core')],
      workspaceNames: new Set(['@ultimat3/core']),
      allowlist: {},
    });
    expect(findings).toEqual([]);
  });

  test('an allowlist row for a dependency that no longer exists is stale', () => {
    const findings = checkDependencyAllowlist({
      declarations: [],
      workspaceNames: new Set(['@ultimat3/core']),
      allowlist: { 'packages/core/package.json#dependencies#gone': { reason: 'was here' } },
    });
    expect(findings[0]?.code).toBe('X_DEPENDENCY_ALLOWLIST_STALE');
  });
});

describe('a broken manifest', () => {
  test('is refused as a finding, never thrown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-dependency-allowlist-'));
    try {
      await Bun.write(join(root, 'package.json'), '{ this is not json');
      const findings = await dependencyAllowlistFindings(root);
      expect(findings[0]?.code).toBe('X_DEPENDENCY_UNSCANNED');
      expect(findings[0]?.fix).toContain('bun run');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * A workspace manifest that does not parse is a dependency this rule never saw, not a manifest
   * with no dependencies. Skipping it reported a clean tree over a dependency nobody had checked,
   * which is what `scripts/lib/corpus.ts` calls out for a whole tree — "a guard whose glob matched
   * nothing answered 'no findings', which is exactly what a clean tree answers".
   */
  test('a workspace manifest that does not parse is refused, never skipped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-dependency-allowlist-'));
    try {
      // A readable root that DOES declare a dependency, so the root branch passes and the scan
      // reaches the workspace manifest — the branch under test is the workspace one.
      await Bun.write(
        join(root, 'package.json'),
        '{"name":"root","version":"1.0.0","devDependencies":{"typescript":"^5.0.0"}}',
      );
      await mkdir(join(root, 'packages/core'), { recursive: true });
      await Bun.write(join(root, 'packages/core/package.json'), '{ this is not json');
      const findings = await dependencyAllowlistFindings(root);
      expect(findings[0]?.code).toBe('X_DEPENDENCY_UNSCANNED');
      expect(findings[0]?.at).toBe('packages/core/package.json');
      expect(findings[0]?.fix).toContain('bun run');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * A tree whose manifests are all readable but declare no dependency at all enforces nothing —
   * the same false clean the unreadable manifest produces, reached the other way. It must answer
   * `X_DEPENDENCY_UNSCANNED` rather than an empty list.
   */
  test('a readable tree that declares no dependency is refused, never a clean list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-dependency-allowlist-'));
    try {
      await Bun.write(join(root, 'package.json'), '{"name":"root","version":"1.0.0"}');
      await mkdir(join(root, 'packages/core'), { recursive: true });
      await Bun.write(
        join(root, 'packages/core/package.json'),
        '{"name":"@ultimat3/core","version":"1.0.0"}',
      );
      const findings = await dependencyAllowlistFindings(root);
      expect(findings[0]?.code).toBe('X_DEPENDENCY_UNSCANNED');
      expect(findings[0]?.fix).toContain('bun run');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('the repository tree', () => {
  test('is clean', async () => {
    expect(await dependencyAllowlistFindings(process.cwd())).toEqual([]);
  });
});
