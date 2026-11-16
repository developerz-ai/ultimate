// new-error-code's refusals: every one is coded and leaves every file as found, because a
// registration without its row is the gap the generator exists to close.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { ownerPage } from './lib/error-code-pages';
import { REPO_SCAN_TIMEOUT_MS } from './lib/run';

// Reads the real tree or spawns real processes, so it runs on the repo-scan backstop.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);
afterAll(removeFixtureRoots);

import { ScriptError } from './lib/script-error';
import { newErrorCode, WIKI_PAGE } from './new-error-code';
import { fixtureRoot, read, refusal, removeFixtureRoots } from './new-error-code.fixtures';

describe('every refusal is coded and writes nothing', () => {
  test('an errors.ts in no recognised shape is refused by name', async () => {
    const dir = await fixtureRoot();
    const before = [await read(dir, 'packages/odd/src/errors.ts'), await read(dir, WIKI_PAGE)];
    const code = await refusal(
      newErrorCode(dir, [
        'X_ODD_THING',
        '--package',
        'odd',
        '--title',
        't',
        '--cause',
        'what usually makes it happen',
        '--fix',
        'f',
      ]),
    );
    expect(code).toBe('X_NEW_ERROR_CODE_PATTERN_UNKNOWN');
    expect([await read(dir, 'packages/odd/src/errors.ts'), await read(dir, WIKI_PAGE)]).toEqual(
      before,
    );
  });

  test('a code already registered, or already on the page, is refused', async () => {
    const dir = await fixtureRoot();
    const argv = (code: string) => [
      code,
      '--package',
      'money',
      '--title',
      't',
      '--cause',
      'what usually makes it happen',
      '--fix',
      'f',
      '--status',
      '400',
    ];
    expect(await refusal(newErrorCode(dir, argv('X_CURRENCY_UNKNOWN')))).toBe(
      'X_NEW_ERROR_CODE_EXISTS',
    );
    expect(await refusal(newErrorCode(dir, argv('X_ABORTED')))).toBe('X_NEW_ERROR_CODE_EXISTS');
    // …and the refusal on the PAGE left the package file alone, though it was planned first.
    expect(await read(dir, 'packages/money/src/errors.ts')).not.toContain("'X_ABORTED'");
  });

  test('a malformed code, a missing flag, an unknown package or a --section is refused', async () => {
    const dir = await fixtureRoot();
    const ok = [
      '--package',
      'money',
      '--title',
      't',
      '--cause',
      'what makes it happen',
      '--fix',
      'f',
      '--status',
      '400',
    ];
    expect(await refusal(newErrorCode(dir, ['x_lower', ...ok]))).toBe('X_NEW_ERROR_CODE_INVALID');
    expect(await refusal(newErrorCode(dir, ['X_A_B', '--package', 'money']))).toBe(
      'X_NEW_ERROR_CODE_INVALID',
    );
    expect(
      await refusal(
        newErrorCode(dir, [
          'X_A_B',
          '--package',
          'nope',
          '--title',
          't',
          '--cause',
          'what makes it happen',
          '--fix',
          'f',
        ]),
      ),
    ).toBe('X_NEW_ERROR_CODE_INVALID');
    expect(await refusal(newErrorCode(dir, ['X_A_B', ...ok, '--section', 'No such section']))).toBe(
      'X_NEW_ERROR_CODE_INVALID',
    );
  });

  test('--section is retired: refused by name, pointing at the owner page, nothing written', async () => {
    const dir = await fixtureRoot();
    const before = await read(dir, ownerPage('money'));
    const argv = [
      'X_MONEY_PROBE',
      '--package',
      'money',
      '--title',
      't',
      '--cause',
      'c',
      '--fix',
      'f',
    ];
    const run = newErrorCode(dir, [...argv, '--status', '400', '--section', 'Money']);
    const error = await run.then(
      () => expect.unreachable('a --section run wrote'),
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ScriptError);
    expect((error as ScriptError).cause).toContain('--section is retired');
    expect((error as ScriptError).cause).toContain(ownerPage('money'));
    expect(await read(dir, ownerPage('money'))).toBe(before);
  });
});
