// Who really keeps a reservation alive: the processes with its file open, read from the OS.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no descriptor-level file API, and the fixture must hold one open.
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync } from 'node:fs';
// why: the test's scratch root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import type { ExecResult, Runner } from './exec';
import { holderPids } from './heavy-holders';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'heavy-holders-'));
  dirs.push(dir);
  return dir;
};

const lsof =
  (stdout: string): Runner =>
  async (command): Promise<ExecResult> => ({
    command,
    code: stdout === '' ? 1 : 0,
    ok: stdout !== '',
    stdout,
    stderr: '',
    durationMs: 0,
  });

const NO_PROC = '/no-such-proc';

describe('holderPids', () => {
  test('reads a fake /proc: the processes with the file open, and only those', async () => {
    const root = scratch();
    const file = join(root, 'hold');
    await Bun.write(file, '{}');
    const proc = join(root, 'proc');
    for (const [pid, target] of [
      ['41', file],
      ['42', join(root, 'other')],
      ['43', file],
    ] as const) {
      mkdirSync(join(proc, pid, 'fd'), { recursive: true });
      symlinkSync(target, join(proc, pid, 'fd', '3'));
    }
    mkdirSync(join(proc, 'self', 'fd'), { recursive: true });
    mkdirSync(join(proc, 'sys'));
    expect(await holderPids(file, lsof(''), '/', proc)).toEqual([41, 43]);
  });

  test.skipIf(process.platform !== 'linux')('never counts the asking process', async () => {
    const file = join(scratch(), 'hold');
    await Bun.write(file, '{}');
    const fd = openSync(file, 'r');
    try {
      expect(await holderPids(file, lsof(''), '/')).toEqual([]);
    } finally {
      closeSync(fd);
    }
  });

  test('without /proc it asks lsof', async () => {
    expect(await holderPids('/l/hold', lsof('41\n43\n'), '/', NO_PROC)).toEqual([41, 43]);
  });

  test('lsof finding nobody is an answer; lsof missing is not', async () => {
    expect(await holderPids('/l/hold', lsof(''), '/', NO_PROC)).toEqual([]);
    const missing: Runner = async () => {
      throw Object.assign(new TypeError('no lsof'), { code: 'ENOENT' });
    };
    expect(await holderPids('/l/hold', missing, '/', NO_PROC)).toBeUndefined();
  });
});
