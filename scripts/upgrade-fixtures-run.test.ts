// One fixture end to end, with no npm and no real CLI: the scaffold comes from the cache the run
// itself fills, and `root` is a tree whose `packages/cli/src/bin.ts` is a stand-in that answers
// `new` and `upgrade` the way the real one's `--json` does. What is real is the order: setup, the
// commit, the gate before, the hop, what the hop wrote, the gate after, the drift.

import { describe, expect, test } from 'bun:test';
// why: Bun has no recursive remove; the fixture's work tree is the caller's to delete.
import { rm } from 'node:fs/promises';
// why: Bun ships no path API; the work tree is the app directory's parent.
import { dirname } from 'node:path';
import { dbUnavailable } from '@ultimat3/db';
import { tempTree } from '../packages/testing/src/temp-tree';
import { FIXTURE_APP, type FixtureInput, runFixture, scaffoldHead } from './upgrade-fixtures-run';

/** `x new` and `x upgrade`, as far as the run reads them; `FAKE_CLI=fail` is a CLI that crashed. */
const FAKE_BIN = `
const [command, ...rest] = Bun.argv.slice(2);
if (Bun.env.FAKE_CLI === 'fail') {
  console.log('Segmentation fault, or something like it');
  process.exit(1);
}
if (command === 'new') {
  const dir = rest[rest.indexOf('--dir') + 1];
  await Bun.write(dir + '/${FIXTURE_APP}/package.json', '{ "name": "${FIXTURE_APP}" }\\n');
  await Bun.write(dir + '/${FIXTURE_APP}/.git/HEAD', 'ref: refs/heads/main\\n');
  console.log(JSON.stringify({ command: 'new', ok: true }));
} else if (command === 'upgrade') {
  await Bun.write('upgraded.txt', 'the hop wrote this\\n');
  console.log(JSON.stringify({
    command: 'upgrade',
    ok: true,
    data: { from: '1.0.0', to: rest[1], verify: { ok: true, summary: 'hop gate green' } },
  }));
}
`;

/** The app's gate: green, and like the real one it refreshes a tracked file it owns. */
const VERIFY = `await Bun.write('gate-owned.txt', 'refreshed\\n');
console.log(JSON.stringify({ command: 'verify', summary: 'app gate green' }));
`;

/** The environment every child gets: this one's, minus any database the run would open. */
const ENV: Record<string, string> = Object.fromEntries(
  Object.entries(Bun.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && entry[0] !== 'TEST_DATABASE_URL' && entry[0] !== 'FAKE_CLI',
  ),
);

/** A root with the stand-in CLI, and a cache already holding release 1.0.0's scaffold. */
async function world(path: string, setup = 'echo set up'): Promise<FixtureInput> {
  await Bun.write(`${path}/root/packages/cli/src/bin.ts`, FAKE_BIN);
  const app = `${path}/cache/scaffold/1.0.0/${FIXTURE_APP}`;
  await Bun.write(
    `${app}/package.json`,
    `${JSON.stringify({ name: FIXTURE_APP, scripts: { setup, verify: 'bun verify.ts' } }, null, 2)}\n`,
  );
  await Bun.write(`${app}/verify.ts`, VERIFY);
  return {
    root: `${path}/root`,
    version: '1.0.0',
    head: '1.1.0',
    packed: [],
    cacheDir: `${path}/cache`,
    env: ENV,
    before: true,
    verify: true,
    headScaffold: new Map([['package.json', '{}\n']]),
  };
}

describe('runFixture', () => {
  test('a fixture that builds is gated, hopped, read, gated again and compared', async () => {
    await using tree = tempTree('upgrade-run-');
    const result = await runFixture(await world(tree.path));
    try {
      expect(result.unbuilt).toBeUndefined();
      expect(result.dir).toEndWith(`/${FIXTURE_APP}`);
      expect(result.before).toEqual({ green: true, summary: 'app gate green' });
      expect(result.hop).toMatchObject({
        green: true,
        from: '1.0.0',
        to: '1.1.0',
        summary: 'hop gate green',
      });
      // Only what the hop itself wrote: the scaffold, setup and the gate before were committed.
      expect(result.wrote).toEqual(['upgraded.txt']);
      expect(result.after).toEqual({ green: true, summary: 'app gate green' });
      expect(result.drift).not.toBeNull();
      expect(Object.keys(result.stages)).toEqual(['scaffold', 'setup', 'before', 'hop', 'after']);
      // The `.npmrc` that points the scope at loopback is excluded from what the author committed.
      expect(await Bun.file(`${result.dir}/.git/info/exclude`).text()).toBe('.npmrc\n');
    } finally {
      await rm(dirname(result.dir), { recursive: true, force: true });
    }
  });

  test('a hop that prints no document keeps its output tail; no gate asked is no gate run', async () => {
    await using tree = tempTree('upgrade-run-');
    const input = await world(tree.path);
    const result = await runFixture({
      ...input,
      before: false,
      verify: false,
      headScaffold: undefined,
      env: { ...input.env, FAKE_CLI: 'fail' },
    });
    try {
      expect(result.hop).toBeUndefined();
      expect(result.hopOutput).toContain('Segmentation fault');
      expect(result.before).toBeNull();
      expect(result.after).toBeNull();
      expect(result.drift).toBeNull();
      expect(Object.keys(result.stages)).toEqual(['scaffold', 'setup', 'hop']);
    } finally {
      await rm(dirname(result.dir), { recursive: true, force: true });
    }
  });

  test('a setup that fails is unbuilt at setup, with its output', async () => {
    await using tree = tempTree('upgrade-run-');
    const result = await runFixture(await world(tree.path, 'echo no registry && exit 7'));
    try {
      expect(result.unbuilt?.stage).toBe('setup');
      expect(result.unbuilt?.output).toContain('no registry');
      expect(result.wrote).toEqual([]);
    } finally {
      await rm(dirname(result.dir), { recursive: true, force: true });
    }
  });

  test('a database that cannot be created is unbuilt at setup before anything runs', async () => {
    await using tree = tempTree('upgrade-run-');
    const input = await world(tree.path);
    const result = await runFixture(
      { ...input, env: { ...input.env, TEST_DATABASE_URL: 'postgres://nobody@127.0.0.1:1/x' } },
      async () => {
        // The server's refusal, as a coded error the way the driver hands one over.
        throw dbUnavailable('connection refused');
      },
    );
    try {
      expect(result.unbuilt?.stage).toBe('setup');
      expect(result.unbuilt?.output).toContain('could not create the fixture database');
      expect(result.stages).toEqual({});
    } finally {
      await rm(dirname(result.dir), { recursive: true, force: true });
    }
  });
});

describe('scaffoldHead', () => {
  test('HEAD’s own `x new` is read into memory, its `.git` left out', async () => {
    await using tree = tempTree('upgrade-run-');
    const input = await world(tree.path);
    const files = await scaffoldHead(input.root, ENV);
    expect(files?.get('package.json')).toBe(`{ "name": "${FIXTURE_APP}" }\n`);
    expect([...(files?.keys() ?? [])].some((path) => path.startsWith('.git/'))).toBe(false);
  });

  test('a CLI that fails answers undefined, never a half-read tree', async () => {
    await using tree = tempTree('upgrade-run-');
    const input = await world(tree.path);
    expect(await scaffoldHead(input.root, { ...ENV, FAKE_CLI: 'fail' })).toBeUndefined();
  });
});
