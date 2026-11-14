// Every refusal stops before it writes, carries a fix an agent can run cold, and the two states with
// no hop (`--dry-run`, at latest) say so without spawning a gate.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import {
  emptyFixture,
  fixture,
  fixtureWithoutApp,
  git,
  recording,
  removeFixtures,
  run,
} from './cmd-upgrade-fixture';

afterEach(removeFixtures);

describe('unit · x upgrade, the refusals', () => {
  test('a dirty tree spawns nothing but git and writes nothing', async () => {
    const dir = await fixture();
    await Bun.write(join(dir, 'scratch.txt'), 'wip\n');
    const before = await Bun.file(join(dir, 'package.json')).text();
    const { runner, spawned } = recording();
    const { code, output } = await run(dir, runner);
    expect(spawned).toEqual([]);
    expect(code).toBe(1);
    expect(output.findings?.[0]?.code).toBe('X_UPGRADE_DIRTY_TREE');
    expect(output.findings?.[0]?.cause).toContain('scratch.txt');
    expect(output.findings?.[0]?.fix).toContain('git status --short');
    expect(output.findings?.[0]?.fix).toContain('x upgrade --json');
    expect(await Bun.file(join(dir, 'package.json')).text()).toBe(before);
  });

  test('a directory that is no repository refuses, and the fix makes it one', async () => {
    // Never a repository, rather than one removed: `rmSync` of a `.git` git's maintenance daemon is
    // still unlinking a lock in can return with HEAD and refs left behind (`cmd-upgrade-fixture.ts`).
    const dir = await fixture({}, { repository: false });
    const { runner, spawned } = recording();
    const { output } = await run(dir, runner);
    expect(spawned).toEqual([]);
    expect(output.findings?.[0]?.code).toBe('X_UPGRADE_DIRTY_TREE');
    expect(output.findings?.[0]?.fix).toContain('git init');
  });

  test('a mixed set refuses before anything is written', async () => {
    const dir = await fixture({
      'apps/web/package.json': JSON.stringify({ dependencies: { '@ultimat3/core': '^19.0.0' } }),
    });
    const { runner, spawned } = recording();
    const { code, output } = await run(dir, runner);
    expect(code).toBe(1);
    expect(output.findings?.[0]?.code).toBe('X_UPGRADE_MIXED_PINS');
    expect(output.findings?.[0]?.fix).toBe('x upgrade --to 19.4.0 --json');
    expect(spawned).toEqual(['pm view']);
  });

  test('a registry that does not answer refuses, nothing written', async () => {
    const dir = await fixture();
    const { runner } = recording({ registryCode: 1 });
    const { output } = await run(dir, runner);
    expect(output.findings?.[0]?.code).toBe('X_UPGRADE_REGISTRY_UNREACHABLE');
    expect(output.findings?.[0]?.cause).toContain('ConnectionRefused');
    expect(await git(dir, 'status', '--porcelain')).toBe('');
  });

  test('--to that is not a plain release is a bad flag', async () => {
    const dir = await fixture();
    const { output } = await run(dir, recording().runner, ['--to', 'latest']);
    expect(output.findings?.[0]?.code).toBe('X_CLI_BAD_FLAG');
    expect(output.findings?.[0]?.fix).toContain('versions --json');
  });

  test('--to skipping a major refuses', async () => {
    const dir = await fixture();
    const { output } = await run(dir, recording().runner, ['--to', '21.0.0']);
    expect(output.findings?.[0]?.code).toBe('X_UPGRADE_HOP_TOO_WIDE');
    expect(output.findings?.[0]?.fix).toBe('x upgrade --to 20.1.0 --json');
  });

  test('a release whose floor this Bun is below refuses before writing', async () => {
    const dir = await fixture();
    const { runner, spawned } = recording({ engines: '>=9.0.0' });
    const { output } = await run(dir, runner);
    expect(output.findings?.[0]?.code).toBe('X_BUN_VERSION');
    expect(spawned).toEqual(['pm view', 'pm view']);
    expect(await git(dir, 'status', '--porcelain')).toBe('');
  });

  test('a failed install refuses with the undo, and no gate runs', async () => {
    const dir = await fixture();
    const { runner, spawned } = recording({ installCode: 1 });
    const { code, output } = await run(dir, runner);
    expect(code).toBe(1);
    expect(output.findings?.[0]?.code).toBe('X_UPGRADE_INSTALL_FAILED');
    expect(output.findings?.[0]?.cause).toContain('@ultimat3/gone');
    expect(output.findings?.[0]?.fix).toContain('git restore .');
    expect(spawned).not.toContain('x verify');
  });
});

