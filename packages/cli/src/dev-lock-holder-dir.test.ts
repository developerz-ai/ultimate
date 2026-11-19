// The directory a port's holder runs in: what lets a reader tell "my server" from a neighbour's.

import { describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs'; // why: Bun ships no realpath.
import { holderDir, portOwner } from './dev-lock-holder-dir';
import type { ExecResult, Runner } from './exec';

const answer = (stdout: string): Runner => {
  return async (command): Promise<ExecResult> => ({
    command,
    code: 0,
    ok: true,
    stdout,
    stderr: '',
    durationMs: 0,
  });
};

describe('holderDir', () => {
  test.skipIf(process.platform !== 'linux')('reads a live process from /proc', async () => {
    expect(await holderDir(process.pid)).toBe(realpathSync(process.cwd()));
  });

  test('without /proc it asks lsof, whose cwd line starts with n', async () => {
    const dir = await holderDir(9, answer('p9\nfcwd\nn/work/app\n'), '/no-such-proc');
    expect(dir).toBe('/work/app');
  });

  test('a process it cannot read has no directory', async () => {
    const refused: Runner = async () => expect.unreachable('lsof is not asked with /proc present');
    if (process.platform === 'linux') {
      expect(await holderDir(2 ** 22 + 1, refused)).toBeUndefined();
    }
    expect(await holderDir(9, answer(''), '/no-such-proc')).toBeUndefined();
  });
});

describe('portOwner', () => {
  test('no pid: nothing more to ask', async () => {
    expect(await portOwner(3000, answer(''), async () => ({}))).toEqual({});
  });

  test('a pid gains its directory', async () => {
    const owner = await portOwner(
      3000,
      answer('p9\nfcwd\nn/work/app\n'),
      async () => ({
        pid: 9,
        command: 'bun',
      }),
      '/no-such-proc',
    );
    expect(owner).toEqual({ pid: 9, command: 'bun', cwd: '/work/app' });
  });
});
