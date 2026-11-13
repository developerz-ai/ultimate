// The public-API lock, end to end on a throwaway tree compiled by the repo's own `tsc`: a breaking
// change or a removed export with no `BREAKING —` entry is reported, a declared one, an addition
// and an additive change are not, reordering or re-spelling a file (CRLF, comments, quotes) is
// invisible, and a format-1 lock is re-baselined from its release tag.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun has no mkdtemp/rm of its own; a unique directory per run keeps test workers apart.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
// why: Bun has no tmpdir() of its own; node:os is the only way to find the platform temp root.
import { tmpdir } from 'node:os';
import { localBin } from './lib/local-bin';
import { LOCK_PATH, renderLock } from './lib/public-api-lock';
import { REPO_SCAN_TIMEOUT_MS, repoRoot, run } from './lib/run';
import {
  BREAK_CODE,
  type PublicApiReport,
  publicApiReport,
  REFUSE_ON_BRANCHES,
  refuses,
  UNSCANNED_CODE,
} from './public-api';

// Each case runs `tsc` twice over a three-file package: the compiler's deadline, not a unit's.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const TSC = localBin(repoRoot(), 'tsc');
const made: string[] = [];
afterAll(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const BASE = {
  compilerOptions: {
    target: 'ES2023',
    module: 'ESNext',
    moduleResolution: 'bundler',
    strict: true,
    skipLibCheck: true,
    types: [],
  },
};

const INDEX = [
  "import type { Shape } from './shape';",
  "export { area, perimeter } from './shape';",
  "export type { Shape } from './shape';",
  '',
].join('\n');
const SHAPE = [
  '/** A shape. */',
  'export interface Shape { readonly sides: number }',
  'export function area(shape: Shape): number { return shape.sides; }',
  'export function perimeter(shape: Shape): number { return shape.sides * 2; }',
  '',
].join('\n');
const SUB = [
  'interface Options { readonly label: string }',
  'export interface Style { readonly color: string; readonly weight?: number }',
  'export function paint(style: Style): string { return style.color; }',
  'export function render(width: number, options: Options): string { return String(width) + options.label; }',
  "export const KIND = 'sub';",
  '',
].join('\n');

const PACKAGE = {
  name: '@ultimat3/alpha',
  version: '1.0.0',
  exports: { '.': './src/index.ts', './sub': './src/sub.ts', './icons/*': './src/glyphs/*.ts' },
};

async function fixture(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/public-api-`);
  made.push(dir);
  await mkdir(`${dir}/packages/alpha/src/glyphs`, { recursive: true });
  await mkdir(`${dir}/docs/changelog`, { recursive: true });
  await Bun.write(`${dir}/tsconfig.base.json`, JSON.stringify(BASE));
  await Bun.write(`${dir}/packages/alpha/package.json`, JSON.stringify(PACKAGE));
  await Bun.write(`${dir}/packages/alpha/src/index.ts`, INDEX);
  await Bun.write(`${dir}/packages/alpha/src/shape.ts`, SHAPE);
  await Bun.write(`${dir}/packages/alpha/src/sub.ts`, SUB);
  await Bun.write(`${dir}/packages/alpha/src/glyphs/star.ts`, 'export const star = [1, 2];\n');
  await Bun.write(`${dir}/CHANGELOG.md`, '# Changelog\n\n## [Unreleased]\n\nNothing yet.\n');
  await Bun.write(`${dir}/docs/changelog/1.0.0.md`, '## 1.0.0 - 2026-11-13\n\n### Added\n\n- x\n');
  return dir;
}

const OPTIONS = {
  packages: [{ name: '@ultimat3/alpha', dir: 'alpha' }],
  version: '1.0.0',
  tsc: TSC,
};

const scan = (dir: string, tags?: readonly string[]): Promise<PublicApiReport> =>
  publicApiReport(dir, tags === undefined ? OPTIONS : { ...OPTIONS, tags });

/** A fixture whose lock is the tree as written: what `--write` commits. */
async function locked(): Promise<string> {
  const dir = await fixture();
  const first = await scan(dir);
  if (first.next === undefined) expect.unreachable('the fixture surface must be readable');
  await Bun.write(`${dir}/${LOCK_PATH}`, renderLock(first.next));
  return dir;
}

const edit = async (dir: string, file: string, from: string, to: string): Promise<void> => {
  const path = `${dir}/packages/alpha/src/${file}`;
  const text = await Bun.file(path).text();
  if (!text.includes(from)) expect.unreachable(`${file} must hold ${from}`);
  await Bun.write(path, text.replace(from, to));
};

const NO_CHANGE = { breaks: [], compatible: [], added: [] };

/** The one change `scan` finds after `edit`: compatible, a reported break, or none. */
async function changeAfter(
  file: string,
  from: string,
  to: string,
): Promise<{
  verdict: 'compatible' | 'break' | 'none';
  specifier?: string;
  name?: string;
  why?: string;
}> {
  const dir = await locked();
  await edit(dir, file, from, to);
  const { diff, findings } = await scan(dir);
  const [broken] = diff.breaks;
  const [fine] = diff.compatible;
  if (broken !== undefined) {
    expect(findings.map((one) => one.code)).toEqual([BREAK_CODE]);
    expect(findings[0]?.cause).toContain(broken.why);
    return { verdict: 'break', name: broken.name, why: broken.why };
  }
  expect(findings).toEqual([]);
  return fine === undefined ? { verdict: 'none' } : { verdict: 'compatible', ...fine };
}

const unreleased = (dir: string, entry: string): Promise<number> =>
  Bun.write(`${dir}/CHANGELOG.md`, `# Changelog\n\n## [Unreleased]\n\n### Changed\n\n${entry}\n`);

describe('public API lock · the surface is read', () => {
  test('the main entry, the subpath and each wildcard file are entries, followed to their source', async () => {
    const dir = await fixture();
    const { next } = await scan(dir);
    expect(Object.keys(next?.entries ?? {})).toEqual([
      '@ultimat3/alpha',
      '@ultimat3/alpha/icons/star',
      '@ultimat3/alpha/sub',
    ]);
    expect(Object.keys(next?.entries['@ultimat3/alpha'] ?? {})).toEqual([
      'Shape',
      'area',
      'perimeter',
    ]);
  });

  test('no lock is X_PUBLIC_API_UNSCANNED, and the next lock is the tree', async () => {
    const dir = await fixture();
    const result = await scan(dir);
    expect(result.findings.map((one) => one.code)).toEqual([UNSCANNED_CODE]);
    expect(result.findings[0]?.fix).toBe('bun run scripts/public-api.ts --write --json');
    expect(result.next?.version).toBe('1.0.0');
  });
});

describe('public API lock · what is a break', () => {
  test('a changed parameter type on a subpath export with no BREAKING entry is reported', async () => {
    const dir = await locked();
    await edit(dir, 'sub.ts', 'render(width: number', 'render(width: string');
    const result = await scan(dir);
    expect(result.findings.map((one) => one.code)).toEqual([BREAK_CODE]);
    expect(result.findings[0]?.cause).toContain('@ultimat3/alpha/sub exports `render`');
    expect(result.findings[0]?.at).toBe('packages/alpha/src/sub.ts');
    expect(result.findings[0]?.fix).toContain('bun run scripts/public-api.ts --write --json');
  });

  test('a change to a non-exported type the declaration names is a change to it', async () => {
    const dir = await locked();
    await edit(dir, 'sub.ts', 'readonly label: string', 'readonly label: number');
    const result = await scan(dir);
    expect(result.diff.breaks).toEqual([
      {
        kind: 'changed',
        specifier: '@ultimat3/alpha/sub',
        name: 'render',
        why: 'its heading changed — type parameters, `extends`, or a local type it names',
      },
    ]);
  });

  test('the same change declared under [Unreleased] is no finding, and --write records it', async () => {
    const dir = await locked();
    await edit(dir, 'sub.ts', 'render(width: number', 'render(width: string');
    await unreleased(dir, '- **BREAKING —** (#1) `render` takes the width as a string.');
    const result = await scan(dir);
    expect(result.findings).toEqual([]);
    expect(result.diff.breaks).toHaveLength(1);
    if (result.next === undefined) expect.unreachable('a readable surface has a next lock');
    await Bun.write(`${dir}/${LOCK_PATH}`, renderLock(result.next));
    await unreleased(dir, 'Nothing yet.');
    expect((await scan(dir)).diff.breaks).toEqual([]);
  });

  test('a removed export is reported, and --write keeps reporting it until it is declared', async () => {
    const dir = await locked();
    await Bun.write(`${dir}/packages/alpha/src/index.ts`, INDEX.replace('area, ', ''));
    const result = await scan(dir);
    expect(result.diff.breaks).toEqual([
      {
        kind: 'removed',
        specifier: '@ultimat3/alpha',
        name: 'area',
        why: 'it is no longer exported',
      },
    ]);
    expect(result.findings[0]?.cause).toContain('no longer exports `area`');
    if (result.next === undefined) expect.unreachable('a readable surface has a next lock');
    await Bun.write(`${dir}/${LOCK_PATH}`, renderLock(result.next));
    expect((await scan(dir)).findings.map((one) => one.code)).toEqual([BREAK_CODE]);
  });

  test('an added export is listed, not reported, and green after --write', async () => {
    const dir = await locked();
    await Bun.write(`${dir}/packages/alpha/src/sub.ts`, `${SUB}export const EXTRA = 1;\n`);
    const result = await scan(dir);
    expect(result.findings).toEqual([]);
    expect(result.diff.added).toEqual([{ specifier: '@ultimat3/alpha/sub', name: 'EXTRA' }]);
    if (result.next === undefined) expect.unreachable('a readable surface has a next lock');
    await Bun.write(`${dir}/${LOCK_PATH}`, renderLock(result.next));
    expect((await scan(dir)).diff).toEqual(NO_CHANGE);
  });

  test('reordered exports and imports, CRLF, comments and quote style are not reported', async () => {
    const dir = await locked();
    const reordered = [
      "export type { Shape } from './shape';",
      '// the two functions',
      'export { perimeter, area } from "./shape";',
      'import type { Shape } from "./shape";',
      '',
    ].join('\r\n');
    await Bun.write(`${dir}/packages/alpha/src/index.ts`, reordered);
    await Bun.write(
      `${dir}/packages/alpha/src/shape.ts`,
      SHAPE.split('\n').reverse().join('\r\n').replace('/** A shape. */', ''),
    );
    const result = await scan(dir);
    expect(result.diff).toEqual(NO_CHANGE);
  });
});

describe('public API lock · additive or breaking', () => {
  test('unchanged is nothing', async () => {
    expect(await changeAfter('sub.ts', 'color: string', 'color: string')).toEqual({
      verdict: 'none',
    });
  });

  test('an optional member added is compatible: no finding, and --write records it', async () => {
    const dir = await locked();
    await edit(dir, 'sub.ts', 'weight?: number', 'weight?: number; readonly font?: string');
    const result = await scan(dir);
    expect(result.findings).toEqual([]);
    expect(result.diff.compatible).toEqual([
      { specifier: '@ultimat3/alpha/sub', name: 'Style', why: 'optional `font` added' },
    ]);
    if (result.next === undefined) expect.unreachable('a readable surface has a next lock');
    await Bun.write(`${dir}/${LOCK_PATH}`, renderLock(result.next));
    expect((await scan(dir)).diff).toEqual(NO_CHANGE);
  });

  test('a required member added to an input interface is a break', async () => {
    const change = await changeAfter('sub.ts', 'weight?: number', 'weight?: number; font: string');
    expect(change).toEqual({
      verdict: 'break',
      name: 'Style',
      why: 'required member `font` was added',
    });
  });

  test('an optional member made required is a break', async () => {
    const change = await changeAfter('sub.ts', 'weight?: number', 'weight: number');
    expect(change).toEqual({
      verdict: 'break',
      name: 'Style',
      why: 'member `weight` became required',
    });
  });

  test('an optional trailing parameter added is compatible', async () => {
    const change = await changeAfter(
      'sub.ts',
      'paint(style: Style)',
      'paint(style: Style, dpi?: number)',
    );
    expect(change).toEqual({
      verdict: 'compatible',
      specifier: '@ultimat3/alpha/sub',
      name: 'paint',
      why: 'optional parameter 2 added',
    });
  });

  test('a required parameter added is a break', async () => {
    const change = await changeAfter(
      'sub.ts',
      'paint(style: Style)',
      'paint(style: Style, dpi: number)',
    );
    expect(change).toEqual({
      verdict: 'break',
      name: 'paint',
      why: 'required parameter 2 was added',
    });
  });

  test('a widened return type is a break', async () => {
    const change = await changeAfter(
      'shape.ts',
      'area(shape: Shape): number {',
      'area(shape: Shape): number | string {',
    );
    expect(change).toEqual({ verdict: 'break', name: 'area', why: 'its return type changed' });
  });
});

describe('public API lock · a format-1 lock', () => {
  const git = async (dir: string, ...args: string[]): Promise<void> => {
    const ran = await run(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: dir,
    });
    if (!ran.ok) expect.unreachable(`git ${args.join(' ')} must succeed in ${dir}: ${ran.output}`);
  };

  test('is re-baselined from its release tag, so an additive change is compatible', async () => {
    const dir = await locked();
    const current = await scan(dir);
    const hashes = Object.fromEntries(
      Object.entries(current.next?.entries ?? {}).map(([specifier, names]) => [
        specifier,
        Object.fromEntries(Object.entries(names).map(([name, one]) => [name, one.hash])),
      ]),
    );
    await Bun.write(`${dir}/${LOCK_PATH}`, JSON.stringify({ version: '1.0.0', entries: hashes }));
    await git(dir, 'init', '-q');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-qm', 'one');
    await git(dir, 'tag', 'v1.0.0');
    await edit(dir, 'sub.ts', 'weight?: number', 'weight?: number; readonly font?: string');
    const result = await scan(dir);
    expect(result.migratedFrom).toEqual(['v1.0.0']);
    expect(result.findings).toEqual([]);
    expect(result.diff.compatible.map((one) => one.name)).toEqual(['Style']);
    expect(renderLock(result.next ?? { format: 2, version: '', entries: {} })).toContain(
      '"format": 2',
    );
  });

  test('a tag whose declaration is not the one the lock hashed lends it no shape', async () => {
    const dir = await locked();
    const lock = {
      version: '1.0.0',
      entries: { '@ultimat3/alpha/sub': { Style: 'f'.repeat(16) } },
    };
    await Bun.write(`${dir}/${LOCK_PATH}`, JSON.stringify(lock));
    await git(dir, 'init', '-q');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-qm', 'one');
    await git(dir, 'tag', 'v1.0.0');
    const result = await scan(dir, ['v1.0.0']);
    expect(result.migratedFrom).toEqual(['v1.0.0']);
    expect(result.diff.breaks.map((one) => one.why)).toEqual([
      'its declaration changed, and the lock holds no shape to judge the change by',
    ]);
  });

  test('with no tag to read, a change to it is a break whose fix fetches the tags', async () => {
    const dir = await locked();
    const current = await scan(dir);
    const style = current.next?.entries['@ultimat3/alpha/sub']?.['Style']?.hash;
    const lock = { version: '1.0.0', entries: { '@ultimat3/alpha/sub': { Style: style } } };
    await Bun.write(`${dir}/${LOCK_PATH}`, JSON.stringify(lock));
    await edit(dir, 'sub.ts', 'weight?: number', 'weight?: number; readonly font?: string');
    const result = await scan(dir);
    expect(result.migratedFrom).toEqual([]);
    expect(result.findings.map((one) => one.code)).toEqual([BREAK_CODE]);
    expect(result.findings[0]?.fix).toStartWith('git fetch --tags origin && ');
  });
});

describe('public API lock · report-only this release', () => {
  test('no branch refuses yet; --strict does, and naming next in the table would', () => {
    expect(REFUSE_ON_BRANCHES).toEqual([]);
    expect(refuses(false, { GITHUB_BASE_REF: 'next' })).toBe(false);
    expect(refuses(true, {})).toBe(true);
  });
});