describe('unit · x upgrade, the states with no hop', () => {
  test('--dry-run reports the pins, floor and section, writes nothing, runs no gate', async () => {
    const dir = await fixture();
    const { runner, spawned } = recording();
    const { code, output } = await run(dir, runner, ['--dry-run']);
    expect(code).toBe(0);
    expect(spawned).toEqual(['pm view', 'pm view']);
    expect(await git(dir, 'status', '--porcelain')).toBe('');
    expect(output.data).toMatchObject({
      dryRun: true,
      done: false,
      to: '20.1.0',
      guards: null,
      verify: null,
    });
    expect(output.data?.section?.title).toBe('19.x → 20.0.0, entry by entry');
    expect(output.data?.pins).toContainEqual({
      file: 'apps/web/package.json',
      name: '@ultimat3/core',
      from: '^19.4.0',
      to: '20.1.0',
    });
    expect(output.data?.bun.edited.length).toBeGreaterThan(0);
    expect(output.data?.then).toContain('x upgrade --json');
  });

  test('at latest answers done, runs no install and no gate', async () => {
    const dir = await fixture();
    const { runner, spawned } = recording({ versions: ['19.0.0', '19.4.0'] });
    const { code, output } = await run(dir, runner);
    expect(code).toBe(0);
    expect(spawned).toEqual(['pm view']);
    expect(output.data).toMatchObject({
      from: '19.4.0',
      to: '19.4.0',
      next: null,
      done: true,
      section: null,
      verify: null,
    });
  });

  test('no manifest with pins at or above the cwd refuses by its own code', async () => {
    const dir = emptyFixture();
    const { output } = await run(dir, recording().runner);
    expect(output.findings?.[0]?.code).toBe('X_UPGRADE_PIN_UNREADABLE');
    expect(output.findings?.[0]?.fix).toContain('x upgrade --json');
  });
});

describe('unit · x upgrade with no app.config.ts: pins and no app (one adopter)', () => {
  test('hops, runs what scripts it has, and says x verify did not run', async () => {
    const dir = await fixtureWithoutApp();
    const { runner, spawned } = recording();
    const { code, output } = await run(dir, runner);
    expect(spawned).toEqual(['pm view', 'pm view', 'install', 'run typecheck', 'run test']);
    expect(code).toBe(0);
    expect(output.data).toMatchObject({
      app: false,
      proof: 'scripts',
      done: true,
      verify: null,
      guards: null,
      to: '20.1.0',
    });
    expect(output.summary).toContain('no x verify ran');
    expect(output.data?.scripts.map((script) => script.name)).toEqual(['typecheck', 'test']);
    const manifest = await Bun.file(join(dir, 'package.json')).json();
    expect(manifest.dependencies['@ultimat3/core']).toBe('20.1.0');
  });

  test('a red script is a red hop', async () => {
    const dir = await fixtureWithoutApp();
    const { code, output } = await run(dir, recording({ scriptCodes: { test: 1 } }).runner);
    expect(code).toBe(1);
    expect(output.data).toMatchObject({ done: false, proof: 'scripts' });
    expect(output.data?.scripts[1]).toMatchObject({ name: 'test', ok: false, code: 1 });
  });

  test('no script at all checked nothing, and never claims done', async () => {
    const dir = await fixtureWithoutApp({ lint: 'biome' });
    const { code, output } = await run(dir, recording().runner);
    expect(code).toBe(1);
    expect(output.data).toMatchObject({ done: false, proof: 'none', scripts: [] });
    expect(output.summary).toContain('nothing checked');
  });

  test('--dry-run names what would run, runs none of it', async () => {
    const dir = await fixtureWithoutApp();
    const { runner, spawned } = recording();
    const { code, output } = await run(dir, runner, ['--dry-run']);
    expect(code).toBe(0);
    expect(spawned).toEqual(['pm view', 'pm view']);
    expect(output.data).toMatchObject({ app: false, done: false });
    expect(output.data?.scripts).toEqual([
      { name: 'typecheck', ok: null },
      { name: 'test', ok: null },
    ]);
    expect(output.data?.then).toContain('in place of x verify');
  });

  test('from a workspace member, the root is the workspace root that claims it', async () => {
    const dir = await fixtureWithoutApp();
    const { output } = await run(join(dir, 'apps/web'), recording().runner);
    expect(output.data?.pins.map((pin) => pin.file)).toContain('package.json');
    expect(output.data?.pins.map((pin) => pin.file)).toContain('apps/web/package.json');
  });

  test('an app below the pins is one cd away, by the existing refusal', async () => {
    const dir = await fixtureWithoutApp();
    await Bun.write(join(dir, 'apps/game/app.config.ts'), '');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-qm', 'an app below');
    const { output } = await run(dir, recording().runner);
    expect(output.findings?.[0]?.code).toBe('X_NOT_IN_APP');
    expect(output.findings?.[0]?.fix).toBe('cd apps/game && bunx @ultimat3/cli upgrade --json');
  });
});

describe('unit · --to at a version that is not the newest', () => {
  test('says so, and names what is next', async () => {
    const dir = await fixture();
    const { code, output } = await run(dir, recording().runner, ['--to', '19.4.0']);
    expect(code).toBe(0);
    expect(output.summary).not.toContain('newest');
    expect(output.data?.then).not.toContain('no newer');
    expect(output.data?.then).toContain('20.1.0');
    expect(output.data?.next).toBe('20.1.0');
  });
});
