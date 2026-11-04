// `writePlanned`: all edits or none, refused when a file moved after the plan read it, and no temp
// file left behind either way.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, readdir or rm of its own.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
// why: Bun has no tmpdir() of its own.
import { tmpdir } from 'node:os';
import type { Snapshot } from './planned-writes';
import { snapshotReader, writePlanned } from './planned-writes';
import { ScriptError } from './script-error';

const made: string[] = [];
afterAll(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function root(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/planned-writes-`);
  made.push(dir);
  await Bun.write(`${dir}/a.txt`, 'a0');
  await Bun.write(`${dir}/b.txt`, 'b0');
  return dir;
}

const moved = (changed: readonly string[]) =>
  new ScriptError({ code: 'X_PROBE_MOVED', cause: changed.join(', '), fix: 'rerun' });

describe('writePlanned', () => {
  test('writes every edit when nothing moved, and leaves no temp behind', async () => {
    const dir = await root();
    const snapshot: Snapshot = new Map();
    const read = snapshotReader(dir, snapshot);
    expect(await read('a.txt')).toBe('a0');
    expect(await read('new.txt')).toBeUndefined();

    await writePlanned(
      dir,
      [
        { path: 'a.txt', text: 'a1' },
        { path: 'new.txt', text: 'n1' },
      ],
      snapshot,
      moved,
    );

    expect(await Bun.file(`${dir}/a.txt`).text()).toBe('a1');
    expect(await Bun.file(`${dir}/new.txt`).text()).toBe('n1');
    expect((await readdir(dir)).sort()).toEqual(['a.txt', 'b.txt', 'new.txt']);
  });

  test('a file that moved since the read refuses the whole set and writes none of it', async () => {
    const dir = await root();
    const snapshot: Snapshot = new Map();
    const read = snapshotReader(dir, snapshot);
    await read('a.txt');
    await read('b.txt');
    await Bun.write(`${dir}/b.txt`, 'b-other');

    const error = await writePlanned(
      dir,
      [
        { path: 'a.txt', text: 'a1' },
        { path: 'b.txt', text: 'b1' },
      ],
      snapshot,
      moved,
    ).then(
      () => expect.unreachable('b.txt moved under the plan'),
      (thrown: unknown) => thrown,
    );

    expect(error instanceof ScriptError ? [error.code, error.cause] : error).toEqual([
      'X_PROBE_MOVED',
      'b.txt',
    ]);
    expect(await Bun.file(`${dir}/a.txt`).text()).toBe('a0');
    expect(await Bun.file(`${dir}/b.txt`).text()).toBe('b-other');
    expect((await readdir(dir)).sort()).toEqual(['a.txt', 'b.txt']);
  });

  test('the snapshot keeps the FIRST text read, so a later read cannot launder a change', async () => {
    const dir = await root();
    const snapshot: Snapshot = new Map();
    const read = snapshotReader(dir, snapshot);
    await read('a.txt');
    await Bun.write(`${dir}/a.txt`, 'a-other');
    expect(await read('a.txt')).toBe('a0');
  });
});
