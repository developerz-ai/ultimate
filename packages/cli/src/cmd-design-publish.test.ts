import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, no recursive remove and no synchronous directory listing.
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { isUltimateError, UltimateError } from '@ultimat3/core';
import { publishDirectory } from './cmd-design-publish';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'x-publish-'));
  dirs.push(dir);
  return dir;
};

describe('publishDirectory', () => {
  test('the directory appears whole, replacing the previous run — none of its files survive', async () => {
    const parent = scratch();
    const dir = join(parent, 'example-com');
    mkdirSync(dir);
    await Bun.write(join(dir, 'shot-1440-dark.png'), 'old run');
    await publishDirectory(dir, async (building) => {
      expect(building).not.toBe(dir);
      await Bun.write(join(building, 'shot-390-light.png'), 'new run');
    });
    expect(readdirSync(dir)).toEqual(['shot-390-light.png']);
    expect(readdirSync(parent)).toEqual(['example-com']);
  });

  test('a build that fails leaves the previous run intact and no scratch behind', async () => {
    const parent = scratch();
    const dir = join(parent, 'example-com');
    mkdirSync(dir);
    await Bun.write(join(dir, 'reference.json'), 'old');
    const failed = await publishDirectory(dir, async (building) => {
      await Bun.write(join(building, 'reference.json'), 'half');
      // Input to the subject, coded as every failure it is handed in production.
      throw new UltimateError({
        code: 'X_DESIGN_REFERENCE_UNREACHABLE',
        cause: 'the capture died',
        fix: 'x design research https://example.com/',
      });
    }).then(
      () => 'resolved',
      (error: unknown) => (isUltimateError(error) ? error.code : 'other'),
    );
    expect(failed).toBe('X_DESIGN_REFERENCE_UNREACHABLE');
    expect(await Bun.file(join(dir, 'reference.json')).text()).toBe('old');
    expect(readdirSync(parent)).toEqual(['example-com']);
  });

  test('two runs into one directory take turns: the second starts after the first is published', async () => {
    const dir = join(scratch(), 'example-com');
    const order: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = publishDirectory(dir, async (building) => {
      order.push('first:start');
      started();
      await held;
      await Bun.write(join(building, 'a'), '1');
      order.push('first:end');
    });
    const second = publishDirectory(dir, async (building) => {
      order.push('second:start');
      await Bun.write(join(building, 'b'), '2');
    });
    await firstStarted;
    // Event-loop turns, not wall time: unserialised, the second build would start within them.
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['first:start']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
    expect(readdirSync(dir)).toEqual(['b']);
  });

  test('a failed run does not block the next one into the same directory', async () => {
    const dir = join(scratch(), 'example-com');
    await publishDirectory(dir, () => Promise.reject(new TypeError('boom'))).catch(() => undefined);
    await publishDirectory(dir, (building) =>
      Bun.write(join(building, 'ok'), '1').then(() => undefined),
    );
    expect(readdirSync(dir)).toEqual(['ok']);
  });
});
