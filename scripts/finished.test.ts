// `finished.ts`: `--check` passes only on every row green, an unverdicted row fails it like a red
// one, and on the real tree a `gh` and `npm` that cannot read leave every GitHub row unverdicted —
// never green.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { finishedResult, finishedRows } from './finished';
import { FINISHED_ROW_IDS, green, type Runner, unverdicted } from './finished-rule';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const allGreen = FINISHED_ROW_IDS.map((id) => green(id, 'read'));

describe('finished · --check', () => {
  test('every row green: finished, and --check passes', () => {
    const result = finishedResult(allGreen, true);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ finished: true });
  });

  test('one unverdicted row fails --check exactly as a red one does', () => {
    const rows = [...allGreen.slice(1), unverdicted('no-stub', 'gh', 'HTTP 401')];
    const result = finishedResult(rows, true);
    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({ finished: false });
    expect(result.findings?.map((one) => one.code)).toEqual(['X_FINISHED_UNVERDICTED']);
  });

  test('without --check the table is reported and the exit is clean', () => {
    expect(finishedResult([unverdicted('no-stub', 'gh', 'x')], false).ok).toBe(true);
  });

  test('no rows is never finished', () => {
    expect(finishedResult([], true).ok).toBe(false);
  });
});

describe('finished · the real tree with no GitHub', () => {
  test('every row answers in order, and no GitHub row is green', async () => {
    const refusing: Runner = async (args) => ({
      command: args,
      code: 1,
      ok: false,
      output: 'gh: To get started with GitHub CLI, please run: gh auth login',
      durationMs: 0,
      timedOut: false,
    });
    const rows = await finishedRows(repoRoot(), { gh: refusing, npm: refusing });
    expect(rows.map((row) => row.row)).toEqual([...FINISHED_ROW_IDS]);
    const github = [
      'every-shape-gates',
      'tests-deterministic',
      'range-tested',
      'lanes-exist',
      'loop-closed',
    ];
    for (const row of rows.filter((one) => github.includes(one.row))) {
      expect([row.row, row.verdict]).toEqual([row.row, 'unverdicted']);
    }
  });
});
