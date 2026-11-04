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
  checkDependencyRanges,
  type DependencyDeclaration,
  dependencyAllowlistFindings,
  ROOT_MANIFEST,
  rootDeclarationsOf,
} from './dependency-allowlist';

const declaration = (
  name: string,
  field: DependencyDeclaration['field'] = 'dependencies',
  range = '1.2.3',
  manifest = 'packages/core/package.json',
): DependencyDeclaration => ({ manifest, field, name, range });

/** The root's own declaration of a dependency: the reference range every other manifest is read against. */
const rootDeclaration = (name: string, range: string): DependencyDeclaration => ({
  manifest: ROOT_MANIFEST,
  field: 'devDependencies',
  name,
  range,
});

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

/**
 * The cross-manifest rule: a dependency two manifests declare must be declared COMPATIBLY in
 * both, and the ROOT manifest is the reference.
 *
 * The tree's own pairs are the regression this rule must not break: the root's `^7.0.2` against
 * an app's `7.0.2`, and the root's `0.5.10` against an app's `^0.5.8`. A textual comparison
 * would report both.
 */
describe('a dependency two manifests declare', () => {
  test('an exact root pin against a wider app range is compatible', () => {
    const findings = checkDependencyRanges(
      [declaration('typescript', 'devDependencies', '7.0.2', 'examples/dummy/package.json')],
      new Map([['typescript', rootDeclaration('typescript', '^7.0.2')]]),
    );
    expect(findings).toEqual([]);
  });

  test('a root range against an incompatible app range is a conflict', () => {
    const findings = checkDependencyRanges(
      [declaration('typescript', 'devDependencies', '^1.0.0', 'examples/dummy/package.json')],
      new Map([['typescript', rootDeclaration('typescript', '^7.0.2')]]),
    );
    expect(findings[0]?.code).toBe('X_DEPENDENCY_RANGE_CONFLICT');
  });

  test('a root pin against an app range that excludes the pin is a conflict', () => {
    const findings = checkDependencyRanges(
      [declaration('typescript', 'devDependencies', '^6.0.0', 'examples/dummy/package.json')],
      new Map([['typescript', rootDeclaration('typescript', '7.0.2')]]),
    );
    expect(findings[0]?.code).toBe('X_DEPENDENCY_RANGE_CONFLICT');
  });

  test('the conflict names the dependency and both manifests with their ranges', () => {
    const findings = checkDependencyRanges(
      [declaration('typescript', 'devDependencies', '^1.0.0', 'examples/dummy/package.json')],
      new Map([['typescript', rootDeclaration('typescript', '^7.0.2')]]),
    );
    const cause = findings[0]?.cause ?? '';
    expect(cause).toContain('typescript');
    expect(cause).toContain("declared as '^7.0.2' in package.json and as");
    expect(cause).toContain("as '^1.0.0' in examples/dummy/package.json,");
    expect(cause.split('\n')).toHaveLength(1);
  });

  test('conflict diagnostics escape control characters in every external value', () => {
    const name = 'type\tscript';
    for (const range of ['>=1.0.0\n<2.0.0', 'unsupported\r\nrange\u001b']) {
      const root = { ...rootDeclaration(name, '^7.0.2\n'), manifest: 'package\r.json' };
      const findings = checkDependencyRanges(
        [declaration(name, 'devDependencies', range, 'examples/\u2028dummy/package.json')],
        new Map([[name, root]]),
      );
      const cause = findings[0]?.cause ?? '';
      expect(findings[0]?.code).toBe('X_DEPENDENCY_RANGE_CONFLICT');
      expect(cause).toContain('type\\tscript');
      expect(cause).toContain('package\\r.json');
      expect(cause).toContain('^7.0.2\\n');
      expect(cause).toContain('examples/\\u2028dummy/package.json');
      expect(cause).toContain(range.startsWith('>=') ? '\\n<2.0.0' : '\\r\\nrange\\u001b');
      for (const control of ['\r', '\n', '\t', '\u001b', '\u2028']) {
        expect(cause).not.toContain(control);
      }
    }
  });

  test('the conflict names the conflicting manifest as the location of the finding', () => {
    const findings = checkDependencyRanges(
      [declaration('typescript', 'devDependencies', '^1.0.0', 'examples/dummy/package.json')],
      new Map([['typescript', rootDeclaration('typescript', '^7.0.2')]]),
    );
    expect(findings[0]?.at).toBe('examples/dummy/package.json');
  });

  test('a dependency the root does not declare is not compared at all', () => {
    const findings = checkDependencyRanges(
      [declaration('nats', 'dependencies', '2.29.3', 'packages/realtime/package.json')],
      new Map([['typescript', rootDeclaration('typescript', '^7.0.2')]]),
    );
    expect(findings).toEqual([]);
  });

  test('the own declaration of the root is never compared against itself', () => {
    const findings = checkDependencyRanges(
      [rootDeclaration('typescript', '^7.0.2')],
      new Map([['typescript', rootDeclaration('typescript', '^7.0.2')]]),
    );
    expect(findings).toEqual([]);
  });

  test('a range that does not parse is refused, never read as compatible', () => {
    const findings = checkDependencyRanges(
      [declaration('typescript', 'devDependencies', 'workspace:*', 'examples/dummy/package.json')],
      new Map([['typescript', rootDeclaration('typescript', '^7.0.2')]]),
    );
    expect(findings[0]?.code).toBe('X_DEPENDENCY_RANGE_CONFLICT');
  });

  test('the root declarations are read off the scan, one per name', () => {
    const root = rootDeclarationsOf([
      rootDeclaration('typescript', '^7.0.2'),
      rootDeclaration('solid-js', '1.9.17'),
      declaration('typescript', 'devDependencies', '7.0.2', 'examples/dummy/package.json'),
    ]);
    expect(root.get('typescript')?.range).toBe('^7.0.2');
    expect(root.get('solid-js')?.range).toBe('1.9.17');
    expect(root.size).toBe(2);
  });
});

