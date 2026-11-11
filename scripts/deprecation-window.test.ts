// The deprecation window, two ways: the export reader over barrel text, and the whole rule
// against real git repositories with real release tags — a removal with and without the
// `@deprecated` its tag should have carried, inert below v31, and the advisory that excuses one.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { deprecationWindowFindings } from './deprecation-window';
import { deprecatedIn, exportedNames, moduleCandidates } from './lib/export-names';
import { git } from './lib/release-due-git';
import { REPO_SCAN_TIMEOUT_MS } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const made: string[] = [];
afterAll(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('unit · export-names · what a barrel exports', () => {
  test('lists, renames, types and declarations; comments are not exports', () => {
    const source = [
      "export { a, b as c, type D } from './one';",
      "export type { E } from './two.js';",
      'export const f = 1;',
      'export async function g() {}',
      '// export const commented = 1;',
      "export * as ns from './three';",
    ].join('\n');
    expect(exportedNames(source).map((one) => one.name)).toEqual([
      'a',
      'c',
      'D',
      'E',
      'f',
      'g',
      'ns',
    ]);
    expect(exportedNames(source).find((one) => one.name === 'c')).toEqual({
      name: 'c',
      local: 'b',
      from: './one',
    });
  });

  test('@deprecated counts on the declaration, the specifier or the statement, and nowhere else', () => {
    expect(deprecatedIn('/** @deprecated use b */\nexport const a = 1;', 'a')).toBe(true);
    expect(deprecatedIn('export {\n  /** @deprecated */\n  a,\n  b,\n};', 'a')).toBe(true);
    expect(deprecatedIn("/** @deprecated */\nexport { a } from './x';", 'a')).toBe(true);
    expect(
      deprecatedIn('/** @deprecated */\nexport const other = 1;\nexport const a = 1;', 'a'),
    ).toBe(false);
    expect(deprecatedIn('/** a plain doc */\nexport const a = 1;', 'a')).toBe(false);
  });

  test('a relative specifier resolves to the files it can name', () => {
    expect(moduleCandidates('packages/core/src', './exports/x.js')).toEqual([
      'packages/core/src/exports/x.ts',
      'packages/core/src/exports/x.tsx',
      'packages/core/src/exports/x/index.ts',
    ]);
    expect(moduleCandidates('packages/core/src', '@ultimat3/schema')).toEqual([]);
  });
});

/** A repo with `packages/core`, released and tagged at `version` with `index` as its barrel. */
async function released(version: string, index: string, extra: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'deprecation-window-'));
  made.push(dir);
  const run = async (argv: readonly string[]) => {
    const out = await git(
      [
        '-c',
        'user.email=t@example.test',
        '-c',
        'user.name=t',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'tag.gpgsign=false',
        ...argv,
      ],
      dir,
    );
    expect({ argv, ok: out.ok }).toEqual({ argv, ok: true });
  };
  const write = async (files: Record<string, string>) => {
    for (const [path, body] of Object.entries(files)) await Bun.write(join(dir, path), body);
  };
  await run(['init', '--quiet', '-b', 'main']);
  await write({
    'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\nNothing yet.\n',
    [`docs/changelog/${version}.md`]: `## ${version} - 2026-11-10\n\n- x\n`,
    'packages/core/src/index.ts': index,
    ...extra,
  });
  await run(['add', '-A']);
  await run(['commit', '--quiet', '-m', `chore: release ${version}`]);
  await run(['tag', '-a', `v${version}`, '-m', `v${version}`]);
  return { dir, write };
}

const options = {
  probe: async () => false,
  packages: [{ name: '@ultimat3/core', dir: 'core' }],
};

describe('unit · deprecation-window · against a release tag', () => {
  test('a name removed with no @deprecated in the tag is refused', async () => {
    const { dir, write } = await released('31.0.0', 'export const a = 1;\nexport const b = 2;\n');
    await write({ 'packages/core/src/index.ts': 'export const b = 2;\n' });
    const findings = await deprecationWindowFindings(dir, options);
    expect(findings.map((one) => [one.code, one.at])).toEqual([
      ['X_RELEASE_UNDEPRECATED_REMOVAL', 'packages/core/src/index.ts'],
    ]);
    expect(findings[0]?.cause).toContain('`a`');
    expect(findings[0]?.fix).toStartWith('git show v31.0.0:packages/core/src/index.ts');
  });

  test('a name the tag marked @deprecated, in its own module, may go', async () => {
    const { dir, write } = await released('31.1.0', "export { a, b } from './things';\n", {
      'packages/core/src/things.ts':
        '/** @deprecated use b */\nexport const a = 1;\nexport const b = 2;\n',
    });
    await write({ 'packages/core/src/index.ts': "export { b } from './things';\n" });
    expect(await deprecationWindowFindings(dir, options)).toEqual([]);
  });

  test('below v31 the rule is inert: v31 takes the plan removals as scheduled', async () => {
    const { dir, write } = await released('30.4.0', 'export const a = 1;\n');
    await write({ 'packages/core/src/index.ts': 'export const b = 2;\n' });
    expect(await deprecationWindowFindings(dir, options)).toEqual([]);
  });

  test('an advisory recorded under [Unreleased] excuses a removal', async () => {
    const { dir, write } = await released('31.0.0', 'export const a = 1;\n');
    await write({
      'packages/core/src/index.ts': 'export const b = 2;\n',
      'CHANGELOG.md':
        '# Changelog\n\n## [Unreleased]\n\n> **Security exception:** `CVE-2026-1234` — why\n',
    });
    expect(await deprecationWindowFindings(dir, options)).toEqual([]);
  });

  test('a base tag nobody can answer for is a refusal, never a pass', async () => {
    const { dir, write } = await released('31.0.0', 'export const a = 1;\n');
    await git(['tag', '-d', 'v31.0.0'], dir);
    await write({ 'packages/core/src/index.ts': 'export const b = 2;\n' });
    const findings = await deprecationWindowFindings(dir, {
      ...options,
      probe: async () => undefined,
    });
    expect(findings.map((one) => one.code)).toEqual(['X_RELEASE_TAG_UNREACHABLE']);
  });

  test('a base tag origin holds but this clone cannot fetch is a refusal naming the fetch', async () => {
    const { dir, write } = await released('31.0.0', 'export const a = 1;\n');
    await git(['tag', '-d', 'v31.0.0'], dir);
    await write({ 'packages/core/src/index.ts': 'export const b = 2;\n' });
    const findings = await deprecationWindowFindings(dir, { ...options, probe: async () => true });
    expect(findings.map((one) => one.code)).toEqual(['X_RELEASE_TAG_UNREACHABLE']);
    expect(findings[0]?.fix).toStartWith('git fetch --depth=1 --no-tags origin');
  });

  test('a base tag origin does not hold falls back to the release below it', async () => {
    const { dir, write } = await released('31.0.0', 'export const a = 1;\n');
    await write({
      'packages/core/src/index.ts': 'export const b = 2;\n',
      'docs/changelog/31.1.0.md': '## 31.1.0 - 2026-11-17\n\n- y\n',
    });
    const findings = await deprecationWindowFindings(dir, options);
    expect(findings.map((one) => one.code)).toEqual(['X_RELEASE_UNDEPRECATED_REMOVAL']);
    expect(findings[0]?.cause).toContain('v31.0.0');
  });
});
