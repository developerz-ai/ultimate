// `x graph` and `x impact` in process, on a scratch app of two modules and a test: the graph's
// import edge, the path between two files (and the absence of one backwards), what an edit to the
// imported file reaches, and the three refusals. `cmd-impact.test.ts` runs the reference app in a
// child process; this file is the in-process half, so the commands' own code is what is measured.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp; the scratch app must be a fresh directory per run.
import { mkdtemp, rm } from 'node:fs/promises';
// why: the scratch app lives under the OS temp directory, which only node:os names.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { isUltimateError } from '@ultimat3/core';
import { graphCommand } from './cmd-graph';
import { impactCommand } from './cmd-impact';
import type { CliCommand, CommandContext } from './command';
import type { Runner } from './exec';
import { parseArgs } from './parse';

const root = await mkdtemp(join(tmpdir(), 'x-graph-'));
afterAll(() => rm(root, { recursive: true, force: true }));
await Bun.write(join(root, 'app.config.ts'), 'export const config = {};\n');
await Bun.write(join(root, 'package.json'), '{ "name": "scratch", "version": "0.0.0" }\n');
await Bun.write(
  join(root, 'apps/web/lib/a.ts'),
  "import { b } from './b';\nexport const a = (): number => b + 1;\n",
);
await Bun.write(join(root, 'apps/web/lib/b.ts'), 'export const b = 1;\n');
await Bun.write(
  join(root, 'apps/web/lib/b.test.ts'),
  "import { expect, test } from 'bun:test';\nimport { b } from './b';\ntest('b', () => expect(b).toBe(1));\n",
);

const noProcess: Runner = () =>
  Promise.reject(new Error('the graph is read in process; nothing may be spawned'));

const ctxOf = (command: CliCommand, argv: readonly string[], cwd = root): CommandContext => ({
  args: parseArgs([command.spec.name, ...argv], [command.spec]),
  cwd,
  runner: noProcess,
  env: {},
  bunVersion: Bun.version,
});

const refusal = (command: CliCommand, ctx: CommandContext): Promise<string> =>
  command.run(ctx).then(
    () => expect.unreachable(`x ${command.spec.name} answered instead of refusing`),
    (error: unknown) => (isUltimateError(error) ? error.code : `not coded: ${String(error)}`),
  );

const A = 'file:apps/web/lib/a.ts';
const B = 'file:apps/web/lib/b.ts';

describe('x graph', () => {
  test("the whole graph carries the app's import edge and counts its files", async () => {
    const result = await graphCommand.run(ctxOf(graphCommand, []));
    expect(result.data).toMatchObject({
      edges: [
        { from: A, to: B, rel: 'imports', provenance: 'import' },
        { from: 'test:apps/web/lib/b.test.ts', to: B, rel: 'imports', provenance: 'import' },
      ],
      opaque: [],
    });
    expect(result.summary).toContain('2 edge(s) (import)');
    expect(result.lines).toContain('  file: 3');
    expect(result.lines).toContain('  test: 1');
  });

  test('--from/--to is the chain of edges between the two', async () => {
    const result = await graphCommand.run(
      ctxOf(graphCommand, ['--from', 'apps/web/lib/a.ts', '--to', './apps/web/lib/b.ts']),
    );
    expect(result.summary).toBe(`${A} → ${B} in 1 step(s)`);
    expect(result.lines).toEqual([`  ${A} —imports (import)→ ${B}`]);
  });

  test('two nodes no edge links: said, with what was searched, and no step listed', async () => {
    const result = await graphCommand.run(
      ctxOf(graphCommand, ['--from', 'app.config.ts', '--to', 'apps/web/lib/a.ts']),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toStartWith(`no known path between file:app.config.ts and ${A}`);
    expect(result.lines).toEqual([]);
  });

  test('--from without --to is refused on the flag that is missing its pair', async () => {
    expect(await refusal(graphCommand, ctxOf(graphCommand, ['--from', 'a']))).toBe(
      'X_CLI_BAD_FLAG',
    );
    expect(await refusal(graphCommand, ctxOf(graphCommand, ['--to', 'a']))).toBe('X_CLI_BAD_FLAG');
  });

  test('an end that is no node is X_GRAPH_NODE_UNKNOWN', async () => {
    const ctx = ctxOf(graphCommand, ['--from', 'apps/web/lib/a.ts', '--to', 'nowhere.ts']);
    expect(await refusal(graphCommand, ctx)).toBe('X_GRAPH_NODE_UNKNOWN');
  });
});

describe('x impact', () => {
  test('a path is read from where the command ran, and names the test that imports it', async () => {
    const result = await impactCommand.run(
      ctxOf(impactCommand, ['lib/b.ts'], join(root, 'apps/web')),
    );
    expect(result.data).toMatchObject({
      node: B,
      tests: [{ id: 'test:apps/web/lib/b.test.ts', provenance: ['import'] }],
      routes: [],
    });
    expect(result.lines).toEqual(['  tests: apps/web/lib/b.test.ts [import]']);
    expect(result.summary).toContain('1 test(s)');
  });

  test('a file nothing imports reaches nothing and renders no section', async () => {
    const result = await impactCommand.run(ctxOf(impactCommand, ['apps/web/lib/a.ts']));
    expect(result.data).toMatchObject({ node: A, tests: [] });
    expect(result.lines).toEqual([]);
  });

  test('no positional is refused before any load; a non-node is X_GRAPH_NODE_UNKNOWN', async () => {
    expect(await refusal(impactCommand, ctxOf(impactCommand, []))).toBe('X_CLI_BAD_FLAG');
    expect(await refusal(impactCommand, ctxOf(impactCommand, ['nowhere.ts']))).toBe(
      'X_GRAPH_NODE_UNKNOWN',
    );
  });
});
