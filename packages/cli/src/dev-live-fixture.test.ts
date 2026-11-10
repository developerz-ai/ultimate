// The live tests' process discipline, held without a live service: the tree walk (one bounded `ps`
// listing, walked in memory), the stream pump, and the reaper that finds an orphan by its cwd and
// proves it gone — against real child processes, so the `x dev` live suites' cleanup is itself tested.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive, no realpath and no recursive delete.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import {
  alive,
  descendantsIn,
  descendantsOf,
  leftovers,
  listening,
  parsePidPairs,
  pidListingCommand,
  processesIn,
  pump,
  reap,
  reapIn,
  waitFor,
} from './dev-live-fixture';

// realpath: `/proc/<pid>/cwd` reads the resolved path, and a macOS tmpdir is a symlink.
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'x-dev-live-fixture-')));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));
const hasProc = process.platform === 'linux';

describe('descendantsIn', () => {
  test('every descendant, depth first, from one pid → ppid listing', () => {
    const listing = [
      [10, 1],
      [11, 10],
      [12, 11],
      [13, 10],
      [20, 1],
    ] as const;
    expect(descendantsIn(listing, 10)).toEqual([11, 12, 13]);
    expect(descendantsIn(listing, 20)).toEqual([]);
  });

  test('a cycle in a racing listing cannot walk forever', () => {
    expect(
      descendantsIn(
        [
          [2, 3],
          [3, 2],
        ],
        2,
      ),
    ).toEqual([3]);
  });
});

describe('descendantsOf', () => {
  test('finds a real child and grandchild of a running process', async () => {
    const root = Bun.spawn(['sh', '-c', '(sleep 30 & wait) & wait'], { stdout: 'ignore' });
    try {
      let found: readonly number[] = [];
      for (let attempt = 0; attempt < 40 && found.length < 2; attempt += 1) {
        await Bun.sleep(25);
        found = descendantsOf(root.pid);
      }
      expect(found.length).toBeGreaterThanOrEqual(2);
    } finally {
      // Asked BEFORE the root dies: afterwards its children are init's and no walk reaches them.
      for (const pid of [...descendantsOf(root.pid), root.pid]) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone — the outcome wanted.
        }
      }
    }
  });
});

describe('the listing on Windows', () => {
  test('Windows asks CIM for the parent — it has no ps — and POSIX asks ps', () => {
    expect(pidListingCommand('win32')[0]).toBe('powershell');
    expect(pidListingCommand('win32').at(-1)).toContain('ParentProcessId');
    expect(pidListingCommand('linux')).toEqual(['ps', '-A', '-o', 'pid=,ppid=']);
  });

  test('CRLF lines and ps padding parse alike; anything else is skipped', () => {
    expect(parsePidPairs('4242 1000\r\n4243 4242\r\n\r\n')).toEqual([
      [4242, 1000],
      [4243, 4242],
    ]);
    expect(parsePidPairs('  10     1\nPID PPID\n')).toEqual([[10, 1]]);
  });
});

describe('pump and waitFor', () => {
  test('a stream is read once, and waitFor answers everything seen when the marker lands', async () => {
    const child = Bun.spawn(
      ['sh', '-c', 'printf "booting\\n"; sleep 0.05; printf "ready on 4100\\n"'],
      {
        stdout: 'pipe',
      },
    );
    const out = pump(child.stdout);
    const seen = await waitFor(out, 'ready on');
    expect(seen).toContain('booting\n');
    expect(seen).toContain('ready on 4100');
    await child.exited;
  });
});

describe('alive, processesIn and the reaper', () => {
  test('a process found by its cwd is reaped, and leftovers then reads clean', async () => {
    const dir = mkdtempSync(join(sandbox, 'orphan-'));
    const child = Bun.spawn(['sleep', '30'], { cwd: dir, stdout: 'ignore' });
    try {
      expect(alive(child.pid)).toBe(true);
      if (hasProc) expect(processesIn(dir)).toEqual([child.pid]);
      await (hasProc ? reapIn(dir) : reap([child.pid]));
      await child.exited;
      expect(alive(child.pid)).toBe(false);
      expect(await leftovers(dir, undefined)).toEqual({ pids: [], port: false });
    } finally {
      child.kill('SIGKILL');
    }
  });

  test('reap of a pid already gone returns at once, never waiting out its bound', async () => {
    const child = Bun.spawn(['true']);
    await child.exited;
    const started = performance.now();
    await reap([child.pid], 5_000);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test('processesIn a directory nothing runs in is empty', () => {
    expect(processesIn(join(sandbox, 'nobody-here'))).toEqual([]);
  });
});

describe('listening', () => {
  test('a bound port answers; the same port, released, does not', async () => {
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data: () => undefined },
    });
    const { port } = server;
    expect(await listening(port)).toBe(true);
    expect((await leftovers(sandbox, port)).port).toBe(true);
    server.stop(true);
    expect(await listening(port)).toBe(false);
  });
});
