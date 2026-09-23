// The registry answers the parser and `x help` from the declarations alone: no command BODY is
// evaluated until that command runs. Before, all 28 were imported to answer one, and `x --help`
// took ~1.2s. Proved in a child process: this one has loaded command modules through other tests.

import { expect, test } from 'bun:test';

const PROBE = `
const bodies = () =>
  Object.keys(require.cache).filter((key) => /\\/cmd-[a-z0-9-]+\\.ts$/.test(key) && !/-spec\\.ts$/.test(key)
    && !/\\/cmd-(help|planned)\\.ts$/.test(key));
const registry = await import(${JSON.stringify(`${import.meta.dir}/registry.ts`)});
const before = bodies();
const spec = registry.commandFor('routes')?.spec.name;
const { listErrorCodes } = await import('@ultimat3/core');
const registered = listErrorCodes().some((entry) => entry.code === 'X_CLI_BAD_FLAG');
console.log(JSON.stringify({ before, spec, commands: registry.SPECS.length, registered }));
`;

test('importing the registry evaluates no command body, and every spec is there', async () => {
  // From this package's directory, so `@ultimat3/core` resolves to the instance the registry used.
  const child = Bun.spawn(['bun', '-e', PROBE], {
    cwd: import.meta.dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  const answer = JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as {
    before?: readonly string[];
    spec?: string;
    commands?: number;
    registered?: boolean;
  };
  expect(answer.before).toEqual([]);
  expect(answer.spec).toBe('routes');
  expect(answer.commands).toBeGreaterThan(28);
  // Laziness must not cost the CLI its own codes: no body registers them any more, so the
  // registry does (every CLI code read as X_ERROR_CODE_UNREGISTERED in the gate when it did not).
  expect(answer.registered).toBe(true);
});
