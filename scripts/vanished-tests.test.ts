// `vanished-tests`: a test title present at the base and gone at HEAD, per directory. A warning
// when the directory's own source changed too (tests leave with their code), `X_TEST_VANISHED`
// when it did not — a split or rewrite that dropped cases, the shape that lost 19 tests in mail
// and render with only a review bot noticing.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun exposes no tmpdir().
import { TEMP_TREE_GIT_ENV, tempTrees } from '../packages/testing/src/temp-tree';
import { run } from './lib/run';
import { renamedTitles, vanishedGaps, vanishedTests } from './vanished-tests';

describe('vanishedGaps', () => {
  test('a title gone from a directory whose source did not change is an error', () => {
    const gaps = vanishedGaps(
      new Map([['packages/mail/src', { base: ['a', 'b', 'b'], head: ['a', 'b'] }]]),
      new Set(),
    );
    expect(gaps).toEqual([{ dir: 'packages/mail/src', title: 'b', blocking: true }]);
  });

  test('the same loss beside a changed or deleted source file is a warning', () => {
    const gaps = vanishedGaps(
      new Map([['packages/mail/src', { base: ['a'], head: [] }]]),
      new Set(['packages/mail/src']),
    );
    expect(gaps).toEqual([{ dir: 'packages/mail/src', title: 'a', blocking: false }]);
  });

  test('a title that moved to another file of the same directory, or was added, is no gap', () => {
    const gaps = vanishedGaps(
      new Map([['packages/render/src', { base: ['x', 'y'], head: ['y', 'x', 'z'] }]]),
      new Set(),
    );
    expect(gaps).toEqual([]);
  });
});

const trees = tempTrees();
afterAll(() => trees.dispose());

const git = async (cwd: string, ...args: string[]) => {
  const ran = await run(['git', ...args], { cwd, env: { ...Bun.env, ...TEMP_TREE_GIT_ENV } });
  if (!ran.ok) expect.unreachable(`git ${args.join(' ')}: ${ran.output}`);
};

const SUITE = "test('sends', () => {});\ntest('retries', () => {});\ntest('bounces', () => {});\n";

async function repo(): Promise<string> {
  const dir = trees.make('vanished-tests-');
  await git(dir, 'init', '-q', '-b', 'work');
  await Bun.write(`${dir}/packages/mail/src/send.ts`, 'export const send = 1;\n');
  await Bun.write(`${dir}/packages/mail/src/send.test.ts`, SUITE);
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-q', '-m', 'base');
  await git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return dir;
}

describe('vanishedTests, over a real repository', () => {
  test('a split that drops a case is X_TEST_VANISHED; the moved ones are not', async () => {
    const dir = await repo();
    await Bun.write(`${dir}/packages/mail/src/send.test.ts`, "test('sends', () => {});\n");
    await Bun.write(`${dir}/packages/mail/src/send-retry.test.ts`, "test('retries', () => {});\n");
    const result = await vanishedTests(dir);
    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_TEST_VANISHED', 'packages/mail/src'],
    ]);
    expect(result.findings[0]?.cause).toContain('bounces');
    expect(result.warnings).toEqual([]);
  });

  test('a case leaving with its deleted source is a warning, and the run is ok', async () => {
    const dir = await repo();
    await Bun.write(`${dir}/packages/mail/src/send.test.ts`, "test('sends', () => {});\n");
    await Bun.write(`${dir}/packages/mail/src/send.ts`, 'export const send = 2;\n');
    const result = await vanishedTests(dir);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.warnings.map((finding) => finding.cause)).toEqual([
      expect.stringContaining('retries'),
      expect.stringContaining('bounces'),
    ]);
  });

  test('a deleted test file counts at the base; an explicit base ref is honoured', async () => {
    const dir = await repo();
    await run(['git', 'rm', '-q', 'packages/mail/src/send.test.ts'], { cwd: dir });
    const result = await vanishedTests(dir, 'HEAD');
    expect(result.findings.map((finding) => finding.code)).toEqual(
      Array(3).fill('X_TEST_VANISHED'),
    );
  });

  test('no base is refused, never read as nothing vanished', async () => {
    const dir = await repo();
    await git(dir, 'update-ref', '-d', 'refs/remotes/origin/main');
    const result = await vanishedTests(dir);
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.code).toBe('X_PREFLIGHT_BASE_MISSING');
  });
});

describe('a test renamed on purpose says what it was called', () => {
  test('a // was: line names the old title, and only that line counts', () => {
    const source = [
      '  // was: "row 857 of the wiki page carries that fix verbatim"',
      "  test('its row on the mcp error page carries that fix verbatim', () => {});",
      '  const note = \'// was: "not a declaration"\';',
    ].join('\n');
    expect(renamedTitles(source)).toEqual(['row 857 of the wiki page carries that fix verbatim']);
  });

  test('the old title it names is no vanished case', () => {
    const titles = new Map([
      [
        'packages/mcp/src',
        { base: ['row 857 of the wiki page'], head: ['row 857 of the wiki page'] },
      ],
    ]);
    expect(vanishedGaps(titles, new Set())).toEqual([]);
  });
});
