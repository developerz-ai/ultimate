// Babel installs its own `Error.prepareStackTrace` once per process, on the first transform, and
// the island transform has to leave the one it found. Proved in a child process: Babel installs
// only once, so a process that has already transformed an island cannot show the window again.

import { expect, test } from 'bun:test';

/**
 * Two transforms, the second started by the very assignment that installs Babel's rewriter — what
 * `Bun.build` does when it loads a second `.tsx` while the first is still compiling. An accessor,
 * never a poll: the window is a few microtasks wide, and loading Babel can take loop turns that a
 * microtask spin never yields to (Bun canary). The plain property is back before the stack is read.
 */
const PROBE = `
const { transformIslandTsx } = await import(${JSON.stringify(`${import.meta.dir}/solid-loader.ts`)});
const found = Error.prepareStackTrace;
let current = found;
let second;
Object.defineProperty(Error, 'prepareStackTrace', {
  configurable: true,
  get: () => current,
  set(value) {
    current = value;
    if (value !== found) second ??= transformIslandTsx('export const B = () => <p />;', '/tmp/b.island.tsx');
  },
});
await transformIslandTsx('export const A = () => <div>{1}</div>;', '/tmp/a.island.tsx');
await second;
Object.defineProperty(Error, 'prepareStackTrace', { configurable: true, writable: true, value: current });
const header = (new TypeError('selector moved').stack ?? '').split('\\n')[0];
console.log(JSON.stringify({ overlapped: second !== undefined, restored: current === found, header }));
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
