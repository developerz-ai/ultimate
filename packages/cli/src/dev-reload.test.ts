// One rebuild at a time, and the last tick wins. Measured with a 45ms drip — a slow `git checkout`,
// a formatter walking files, `x db gen` — 40 files ran 40 overlapping rebuilds, each assigning
// `state.manifest` and `state.islands` in COMPLETION order, so an earlier slower tick could land on
// top of a newer one and leave the dev server serving a manifest for source that no longer exists.

import { describe, expect, test } from 'bun:test';
import { coalesceReloads } from './dev-reload';

describe('coalesceReloads', () => {
  test('ticks arriving during a rebuild collapse into exactly one more', async () => {
    const started: string[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reload = coalesceReloads(async (file) => {
      started.push(file);
      if (started.length === 1) await gate;
    });

    reload('a.tsx');
    expect(started).toEqual(['a.tsx']);
    for (const file of ['b.tsx', 'c.tsx', 'd.tsx']) reload(file);
    // Still one, because the first has not settled.
    expect(started).toEqual(['a.tsx']);
    release();
    await Bun.sleep(5);
    expect(started).toEqual(['a.tsx', 'd.tsx']);
  });

  test('a tick after the rebuild settles starts a new one', async () => {
    const started: string[] = [];
    const reload = coalesceReloads(async (file) => {
      started.push(file);
      await Bun.sleep(1);
    });
    reload('a.tsx');
    await Bun.sleep(10);
    reload('b.tsx');
    await Bun.sleep(10);
    expect(started).toEqual(['a.tsx', 'b.tsx']);
  });

  // A save that will not build is a finding, never a wedged watcher: the coalescer that stopped
  // starting rebuilds after the first failure would need a restart to notice the fix.
  test('a rebuild that rejects does not wedge the next one', async () => {
    const started: string[] = [];
    const caught: unknown[] = [];
    const reload = coalesceReloads(
      async (file) => {
        started.push(file);
        await Bun.sleep(1);
        throw new TypeError(`broken ${file}`);
      },
      (error) => caught.push(error),
    );
    reload('a.tsx');
    await Bun.sleep(10);
    reload('b.tsx');
    await Bun.sleep(10);
    expect(started).toEqual(['a.tsx', 'b.tsx']);
    expect(caught).toHaveLength(2);
  });

  test('a synchronous throw is reported and does not wedge the next one either', async () => {
    const caught: unknown[] = [];
    const started: string[] = [];
    const reload = coalesceReloads(
      (file) => {
        started.push(file);
        throw new TypeError(`broken ${file}`);
      },
      (error) => caught.push(error),
    );
    reload('a.tsx');
    await Bun.sleep(5);
    reload('b.tsx');
    await Bun.sleep(5);
    expect(started).toEqual(['a.tsx', 'b.tsx']);
    expect(caught).toHaveLength(2);
  });
});