/**
 * A fixture tree, read end to end: the manifests are written, the guard is run over them, and the
 * verdict is the finding — the same path the real tree takes.
 */
describe('a fixture tree with a conflicting range', () => {
  test('is reported as a range conflict naming both manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-dependency-range-'));
    try {
      await Bun.write(
        join(root, 'package.json'),
        '{"name":"root","version":"1.0.0","devDependencies":{"typescript":"^7.0.2"}}',
      );
      await mkdir(join(root, 'packages/core'), { recursive: true });
      await Bun.write(
        join(root, 'packages/core/package.json'),
        '{"name":"@ultimat3/core","version":"1.0.0","devDependencies":{"typescript":"^1.0.0"}}',
      );
      const findings = await dependencyAllowlistFindings(root);
      const conflict = findings.find((finding) => finding.code === 'X_DEPENDENCY_RANGE_CONFLICT');
      expect(conflict).toBeDefined();
      expect(conflict?.cause).toContain('typescript');
      expect(conflict?.cause).toContain('packages/core/package.json');
      expect(conflict?.fix).toContain('bun run');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a fixture tree with a compatible pair reports nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-dependency-range-'));
    try {
      await Bun.write(
        join(root, 'package.json'),
        '{"name":"root","version":"1.0.0","devDependencies":{"typescript":"^7.0.2"}}',
      );
      await mkdir(join(root, 'packages/core'), { recursive: true });
      await Bun.write(
        join(root, 'packages/core/package.json'),
        '{"name":"@ultimat3/core","version":"1.0.0","devDependencies":{"typescript":"7.0.2"}}',
      );
      const findings = await dependencyAllowlistFindings(root);
      expect(findings.filter((finding) => finding.code === 'X_DEPENDENCY_RANGE_CONFLICT')).toEqual(
        [],
      );
      expect(findings.filter((finding) => finding.code === 'X_DEPENDENCY_UNSCANNED')).toEqual([]);
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
