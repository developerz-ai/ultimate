// A package that keeps its titles in TWO modules — the page's, in every island chunk, and the
// server's, in none (`@ultimat3/realtime`) — gets every new code placed by an explicit choice:
// `--browser` or `--server-only`, exactly one. Any other package takes neither.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun has no mkdir of its own.
import { mkdir } from 'node:fs/promises';
import { REPO_SCAN_TIMEOUT_MS } from './lib/run';
import { newErrorCode } from './new-error-code';
import { fixtureRoot, ROOT, read, refusal, removeFixtureRoots } from './new-error-code.fixtures';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);
afterAll(removeFixtureRoots);

const PAGE = 'packages/realtime/src/error-titles.ts';
const SERVER = 'packages/realtime/src/error-titles-server.ts';

/** The fixture tree plus realtime's real constructors and both titles modules. */
async function withRealtime(): Promise<string> {
  const dir = await fixtureRoot();
  await mkdir(`${dir}/packages/realtime/src`, { recursive: true });
  for (const file of ['packages/realtime/src/errors.ts', PAGE, SERVER]) {
    await Bun.write(`${dir}/${file}`, Bun.file(`${ROOT}/${file}`));
  }
  return dir;
}

const realtime = (code: string, ...rest: string[]) => [
  code,
  '--package',
  'realtime',
  '--title',
  'a title',
  '--cause',
  'what usually makes it happen',
  '--fix',
  'x doctor realtime',
  '--off-socket',
  ...rest,
];

describe('where a realtime code is titled', () => {
  test('--server-only writes the server module, and the page module is untouched', async () => {
    const dir = await withRealtime();
    const page = await read(dir, PAGE);
    const result = await newErrorCode(dir, realtime('X_REALM_SERVER_PROBE', '--server-only'));
    expect(result.errorsPath).toBe(SERVER);
    expect(await read(dir, SERVER)).toContain("X_REALM_SERVER_PROBE: 'a title'");
    expect(await read(dir, SERVER)).toContain("  'X_REALM_SERVER_PROBE',");
    expect(await read(dir, PAGE)).toBe(page);
  });

  test('--browser writes the page module', async () => {
    const dir = await withRealtime();
    const result = await newErrorCode(dir, realtime('X_REALM_PAGE_PROBE', '--browser'));
    expect(result.errorsPath).toBe(PAGE);
    expect(await read(dir, PAGE)).toContain("X_REALM_PAGE_PROBE: 'a title'");
  });

  test('neither, or both, is refused and writes nothing', async () => {
    const dir = await withRealtime();
    const page = await read(dir, PAGE);
    expect(await refusal(newErrorCode(dir, realtime('X_REALM_NONE_PROBE')))).toBe(
      'X_NEW_ERROR_CODE_INVALID',
    );
    expect(
      await refusal(
        newErrorCode(dir, realtime('X_REALM_BOTH_PROBE', '--browser', '--server-only')),
      ),
    ).toBe('X_NEW_ERROR_CODE_INVALID');
    expect(await read(dir, PAGE)).toBe(page);
  });
});

test('a package with one titles module refuses either flag', async () => {
  const dir = await fixtureRoot();
  const money = (flag: string) => [
    'X_MONEY_REALM_PROBE',
    '--package',
    'money',
    '--title',
    't',
    '--cause',
    'c',
    '--fix',
    'x doctor --json',
    '--status',
    '422',
    flag,
  ];
  expect(await refusal(newErrorCode(dir, money('--server-only')))).toBe('X_NEW_ERROR_CODE_INVALID');
  expect(await refusal(newErrorCode(dir, money('--browser')))).toBe('X_NEW_ERROR_CODE_INVALID');
});
