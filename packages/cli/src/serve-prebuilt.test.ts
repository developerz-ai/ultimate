// A container boots from what its image build wrote. One fixture app, booted as the web role in a
// child process twice: from a bare tree, where the boot must build and SAY so, and after
// `prebuildImage`, where it must build nothing. A child, because a scan fills process registries.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no API for a temporary directory, a recursive delete, a mkdir or a symlink.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { setSassCacheDir } from '@ultimat3/render/server';
import {
  adoptPrebuiltStyles,
  ImageNotPrebuiltError,
  reportBootBuilds,
  watchBootBuilds,
} from './serve-prebuilt';
import { PREBUILT_COMMAND, PREBUILT_DIR, PREBUILT_SASS_DIR } from './serve-prebuilt-paths';

let root = '';

afterEach(() => {
  setSassCacheDir(undefined);
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
});

const ISLAND = `export function mount(el: HTMLElement): void { el.textContent = 'plain'; }\n`;

/**
 * A REAL `node_modules` holding one link: the store is written under it, and a linked
 * `node_modules` would put this fixture's store inside the repository's own.
 */
async function fixtureApp(): Promise<string> {
  root = mkdtempSync(join(tmpdir(), 'x-prebuilt-'));
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(
    join(import.meta.dir, '..', 'node_modules', '@ultimat3'),
    join(root, 'node_modules', '@ultimat3'),
  );
  const files: Readonly<Record<string, string>> = {
    'package.json': JSON.stringify({ name: 'prebuilt-fixture' }),
    'apps/web/site/plain.island.tsx': ISLAND,
    'apps/web/site/home.scss': '.home { color: red; }\n',
    'apps/web/site/home.ts': "import './home.scss';\nexport const home = 1;\n",
  };
  for (const [path, source] of Object.entries(files)) await Bun.write(join(root, path), source);
  return root;
}

interface Boot {
  readonly built: { readonly chunks: number; readonly reason: string } | null;
  readonly compiled: number;
  readonly adopted: boolean;
  /** Every `X_*` code the boot logged, with the line it rode in. */
  readonly logged: readonly Record<string, unknown>[];
}

const here = JSON.stringify(import.meta.dir);

const PREBUILD = `const { prebuildImage } = await import(${here} + '/image-prepare.ts');
const built = await prebuildImage(process.cwd());
console.log(JSON.stringify({ probe: built }));`;

/** The four calls `serve-boot.ts` makes, in its order. */
const BOOT = `const { adoptPrebuiltStyles, reportBootBuilds, watchBootBuilds } = await import(${here} + '/serve-prebuilt.ts');
const { loadAppForRole } = await import(${here} + '/role-load.ts');
const { loadOrBuildIslands } = await import(${here} + '/island-store.ts');
const { sassCompilations } = await import('@ultimat3/render/server');
const dir = process.cwd();
const adopted = adoptPrebuiltStyles(dir);
const builds = watchBootBuilds();
await loadAppForRole(dir, 'web');
const islands = await loadOrBuildIslands(dir);
reportBootBuilds('web', builds(islands.built));
console.log(JSON.stringify({ probe: { built: islands.built ?? null, compiled: sassCompilations(), adopted } }));`;

