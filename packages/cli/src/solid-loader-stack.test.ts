// Babel installs its own `Error.prepareStackTrace` once per process, on the first transform, and
// the island transform has to leave the one it found. Proved in a child process: Babel installs
// only once, so a process that has already transformed an island cannot show the window again.

import { expect, test } from 'bun:test';

/**
 * Two transforms, the second started on the very microtask Babel's rewriter appears — what
 * `Bun.build` does when it loads a second `.tsx` while the first is still compiling. Waits on the
 * signal, never on a timer: the window is a few microtasks wide and no sleep would land in it.
 */
const PROBE = `
const { transformIslandTsx } = await import(${JSON.stringify(`${import.meta.dir}/solid-loader.ts`)});
const found = Error.prepareStackTrace;
const first = transformIslandTsx('export const A = () => <div>{1}</div>;', '/tmp/a.island.tsx');
let turns = 0;
while (Error.prepareStackTrace === found && turns < 1e6) { turns += 1; await Promise.resolve(); }
const overlapped = Error.prepareStackTrace !== found;
const second = transformIslandTsx('export const B = () => <p />;', '/tmp/b.island.tsx');
await first;
await second;
const header = (new TypeError('selector moved').stack ?? '').split('\\n')[0];
console.log(JSON.stringify({ overlapped, restored: Error.prepareStackTrace === found, header }));
`;

test('overlapping first transforms leave Error.prepareStackTrace as they found it', async () => {
  const child = Bun.spawn(['bun', '-e', PROBE], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exit: await child.exited, err: err.trim() }).toEqual({ exit: 0, err: '' });
  // `overlapped` is the precondition: false would mean the probe never opened the window, and a
  // green verdict over it would be about nothing.
  expect(JSON.parse(out.trim().split('\n').at(-1) ?? '{}')).toEqual({
    overlapped: true,
    restored: true,
    // What the leak cost an unrelated file in the same test process: a stack whose first line
    // read `Error: selector moved`, so `jobs`' operator trace lost the error's own class name.
    header: 'TypeError: selector moved',
  });
});
