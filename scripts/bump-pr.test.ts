// `scripts/bump-pr.ts` at the `gh` seam, injection-only: the runner is a fake `RunResult`, so no
// test touches the network, a real `gh`, or this checkout. A twin answers open with prTwin's
// whole row, the not-twin titles answer open:false, and every unanswerable lookup is the coded
// refusal — never "none open" as a fact.

import { describe, expect, test } from 'bun:test';
import { bumpPrAt, versionOf } from './bump-pr';
import { askPrArgs } from './lib/release-due-rule';
import type { RunResult } from './lib/run';

// The injected runner never reads it: no test opens the real tree.
const ROOT = '/unused-by-the-injected-runner';

const okRun = (output: string): RunResult => ({
  command: ['gh'],
  code: 0,
  ok: true,
  output,
  durationMs: 1,
  timedOut: false,
});

const failedRun = (code: number, output: string): RunResult => ({
  command: ['gh'],
  code,
  ok: false,
  output,
  durationMs: 1,
  timedOut: false,
});

const timedOutRun = (output: string): RunResult => ({
  command: ['gh'],
  code: null,
  ok: false,
  output,
  durationMs: 30_000,
  timedOut: true,
});

describe('unit · bump-pr · --version', () => {
  test('a missing or ill-formed version is X_CLI_BAD_FLAG before any lookup runs', () => {
    for (const bad of [undefined, '', '27.13', '27.13.3.1', '27.13.3-beta', 'v27.13.3', 'next']) {
      const refused = versionOf(bad);
      expect({ bad, code: typeof refused === 'string' ? refused : refused.code }).toEqual({
        bad,
        code: 'X_CLI_BAD_FLAG',
      });
    }
    expect(versionOf('27.13.3')).toBe('27.13.3');
  });
});

describe('unit · bump-pr · the answer', () => {
  test('a twin answers open:true with prTwin’s whole row, over the one query', async () => {
    const row = { number: 770, title: 'chore: release 27.13.3 (#770)' };
    let asked: readonly string[] = [];
    const answer = await bumpPrAt(ROOT, '27.13.3', async (args) => {
      asked = args;
      return okRun(JSON.stringify([row]));
    });
    // The query is `askPrArgs`'s — the script composes it, never restates it.
    expect(asked).toEqual(askPrArgs('27.13.3'));
    expect(answer).toEqual({ version: '27.13.3', open: true, twin: row });
  });

  test('the ask title, a -beta bump and a longer version answer open:false', async () => {
    for (const title of [
      'Release 27.13.3',
      'chore: release 27.13.3-beta',
      'chore: release 27.13.30',
    ]) {
      const answer = await bumpPrAt(ROOT, '27.13.3', async () =>
        okRun(JSON.stringify([{ number: 1, title }])),
      );
      expect({ title, ...answer }).toEqual({ title, version: '27.13.3', open: false });
    }
  });

  test('a malformed row drops out and what remains still answers', async () => {
    const answer = await bumpPrAt(ROOT, '27.13.3', async () =>
      okRun(
        '[{"number":"7","title":5},770,{"number":771,"title":"chore: release 27.13.3 (#771)"}]',
      ),
    );
    expect(answer).toEqual({
      version: '27.13.3',
      open: true,
      twin: { number: 771, title: 'chore: release 27.13.3 (#771)' },
    });
    const none = await bumpPrAt(ROOT, '27.13.3', async () => okRun('[{"oops":true}]'));
    expect(none).toEqual({ version: '27.13.3', open: false });
  });
});

describe('unit · bump-pr · an unanswerable lookup refuses, never none open', () => {
  test('a non-zero exit is X_GH_COMMAND_FAILED naming the invocation in cause and fix', async () => {
    const answer = await bumpPrAt(ROOT, '27.13.3', async () =>
      failedRun(1, 'gh: Could not resolve to a node'),
    );
    if (!('code' in answer)) return expect.unreachable('a failed run must refuse');
    expect(answer.code).toBe('X_GH_COMMAND_FAILED');
    expect(answer.cause).toBe(
      'gh pr list --state open --search "release 27.13.3 in:title" --json number,title exited 1: gh: Could not resolve to a node',
    );
    expect(answer.fix).toBe(
      'gh pr list --state open --search "release 27.13.3 in:title" --json number,title',
    );
    // The refusal carries no open field at all: an unanswered lookup never reads as a verdict.
    expect('open' in answer).toBe(false);
  });

  test('a run killed at its deadline is X_SPAWN_TIMED_OUT', async () => {
    const answer = await bumpPrAt(ROOT, '27.13.3', async () =>
      timedOutRun('X_SPAWN_TIMED_OUT: gh pr list did not finish within 30000 ms and was killed'),
    );
    if (!('code' in answer)) return expect.unreachable('a timed-out run must refuse');
    expect(answer.code).toBe('X_SPAWN_TIMED_OUT');
    expect(answer.cause).toContain('"release 27.13.3 in:title"');
    expect(answer.fix).toContain('"release 27.13.3 in:title"');
  });

  test('a gh that cannot start at all is X_GH_COMMAND_FAILED, never an empty answer', async () => {
    // The spawn's own failure is a FOREIGN error, handed over as a rejection — a `throw new Error`
    // from a test reads as the test's own verdict (X_TEST_BARE_ERROR), not as the fixture it is.
    const answer = await bumpPrAt(ROOT, '27.13.3', () =>
      Promise.reject(new Error('Failed to spawn: gh')),
    );
    if (!('code' in answer)) return expect.unreachable('an unrunnable gh must refuse');
    expect(answer.code).toBe('X_GH_COMMAND_FAILED');
    expect(answer.cause).toContain('Failed to spawn: gh');
    expect(answer.fix).toContain('"release 27.13.3 in:title"');
  });

  test('an ok run whose body is not the promised rows is X_GH_COMMAND_FAILED, never none open', async () => {
    // run() folds stderr into a successful run's output and parsePrIssues reads tolerantly, so a
    // gh warning or a truncated answer used to fall through as [] and read as "none open".
    for (const output of ['warning: gh configuration notice', '']) {
      const answer = await bumpPrAt(ROOT, '27.13.3', async () => okRun(output));
      if (!('code' in answer)) return expect.unreachable('a body that is not the rows must refuse');
      expect(answer.code).toBe('X_GH_COMMAND_FAILED');
      expect(answer.cause).toContain(
        'gh pr list --state open --search "release 27.13.3 in:title" --json number,title',
      );
      expect(answer.fix).toBe(
        'gh pr list --state open --search "release 27.13.3 in:title" --json number,title',
      );
      // The refusal carries no open field at all: an unanswered lookup never reads as a verdict.
      expect('open' in answer).toBe(false);
    }
  });
});
