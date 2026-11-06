// `x test --affected` in an app root runs exactly the files `selectTests` names — never the whole
// `apps/web` workspace the diff sits in. git is a fake runner and `bun test` is recorded, so the
// verdict never depends on this shared checkout's history.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp; each scratch app must be a fresh directory per run.
import { mkdtemp, rm } from 'node:fs/promises';
// why: the scratch app lives under the OS temp directory, which only node:os names.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { testCommand } from './cmd-test';
import type { CommandContext } from './command';
import type { Runner } from './exec';
import { parseArgs } from './parse';
import { filesIn } from './test-shards';

const APP: Readonly<Record<string, string>> = {
  'app.config.ts': 'export const config = {};\n',
  'package.json': JSON.stringify({ name: 'demo', private: true, workspaces: ['apps/*'] }),
  'apps/web/package.json': JSON.stringify({ name: '@demo/web' }),
  'apps/web/app/posts/entity.ts': 'export const POSTS = 2;\n',
  'apps/web/app/posts/entity.test.ts': "import { POSTS } from './entity';\nvoid POSTS;\n",
  'apps/web/app/billing/price.ts': 'export const price = 3;\n',
  'apps/web/app/billing/price.test.ts': "import { price } from './price';\nvoid price;\n",
};

const root = await mkdtemp(join(tmpdir(), 'x-test-affected-app-'));
afterAll(() => rm(root, { recursive: true, force: true }));
for (const [path, text] of Object.entries(APP)) await Bun.write(join(root, path), text);

/** git answered from a table, every other command recorded as a shard. */
function fake(diff: string): { readonly shards: (readonly string[])[]; readonly runner: Runner } {
  const replies: Readonly<Record<string, string>> = {
    'git rev-parse --show-toplevel': `${root}\n`,
    'git rev-parse --verify --quiet main^{commit}': 'abc\n',
    'git diff --name-only -z main...HEAD': diff,
  };
  const shards: (readonly string[])[] = [];
  const runner: Runner = async (command) => {
    if (command[0] !== 'git') {
      shards.push(command);
      return { command, code: 0, ok: true, stdout: '', stderr: '', durationMs: 3 };
    }
    const stdout = replies[command.join(' ')];
    const ok = stdout !== undefined;
    return { command, code: ok ? 0 : 1, ok, stdout: stdout ?? '', stderr: '', durationMs: 1 };
  };
  return { shards, runner };
}

const context = (runner: Runner): CommandContext => ({
  args: parseArgs(['test', '--affected', '--workers', '1'], [testCommand.spec]),
  cwd: root,
  runner,
  env: {},
  bunVersion: REQUIRED_BUN,
});

const filesRun = (shards: readonly (readonly string[])[]): readonly string[] =>
  [...shards.flatMap((command) => filesIn(command))].sort();

interface Data {
  readonly affected?: { readonly tests?: unknown };
}

describe('unit · x test --affected in an app root', () => {
  test('a one-slice edit runs that slice’s tests, not the whole apps/web workspace', async () => {
    const { runner, shards } = fake('apps/web/app/posts/entity.ts\0');
    const result = await testCommand.run(context(runner));
    expect(result.ok).toBe(true);
    expect(filesRun(shards)).toEqual(['apps/web/app/posts/entity.test.ts']);
    expect((result.data as Data).affected?.tests).toMatchObject({
      all: false,
      reason: 'closure: 1 changed file(s)',
      files: [{ path: 'apps/web/app/posts/entity.test.ts', why: 'closure' }],
    });
  });

  test('a file the graph cannot speak for runs every test, and --json says why', async () => {
    const { runner, shards } = fake('app.config.ts\0');
    const result = await testCommand.run(context(runner));
    expect(filesRun(shards)).toEqual([
      'apps/web/app/billing/price.test.ts',
      'apps/web/app/posts/entity.test.ts',
    ]);
    expect((result.data as Data).affected?.tests).toMatchObject({
      all: true,
      reason: 'all: app.config.ts',
    });
  });

  test('a diff that reaches no test spawns nothing, and still names the selection', async () => {
    const { runner, shards } = fake('apps/web/app/orphan.ts\0');
    await Bun.write(join(root, 'apps/web/app/orphan.ts'), 'export const orphan = 1;\n');
    try {
      const result = await testCommand.run(context(runner));
      expect(result.ok).toBe(true);
      expect(shards).toEqual([]);
      expect((result.data as Data).affected?.tests).toMatchObject({ all: false, files: [] });
    } finally {
      await rm(join(root, 'apps/web/app/orphan.ts'));
    }
  });
});
