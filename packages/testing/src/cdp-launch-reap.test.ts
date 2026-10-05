// Nothing of a launched browser may outlive its close. POSIX has a process group to signal; Windows
// has neither the group nor a negative pid, so it is the process TREE, killed by `taskkill`.

import { describe, expect, test } from 'bun:test';
import { killTree, taskkillArgv } from './cdp-launch-reap';

describe('killTree', () => {
  test('on Windows the tree goes by taskkill — the children first-class, forced', async () => {
    const ran: (readonly string[])[] = [];
    await killTree(4242, 'win32', async (argv) => {
      ran.push(argv);
      return 0;
    });
    expect(ran).toEqual([['taskkill', '/T', '/F', '/PID', '4242']]);
    expect(taskkillArgv(7)).toEqual(['taskkill', '/T', '/F', '/PID', '7']);
  });

  test('on Windows a taskkill that cannot run is litter, never the close’s verdict', async () => {
    await killTree(4242, 'win32', () => Promise.reject(new TypeError('ENOENT: taskkill')));
  });

  test('on POSIX nothing is spawned: the group is signalled, and a group already empty is done', async () => {
    let spawned = false;
    const run = async (): Promise<number> => {
      spawned = true;
      return 0;
    };
    // A pid with no group behind it: `process.kill(-pid)` throws ESRCH at once.
    const started = performance.now();
    await killTree(2 ** 22 + 17, 'linux', run);
    expect(spawned).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
