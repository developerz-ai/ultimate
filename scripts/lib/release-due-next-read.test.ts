// The `next` lane's GitHub reads, against a fake `gh` that answers by argument: a 404 is an absent
// branch, every other failure is no answer, and only a completed green run AT the tip is green.

import { describe, expect, test } from 'bun:test';
import {
  type GhLookup,
  NEXT_BRANCH_ARGS,
  NEXT_COMPARE_ARGS,
  NEXT_RUNS_ARGS,
  readBranch,
  readCi,
  readCompare,
  readNextFacts,
  readPrTitles,
} from './release-due-next-read';
import type { RunResult } from './run';

const TIP = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

const answer = (output: string, ok = true, timedOut = false): RunResult => ({
  command: ['gh'],
  code: ok ? 0 : 1,
  ok,
  output,
  durationMs: 1,
  timedOut,
});

describe('unit · release-due-next-read · the branch', () => {
  test('a sha is present; a 404 is absent; anything else is no answer', () => {
    expect(readBranch(answer(`${TIP}\n`))).toEqual({ kind: 'present', sha: TIP });
    expect(readBranch(answer('gh: Branch not found (HTTP 404)', false)).kind).toBe('absent');
    expect(readBranch(answer('HTTP 502: Bad Gateway', false)).kind).toBe('unreadable');
    expect(readBranch(answer('HTTP 404', false, true)).kind).toBe('unreadable');
    expect(readBranch(answer('not a sha')).kind).toBe('unreadable');
    expect(readBranch(undefined).kind).toBe('unreadable');
  });
});

describe('unit · release-due-next-read · the compare', () => {
  test('two counts or nothing', () => {
    expect(readCompare(answer('{"behind":3,"files":7}'))).toEqual({
      changedFiles: 7,
      behindMain: 3,
    });
    expect(readCompare(answer('{"behind":3}'))).toEqual({});
    expect(readCompare(answer('{"behind":-1,"files":2}'))).toEqual({});
    expect(readCompare(answer('oops', false))).toEqual({});
  });
});

describe('unit · release-due-next-read · ci.yml at the tip', () => {
  const runs = (rows: readonly object[]): RunResult => answer(JSON.stringify(rows));
  test('the newest run at the tip decides, never a green one at an older sha', () => {
    const url = 'https://example.test/r';
    expect(
      readCi(runs([{ headSha: OLD, status: 'completed', conclusion: 'success', url }]), TIP),
    ).toEqual({ kind: 'none' });
    expect(
      readCi(
        runs([
          { headSha: TIP, status: 'completed', conclusion: 'failure', url },
          { headSha: TIP, status: 'completed', conclusion: 'success', url },
        ]),
        TIP,
      ),
    ).toEqual({ kind: 'red', conclusion: 'failure', url });
    expect(readCi(runs([{ headSha: TIP, status: 'in_progress', url }]), TIP).kind).toBe('running');
    expect(
      readCi(runs([{ headSha: TIP, status: 'completed', conclusion: 'success', url }]), TIP),
    ).toEqual({ kind: 'green', url });
    expect(readCi(answer('{}'), TIP).kind).toBe('unreadable');
    expect(readCi(undefined, TIP).kind).toBe('unreadable');
  });
});

describe('unit · release-due-next-read · the open PRs', () => {
  test('rows are titles; a failed or shapeless answer is no answer, never none open', () => {
    expect(readPrTitles(answer('[{"number":1,"title":"chore: release 32.0.0"}]'))).toEqual([
      'chore: release 32.0.0',
    ]);
    expect(readPrTitles(answer('[]'))).toEqual([]);
    expect(readPrTitles(answer('nope'))).toBeUndefined();
    expect(readPrTitles(answer('[]', false))).toBeUndefined();
  });
});

describe('unit · release-due-next-read · the facts together', () => {
  const fake =
    (by: Readonly<Record<string, RunResult>>, asked: string[] = []): GhLookup =>
    async (args) => {
      const key = args.slice(0, 2).join(' ');
      asked.push(key);
      return by[key];
    };

  test('an absent branch asks nothing more', async () => {
    const asked: string[] = [];
    const facts = await readNextFacts(
      fake({ [NEXT_BRANCH_ARGS.slice(0, 2).join(' ')]: answer('HTTP 404', false) }, asked),
      '32.0.0',
    );
    expect(facts.branch.kind).toBe('absent');
    expect(asked).toEqual(['api repos/{owner}/{repo}/branches/next']);
  });

  test('a present branch reads compare, runs and PRs; a lookup that throws is no answer', async () => {
    const facts = await readNextFacts(
      fake({
        [NEXT_BRANCH_ARGS.slice(0, 2).join(' ')]: answer(TIP),
        [NEXT_COMPARE_ARGS.slice(0, 2).join(' ')]: answer('{"behind":0,"files":5}'),
        [NEXT_RUNS_ARGS.slice(0, 2).join(' ')]: answer(
          JSON.stringify([{ headSha: TIP, status: 'completed', conclusion: 'success', url: 'u' }]),
        ),
        'pr list': answer('[]'),
      }),
      '32.0.0',
    );
    expect(facts).toEqual({
      branch: { kind: 'present', sha: TIP },
      changedFiles: 5,
      behindMain: 0,
      ci: { kind: 'green', url: 'u' },
      openPrTitles: [],
    });
    // A spawn that rejects (the binary missing, say) is input here, handed to the code under test.
    const thrown = await readNextFacts(
      (args) =>
        args[1] === NEXT_BRANCH_ARGS[1]
          ? Promise.resolve(answer(TIP))
          : Promise.reject(new TypeError('spawn failed')),
      '32.0.0',
    );
    expect(thrown.changedFiles).toBeUndefined();
    expect(thrown.ci.kind).toBe('unreadable');
    expect(thrown.openPrTitles).toBeUndefined();
  });
});
