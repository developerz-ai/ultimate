// Dart Sass is ~290ms of module evaluation, and every process importing `@ultimat3/render/server`
// paid it whether or not it compiled a stylesheet. Proved in a child process, because a test
// process has usually loaded Sass already through some other file.

import { expect, test } from 'bun:test';

const PROBE = `
const loaded = () => Object.keys(require.cache).some((key) => key.includes('/sass/'));
const css = await import(${JSON.stringify(`${import.meta.dir}/css-modules.ts`)});
const before = loaded();
css.compileStylesheet('/tmp/probe.scss', 'a { b: c }');
console.log(JSON.stringify({ before, after: loaded() }));
`;

test('importing the stylesheet compiler loads no Sass; the first compile does', async () => {
  const child = Bun.spawn(['bun', '-e', PROBE], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(JSON.parse(out.trim().split('\n').at(-1) ?? '{}')).toEqual({ before: false, after: true });
});
