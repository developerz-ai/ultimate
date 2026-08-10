import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ManifestFacts } from './workspace-checks';
import {
  badVersionFinding,
  checkFileSizes,
  checkLockstep,
  checkPackageShape,
  countLines,
  frameworkDepsOf,
  hasWorkspacePackages,
  LINE_CEILING,
  PACKAGE_FILES,
  workspacePackages,
} from './workspace-checks';

const REPO_ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');

let dir = '';

/** Terminated by a newline, like every file Biome formats — the case the count has to get right. */
const lines = (count: number): string =>
  `${Array.from({ length: count }, () => 'const x = 1;').join('\n')}\n`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ultimate-workspace-checks-'));
  await Bun.write(join(dir, 'packages/short/src/index.ts'), lines(LINE_CEILING));
  await Bun.write(join(dir, 'packages/short/README.md'), '# short\n');
  await Bun.write(join(dir, 'packages/short/CLAUDE.md'), '# short\n');
  await Bun.write(join(dir, 'packages/short/tsconfig.json'), '{}\n');
  await Bun.write(join(dir, 'packages/short/package.json'), '{"name":"short","version":"1.2.3"}\n');
  await Bun.write(join(dir, 'packages/long/src/index.ts'), lines(LINE_CEILING + 1));
  await Bun.write(join(dir, 'packages/long/package.json'), '{"name":"long"}\n');
  await Bun.write(join(dir, 'packages/long/node_modules/dep/src/huge.ts'), lines(2_000));
  await Bun.write(join(dir, 'app/orgs/page.tsx'), lines(LINE_CEILING + 40));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('unit · the file-size ceiling', () => {
  test('one line over the ceiling is a finding, exactly at it is not', async () => {
    const findings = await checkFileSizes(dir);
    const paths = findings.map((finding) => finding.at);
    expect(paths).toContain('packages/long/src/index.ts');
    expect(paths).not.toContain('packages/short/src/index.ts');
    expect(findings.every((finding) => finding.code === 'X_FILE_TOO_LONG')).toBe(true);
  });

  // The ceiling is 500, so it has to be 500 — off by one it enforces 499 and every count it
  // reports is a line too high, which sends an author to split a file that already fits.
  test('a terminating newline is not a line of its own', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('a\n\n')).toBe(2);
    expect(countLines(lines(LINE_CEILING))).toBe(LINE_CEILING);
  });

  test('a file exactly at the ceiling is counted at the ceiling, not over it', async () => {
    const at = join(dir, 'packages/edge/src/index.ts');
    await Bun.write(at, lines(LINE_CEILING));
    await Bun.write(join(dir, 'packages/edge/src/over.ts'), lines(LINE_CEILING + 1));

    const findings = await checkFileSizes(dir);
    const over = findings.find((finding) => finding.at === 'packages/edge/src/over.ts');

    expect(findings.map((finding) => finding.at)).not.toContain('packages/edge/src/index.ts');
    expect(over?.cause).toContain(`${LINE_CEILING + 1} lines`);
  });

  test('app surfaces are scanned too, and dependencies are not', async () => {
    const paths = (await checkFileSizes(dir)).map((finding) => finding.at);
    expect(paths).toContain('app/orgs/page.tsx');
    expect(paths.some((path) => path?.includes('node_modules'))).toBe(false);
  });

  test('every finding names the file it is about in its fix', async () => {
    for (const finding of await checkFileSizes(dir)) {
      expect(finding.fix).toContain(finding.at ?? '');
    }
  });
});

