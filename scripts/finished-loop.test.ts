// `finished-loop.ts`: the loop-closed row over an injected `gh` — the maintainer cut the release
// and repaired main, a person did either, main still red, and an unreadable answer.

import { describe, expect, test } from 'bun:test';
import { loopRow, MAINTAINER_LOGIN } from './finished-loop';
import type { Runner } from './finished-rule';
import type { RunResult } from './lib/run';

const answer = (doc: unknown, ok = true): RunResult => ({
  command: [],
  code: ok ? 0 : 1,
  ok,
  output: ok ? JSON.stringify(doc) : 'HTTP 401',
  durationMs: 0,
  timedOut: false,
});
const pr = (login: string, url: string) => [{ number: 1, author: { login }, url }];
const RUNS = [
  { conclusion: 'success', headSha: 'c3', url: 'r3' },
  { conclusion: 'success', headSha: 'c2', url: 'r2' },
  { conclusion: 'failure', headSha: 'c1', url: 'r1' },
];
const fakeGh =
  (input: { release: unknown; runs: unknown; repairer?: string }): Runner =>
  async (args) => {
    const line = args.join(' ');
    if (line.includes('chore: release')) return answer(input.release);
    if (line.startsWith('run list')) return answer(input.runs);
    if (line.includes('--search c2')) return answer(pr(input.repairer ?? MAINTAINER_LOGIN, 'p2'));
    return answer(undefined, false);
  };
const bot = pr(MAINTAINER_LOGIN, 'p9');

describe('finished · loop-closed', () => {
  test('the bot cut the newest release and repaired the newest red: green', async () => {
    expect((await loopRow('/', fakeGh({ release: bot, runs: RUNS }))).verdict).toBe('green');
  });

  test('no red push at all leaves only the release half to read', async () => {
    const runs = RUNS.slice(0, 2);
    expect((await loopRow('/', fakeGh({ release: bot, runs }))).verdict).toBe('green');
  });

  test('a release a person cut is red', async () => {
    const row = await loopRow('/', fakeGh({ release: pr('someone', 'p8'), runs: RUNS }));
    expect(row.verdict).toBe('red');
    expect(row.findings[0]?.code).toBe('X_FINISHED_LOOP_OPEN');
  });

  test('a red a person repaired, or a red not yet repaired, is red', async () => {
    const human = await loopRow('/', fakeGh({ release: bot, runs: RUNS, repairer: 'someone' }));
    expect(human.findings[0]?.cause).toContain('repaired by someone');
    const open = await loopRow('/', fakeGh({ release: bot, runs: RUNS.slice(2) }));
    expect(open.findings[0]?.cause).toContain('no push has repaired it yet');
  });

  test('a gh that cannot read is unverdicted', async () => {
    expect(
      (await loopRow('/', fakeGh({ release: { message: 'Bad credentials' }, runs: RUNS }))).verdict,
    ).toBe('unverdicted');
  });
});
