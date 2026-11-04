// `--dry-run` writes nothing, anywhere, and reports the edits it would have made; a flag the
// generator does not know is refused, never ignored; and two runs at once never lose one's edit.
// A `--dry-run` that wrote three files with placeholder text is how this file came to exist.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun has no recursive readdir of its own.
import { readdir } from 'node:fs/promises';
import { REPO_SCAN_TIMEOUT_MS } from './lib/run';
import { ScriptError } from './lib/script-error';
import { newErrorCode, WIKI_PAGE } from './new-error-code';
import { fixtureRoot, read, refusal, removeFixtureRoots } from './new-error-code.fixtures';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);
afterAll(removeFixtureRoots);

const money = (...rest: string[]) => named('X_MONEY_DRY_PROBE', ...rest);
const named = (code: string, ...rest: string[]) => [
  code,
  '--package',
  'money',
  '--title',
  'a title',
  '--cause',
  'what usually makes it happen',
  '--fix',
  'x doctor --json',
  '--status',
  '422',
  ...rest,
];

/** Every file under `dir`, relative, with a hash of its bytes. */
async function hashes(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const files = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of files) {
    if (!entry.isFile()) continue;
    const path = `${entry.parentPath}/${entry.name}`;
    out[path.slice(dir.length + 1)] = Bun.hash(await Bun.file(path).arrayBuffer()).toString();
  }
  return out;
}

describe('--dry-run', () => {
  test('writes nothing: every file in the tree hashes the same before and after', async () => {
    const dir = await fixtureRoot();
    const before = await hashes(dir);

    const result = await newErrorCode(dir, money('--dry-run'));

    expect(await hashes(dir)).toEqual(before);
    expect(result.dryRun).toBe(true);
    expect(result.written).toEqual([]);
  });

  test('reports the edits it would make: each file, and the lines it would add there', async () => {
    const dir = await fixtureRoot();
    const result = await newErrorCode(dir, money('--dry-run'));

    expect(result.planned.map((edit) => edit.path)).toEqual([
      'packages/money/src/errors.ts',
      WIKI_PAGE,
      expect.stringContaining('error-map'),
    ]);
    const wiki = result.planned.find((edit) => edit.path === WIKI_PAGE);
    expect(wiki?.added).toEqual([
      '| `X_MONEY_DRY_PROBE` | a title | what usually makes it happen | `x doctor --json` |',
    ]);
  });

  test('without it the same run writes, and reports what it wrote', async () => {
    const dir = await fixtureRoot();
    const before = await hashes(dir);
    const result = await newErrorCode(dir, money());
    expect(result.dryRun).toBe(false);
    expect(result.written).toEqual(result.planned.map((edit) => edit.path));
    expect(await hashes(dir)).not.toEqual(before);
  });
});

describe('an unknown flag', () => {
  test('is refused before anything is written, never ignored', async () => {
    const dir = await fixtureRoot();
    const before = await hashes(dir);
    expect(await refusal(newErrorCode(dir, money('--dryrun')))).toBe('X_NEW_ERROR_CODE_INVALID');
    expect(await hashes(dir)).toEqual(before);
  });
});

describe('two runs at once', () => {
  test('one writes, the other is refused, and no edit is lost', async () => {
    const dir = await fixtureRoot();
    const [a, b] = await Promise.allSettled([
      newErrorCode(dir, named('X_MONEY_RACE_A')),
      newErrorCode(dir, named('X_MONEY_RACE_B')),
    ]);
    const outcomes = [a, b].map((one) => one?.status);
    expect(outcomes.sort()).toEqual(['fulfilled', 'rejected']);
    const lost = [a, b].find((one) => one?.status === 'rejected');
    expect(
      lost?.status === 'rejected' && lost.reason instanceof ScriptError && lost.reason.code,
    ).toBe('X_NEW_ERROR_CODE_INVALID');
    const won = a?.status === 'fulfilled' ? 'X_MONEY_RACE_A' : 'X_MONEY_RACE_B';
    const page = await read(dir, WIKI_PAGE);
    // Every file the winner planned holds its code: the loser overwrote none of them.
    expect(page).toContain(`| \`${won}\` |`);
    expect(await read(dir, 'packages/money/src/errors.ts')).toContain(won);
  });
});
