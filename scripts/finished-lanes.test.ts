// `finished-lanes.ts`: the lanes row over injected `gh` and `npm` fixtures — every lane present,
// each one missing, a maint tag off its line, and an unreadable answer.

import { describe, expect, test } from 'bun:test';
import { lanesRow } from './finished-lanes';
import type { Runner } from './finished-rule';
import type { RunResult } from './lib/run';

const answer = (output: string, ok = true): RunResult => ({
  command: [],
  code: ok ? 0 : 1,
  ok,
  output,
  durationMs: 0,
  timedOut: false,
});
const refs =
  (present: readonly string[]): Runner =>
  async (args) => {
    const prefix = (args[1] ?? '').replace('repos/{owner}/{repo}/git/matching-refs/', 'refs/');
    return answer(present.filter((ref) => ref.startsWith(prefix)).join('\n'));
  };
const tags =
  (doc: Record<string, string>): Runner =>
  async () =>
    answer(JSON.stringify(doc));
const ALL = ['refs/heads/next', 'refs/heads/release/30.x'];

describe('finished · lanes-exist', () => {
  test('next, release/<prev>.x and maint-<prev> on its line: green', async () => {
    const row = await lanesRow('31.36.0', '/', {
      gh: refs(ALL),
      npm: tags({ 'maint-30': '30.9.0' }),
    });
    expect(row.verdict).toBe('green');
  });

  test('each missing lane is its own red finding', async () => {
    const row = await lanesRow('31.36.0', '/', { gh: refs([]), npm: tags({}) });
    expect(row.verdict).toBe('red');
    expect(row.findings.map((one) => one.code)).toEqual([
      'X_FINISHED_LANE_ABSENT',
      'X_FINISHED_LANE_ABSENT',
      'X_FINISHED_LANE_ABSENT',
    ]);
  });

  test('a branch that only shares the prefix, or a maint tag off the line, is absent', async () => {
    const gh = refs(['refs/heads/next', 'refs/heads/release/30.xyz']);
    const row = await lanesRow('31.0.0', '/', { gh, npm: tags({ 'maint-30': '31.0.0' }) });
    expect(row.findings).toHaveLength(2);
  });

  test('an npm that answers no document is unverdicted', async () => {
    const npm: Runner = async () => answer('npm error 404', false);
    expect((await lanesRow('31.0.0', '/', { gh: refs(ALL), npm })).verdict).toBe('unverdicted');
  });
});