describe('unit · the package shape', () => {
  test('a package missing a contract file is reported once per file', async () => {
    const findings = await checkPackageShape(dir);
    expect(findings.map((finding) => finding.at)).toEqual([
      'packages/long/README.md',
      'packages/long/CLAUDE.md',
      'packages/long/tsconfig.json',
      'packages/long/package.json',
    ]);
    expect(findings.every((finding) => finding.code === 'X_PACKAGE_SHAPE')).toBe(true);
  });

  test('a manifest with no semver version is a finding, not a silent 0.0.0', async () => {
    // Every published package reads its own version back at runtime, so this is the difference
    // between a working `x --version` and one that prints `undefined` to whoever installed it.
    expect(badVersionFinding('long', undefined).fix).toContain('packages/long/package.json');
    const bad = await mkdtemp(join(tmpdir(), 'ultimate-version-'));
    for (const file of PACKAGE_FILES) await Bun.write(join(bad, 'packages/p', file), '{}\n');
    await Bun.write(join(bad, 'packages/p/package.json'), '{"name":"p","version":"latest"}\n');
    const findings = await checkPackageShape(bad);
    expect(findings.map((finding) => finding.at)).toEqual(['packages/p/package.json']);
    expect(findings[0]?.cause).toContain('"latest"');
    await rm(bad, { recursive: true, force: true });
  });

  test('this repo satisfies the shape it enforces', async () => {
    expect(await checkPackageShape(REPO_ROOT)).toEqual([]);
    expect(await workspacePackages(REPO_ROOT)).toContain('cli');
    expect(PACKAGE_FILES).toHaveLength(4);
  });

  test('the step is skipped where there are no workspace packages', async () => {
    expect(await hasWorkspacePackages(dir)).toBe(true);
    expect(await hasWorkspacePackages(join(dir, 'app'))).toBe(false);
  });
});

const pkg = (over: Partial<ManifestFacts> & { dir: string }): ManifestFacts => ({
  name: `@ultimat3/${over.dir}`,
  version: '1.0.0',
  private: false,
  frameworkDeps: [],
  ...over,
});

describe('checkLockstep', () => {
  test('every published package at one version, pins included, is clean', () => {
    expect(
      checkLockstep([
        pkg({ dir: 'core' }),
        pkg({ dir: 'jobs', frameworkDeps: [['@ultimat3/core', '1.0.0']] }),
      ]),
    ).toEqual([]);
  });

  test('a package left behind at the old version is a finding', () => {
    const findings = checkLockstep([pkg({ dir: 'core' }), pkg({ dir: 'ui', version: '0.0.1' })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('X_RELEASE_VERSION_SKEW');
    expect(findings[0]?.cause).toBe('packages/ui is at 0.0.1, not the lockstep version 1.0.0');
    expect(findings[0]?.fix).toBe('bun run scripts/release.ts --version 1.0.0');
  });

  // The release this check exists for: every own version moved to 1.0.0 and every sibling pin
  // stayed at 0.0.1, so @ultimat3/jobs@1.0.0 published naming a @ultimat3/core@0.0.1 that is not
  // on the registry. Nothing in the repo failed; every install of the release did.
  test('a stale sibling pin is a finding even when both versions are right', () => {
    const findings = checkLockstep([
      pkg({ dir: 'core' }),
      pkg({ dir: 'jobs', frameworkDeps: [['@ultimat3/core', '0.0.1']] }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toBe(
      'packages/jobs pins @ultimat3/core at 0.0.1, not the lockstep version 1.0.0',
    );
  });

  test('core is the anchor, so one stray package does not indict every other', () => {
    const findings = checkLockstep([
      pkg({ dir: 'core' }),
      pkg({ dir: 'http' }),
      pkg({ dir: 'ui', version: '9.9.9' }),
    ]);
    expect(findings.map((finding) => finding.at)).toEqual(['packages/ui/package.json']);
  });

  // A generated app has `packages/*` too: private, on their own version line, depending on the
  // framework by caret range. Reporting those would fail `x verify` on unmodified scaffold output.
  test('private packages are exempt on both counts', () => {
    expect(
      checkLockstep([
        pkg({ dir: 'core' }),
        pkg({
          dir: 'db',
          private: true,
          version: '0.0.1',
          frameworkDeps: [['@ultimat3/entity', '^1.0.0']],
        }),
      ]),
    ).toEqual([]);
  });

  test('no published package at all is a no-op, not a crash', () => {
    expect(checkLockstep([pkg({ dir: 'db', private: true })])).toEqual([]);
    expect(checkLockstep([])).toEqual([]);
  });
});

describe('frameworkDepsOf', () => {
  test('reads @ultimat3 dependencies and ignores everything else', () => {
    expect(
      frameworkDepsOf({
        dependencies: { '@ultimat3/core': '1.0.0', 'solid-js': '^2.0.0' },
        devDependencies: { '@ultimat3/testing': '1.0.0' },
      }),
    ).toEqual([['@ultimat3/core', '1.0.0']]);
  });

  test('a manifest with no dependencies block reads as none', () => {
    expect(frameworkDepsOf({})).toEqual([]);
    expect(frameworkDepsOf(null)).toEqual([]);
  });
});
