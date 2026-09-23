// Babel and the Solid preset are ~330ms of module evaluation, paid by every process that imported
// the island bundler — `x dev`'s graph and, before the registry went lazy, `x --help`. Proved in a
// child process, because this one has usually loaded Babel already through another file.

import { expect, test } from 'bun:test';

const PROBE = `
const loaded = () => Object.keys(require.cache).some((key) => key.includes('@babel/core'));
const loader = await import(${JSON.stringify(`${import.meta.dir}/solid-loader.ts`)});
const before = loaded();
await loader.transformIslandTsx('export const a = <b />;', '/tmp/probe.island.tsx');
console.log(JSON.stringify({ before, after: loaded() }));
`;

test('importing the island JSX transform loads no Babel; the first transform does', async () => {
  const child = Bun.spawn(['bun', '-e', PROBE], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(JSON.parse(out.trim().split('\n').at(-1) ?? '{}')).toEqual({ before: false, after: true });
});
