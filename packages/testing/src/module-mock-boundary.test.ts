// `mock.module` put back at the file boundary, proved in a real child `bun test --no-isolate` under
// the app preload: without the boundary, a later file on the worker reads an earlier file's fake.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive; the fixture is a real tree a child `bun test` runs.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { callerFile } from './module-mock-boundary';
import { ModuleMockUnrestorableError } from './module-mock-error';
import { testName } from './test-types';

const PRELOAD = join(import.meta.dir, 'preload.ts');

const FILES: Readonly<Record<string, string>> = {
  'real.ts': "export const value = (): string => 'real';",
  'consumer.ts': "import { value } from './real';\nexport const read = (): string => value();",
  'aliased.ts': "export const alias = (): string => 'real';",
  'throws.ts': "throw new TypeError('cannot load here');\nexport const never = 1;",
  'preloaded.ts': "export const kept = (): string => 'real';",
  'app-preload.ts': [
    "import { mock } from 'bun:test';",
    "mock.module('./preloaded', () => ({ kept: () => 'PRELOAD FAKE' }));",
  ].join('\n'),
  // The mocking file: a relative id, an alias, and a bare restore.
  'a.test.ts': [
    "import { expect, mock, test, vi } from 'bun:test';",
    "mock.module('./real', () => ({ value: () => 'FAKE' }));",
    "vi.mock('./aliased', () => ({ alias: () => 'FAKE' }));",
    'mock.restore();',
    "test('a', async () => {",
    "  const { read } = await import('./consumer');",
    "  const { alias } = await import('./aliased');",
    "  console.log('SAW a ' + read() + ' ' + alias());",
    "  expect(read()).toBe('FAKE');",
    '});',
  ].join('\n'),
  'b.test.ts': [
    "import { test } from 'bun:test';",
    "test('b', async () => {",
    "  const { read } = await import('./consumer');",
    "  const { alias } = await import('./aliased');",
    "  const { kept } = await import('./preloaded');",
    "  console.log('SAW b ' + read() + ' ' + alias() + ' ' + kept());",
    '});',
  ].join('\n'),
  // A module that cannot load here, mocked — the common reason to mock one at all.
  'c.test.ts': [
    "import { mock, test } from 'bun:test';",
    "mock.module('./throws', () => ({ never: 2 }));",
    "test('c', () => {});",
  ].join('\n'),
  'd.test.ts': ["import { test } from 'bun:test';", "test('d', () => {});"].join('\n'),
};

let dir = '';
let out = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'module-mock-boundary-'));
  for (const [name, text] of Object.entries(FILES)) await Bun.write(join(dir, name), text);
  // The cwd is NOT the fixture: a relative id resolved against the cwd would miss `./real`.
  const child = Bun.spawn(
    [
      'bun',
      'test',
      '--no-isolate',
      '--preload',
      PRELOAD,
      '--preload',
      join(dir, 'app-preload.ts'),
      join(dir, 'a.test.ts'),
      join(dir, 'b.test.ts'),
      join(dir, 'c.test.ts'),
      join(dir, 'd.test.ts'),
    ],
    { cwd: tmpdir(), stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  out = `${stdout}\n${stderr}`;
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const saw = (label: string): string | undefined =>
  out
    .split('\n')
    .find((line) => line.startsWith(`SAW ${label} `))
    ?.slice(`SAW ${label} `.length);

describe(testName('unit', 'a module mock ends with the file that made it'), () => {
  test('the mocking file sees its fake, through a relative id resolved against itself', () => {
    expect(saw('a')).toBe('FAKE FAKE');
  });

  test("the next file on the worker sees the real module, past a bare mock.restore() and vi.mock's alias", () => {
    expect(saw('b')?.split(' ').slice(0, 2)).toEqual(['real', 'real']);
  });

  test("a preload's mock is every file's environment, and is not put back", () => {
    expect(saw('b')?.split(' ').slice(2).join(' ')).toBe('PRELOAD FAKE');
  });

  test('a mocked module that could not load fails the next file, naming who mocked it', () => {
    expect(out).toContain('X_TEST_MODULE_MOCK_UNRESTORABLE');
    expect(out).toMatch(/c\.test\.ts\\?" mocked/);
    expect(out).toContain('throws.ts');
    expect(out).toContain('cannot load here');
    expect(out).toMatch(/\(fail\) d/);
    expect(out).toContain('3 pass');
    expect(out).toContain('1 fail');
  });

  test('the fix opens with the command that removes the shared worker', () => {
    const error = new ModuleMockUnrestorableError([
      { file: '/w/c.test.ts', url: '/w/throws.ts', reason: 'boom' },
    ]);
    expect(error).toBeUltimateError('X_TEST_MODULE_MOCK_UNRESTORABLE');
    expect(error.fix.startsWith('x test unit --isolate')).toBe(true);
    expect(error.cause).toContain('"/w/c.test.ts" mocked "/w/throws.ts"');
  });
});

describe(testName('unit', 'the caller of mock.module, read off a stack'), () => {
  test('a frame with a function name and one without', () => {
    expect(callerFile('Error\n    at <anonymous> (/w/app/a.test.ts:3:5)')).toBe('/w/app/a.test.ts');
    expect(callerFile('Error\n    at /w/app/a.test.ts:2:1')).toBe('/w/app/a.test.ts');
  });

  test('a Windows path, and a stack with no frame', () => {
    expect(callerFile('Error\n    at fn (C:\\w\\a.test.ts:3:5)')).toBe('C:\\w\\a.test.ts');
    expect(callerFile('Error')).toBeUndefined();
    expect(callerFile(undefined)).toBeUndefined();
  });
});