async function run(dir: string, script: string): Promise<readonly Record<string, unknown>[]> {
  const child = Bun.spawn(['bun', '-e', script], {
    cwd: dir,
    env: { ...process.env, LOG_LEVEL: 'info' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect([await child.exited, err.includes('error:') ? err : '']).toEqual([0, '']);
  return `${out}\n${err}`
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function boot(dir: string): Promise<Boot> {
  const lines = await run(dir, BOOT);
  const probe = lines.find((line) => line['probe'] !== undefined)?.['probe'] as Omit<
    Boot,
    'logged'
  >;
  return { ...probe, logged: lines.filter((line) => typeof line['code'] === 'string') };
}

describe('unit · a container boots from the image build’s store', () => {
  test('a bare tree builds at boot and logs X_IMAGE_NOT_PREBUILT with what it built', async () => {
    const dir = await fixtureApp();
    const booted = await boot(dir);
    expect(booted.adopted).toBe(false);
    expect(booted.built).toEqual({
      chunks: 1,
      reason: `no ${PREBUILT_DIR}/islands/index.json`,
    });
    expect(booted.compiled).toBe(1);
    expect(
      booted.logged.map((line) => [line['code'], line['islands'], line['stylesheets']]),
    ).toEqual([['X_IMAGE_NOT_PREBUILT', 1, 1]]);
  }, 60_000);

  test('after prebuildImage the same boot builds no island, compiles no stylesheet and logs nothing', async () => {
    const dir = await fixtureApp();
    const [prebuilt] = await run(dir, PREBUILD);
    expect(prebuilt?.['probe']).toEqual({
      dir: PREBUILT_DIR,
      islands: 1,
      stylesheets: 1,
      findings: [],
    });
    const booted = await boot(dir);
    expect(booted).toEqual({ built: null, compiled: 0, adopted: true, logged: [] });
  }, 60_000);

  test('a stylesheet edited after the prebuild is compiled at boot, and the boot says so', async () => {
    const dir = await fixtureApp();
    await run(dir, PREBUILD);
    await Bun.write(join(dir, 'apps/web/site/home.scss'), '.home { color: blue; }\n');
    const booted = await boot(dir);
    expect([booted.built, booted.compiled]).toEqual([null, 1]);
    expect(
      booted.logged.map((line) => [line['code'], line['islands'], line['stylesheets']]),
    ).toEqual([['X_IMAGE_NOT_PREBUILT', 0, 1]]);
  }, 60_000);

  test('no store leaves the Sass cache where it was', () => {
    root = mkdtempSync(join(tmpdir(), 'x-prebuilt-'));
    expect(adoptPrebuiltStyles(root)).toBe(false);
    mkdirSync(join(root, PREBUILT_SASS_DIR), { recursive: true });
    expect(adoptPrebuiltStyles(root)).toBe(true);
  });

  test('a boot that built nothing reports nothing; one that built anything reports once', () => {
    expect(reportBootBuilds('web', { stylesheets: 0, elapsedMs: 12 })).toBe(false);
    expect(reportBootBuilds('sync', { stylesheets: 3, elapsedMs: 12 })).toBe(true);
  });

  test('the watch counts from where it started, and an island store that built no chunk is no build', () => {
    const builds = watchBootBuilds();
    expect(builds()).toMatchObject({ stylesheets: 0 });
    expect(builds({ chunks: 0, reason: 'no store' }).islands).toBeUndefined();
    expect(builds({ chunks: 2, reason: 'no store' }).islands).toEqual({
      chunks: 2,
      reason: 'no store',
    });
  });

  test('the finding names what was built, why, and the Dockerfile line that ends it', () => {
    const error = new ImageNotPrebuiltError({
      role: 'web',
      islands: { chunks: 3, reason: 'no store' },
      stylesheets: 14,
      elapsedMs: 3100,
    });
    expect(error.code).toBe('X_IMAGE_NOT_PREBUILT');
    expect(error.cause).toBe(
      'the web role built 3 island chunk(s) because no store and compiled 14 stylesheet(s) the image holds no result for, 3100 ms into its boot — work this image repeats on every start of every replica',
    );
    expect(error.fix).toBe(
      `edit docker/Dockerfile: add RUN ${PREBUILT_COMMAND} after COPY . . in the runtime stage, then rebuild the image`,
    );
    // Stylesheets alone — a `sync` pod, which serves no island — reads as one clause.
    expect(
      new ImageNotPrebuiltError({ role: 'sync', stylesheets: 2, elapsedMs: 5 }).cause,
    ).toStartWith('the sync role compiled 2 stylesheet(s) the image holds no result for, 5 ms');
  });
});
