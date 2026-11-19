// A hop whose codemods named the merge drivers installs them in this clone, as `bun run setup`
// would: the upgrade fixtures read the `X_MERGE_DRIVER_UNSET` it otherwise left as a hand step.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { ExecResult, Runner } from './exec';
import { installMergeDrivers } from './upgrade-merge-drivers';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const app = (attributes: string | undefined): string => {
  const root = mkdtempSync(join(tmpdir(), 'x-upgrade-drivers-'));
  roots.push(root);
  if (attributes !== undefined) writeFileSync(join(root, '.gitattributes'), attributes);
  return root;
};

const answer = (command: readonly string[], ok: boolean): ExecResult => ({
  command,
  code: ok ? 0 : 1,
  ok,
  stdout: '',
  stderr: '',
  durationMs: 0,
});

/** git answers a checkout; `configured` says whether the driver is already in `.git/config`. */
const machine = (configured: boolean) => {
  const calls: string[] = [];
  const runner: Runner = async (command) => {
    calls.push(command.slice(1).join(' '));
    if (command[0] === 'git' && command[1] === 'config') return answer(command, configured);
    return answer(command, true);
  };
  return { calls, runner };
};

const installs = (calls: readonly string[]): number =>
  calls.filter((call) => call.endsWith('merge-driver install --json')).length;

describe('unit · x upgrade installs the merge drivers a codemod named', () => {
  test('a .gitattributes naming an unset driver runs the installed CLI once', async () => {
    const { calls, runner } = machine(false);
    expect(await installMergeDrivers(runner, app('apps/** merge=x-registry\n'))).toBe(true);
    expect(installs(calls)).toBe(1);
  });

  test('a clone that has the driver, or an app that names none, is left alone', async () => {
    const set = machine(true);
    expect(await installMergeDrivers(set.runner, app('a merge=x-registry\n'))).toBe(false);
    const none = machine(false);
    expect(await installMergeDrivers(none.runner, app(undefined))).toBe(false);
    expect(installs([...set.calls, ...none.calls])).toBe(0);
  });
});
