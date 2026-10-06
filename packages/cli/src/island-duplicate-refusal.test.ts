// Which duplicates break the build and which only warn: a framework bug refuses, a third-party
// package the app's lockfile installed twice is a log line. Judged over stub filesystems, so the
// Windows shape is asked on any host.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import {
  IslandModuleDuplicatedError,
  isFrameworkDuplicate,
  refuseDuplicatedModules,
} from './island-duplicate-refusal';
import type { IslandMetafile, ModuleIdentityIo } from './island-duplicates';

const ISLAND = 'apps/web/app/post/post-form.island.tsx';
const WIN_CORE = 'D:\\a\\_temp\\winapp\\node_modules\\@ultimat3\\core\\src\\index.ts';

const meta = (inputs: Readonly<Record<string, number>>): IslandMetafile => ({
  outputs: {
    './apps/web/app/post/post-form.island.js': {
      inputs: Object.fromEntries(
        Object.entries(inputs).map(([path, bytes]) => [path, { bytesInOutput: bytes }]),
      ),
    },
  },
});

const stubIo = (
  platform: NodeJS.Platform,
  files: Readonly<Record<string, string>> = {},
): ModuleIdentityIo => ({
  cwd: platform === 'win32' ? 'D:\\a\\_temp\\winapp' : '/app',
  platform,
  realpath: (path) => path,
  readText: async (path) => files[path],
});

/** `name@1.0.0` installed at the app root and again nested under `b`, byte for byte. */
const twoCopies = (name: string): { inputs: IslandMetafile; io: ModuleIdentityIo } => {
  const top = `/app/node_modules/${name}`;
  const nested = `/app/node_modules/b/node_modules/${name}`;
  const manifest = JSON.stringify({ name, version: '1.0.0' });
  return {
    inputs: meta({ [`${top}/i.js`]: 5, [`${nested}/i.js`]: 5 }),
    io: stubIo('linux', {
      [`${top}/package.json`]: manifest,
      [`${top}/i.js`]: 'x',
      [`${nested}/package.json`]: manifest,
      [`${nested}/i.js`]: 'x',
    }),
  };
};

async function outcome(
  inputs: IslandMetafile,
  io: ModuleIdentityIo,
): Promise<{ readonly thrown: unknown; readonly warned: readonly string[] }> {
  const warned: string[] = [];
  const thrown = await refuseDuplicatedModules(ISLAND, inputs, io, (line) => {
    warned.push(line);
  }).catch((error: unknown) => error);
  return { thrown, warned };
}

describe('unit · a framework duplicate refuses the build', () => {
  test('one file under two spellings: the island, both spellings, the bytes, a runnable fix', async () => {
    const { thrown, warned } = await outcome(
      meta({ [WIN_CORE]: 9_000, [`d${WIN_CORE.slice(1)}`]: 8_500 }),
      stubIo('win32'),
    );
    expect(thrown).toBeInstanceOf(IslandModuleDuplicatedError);
    if (!(thrown instanceof UltimateError)) return expect.unreachable('the build is refused');
    expect(thrown.code).toBe('X_ISLAND_MODULE_DUPLICATED');
    expect(thrown.cause).toContain(ISLAND);
    expect(thrown.cause).toContain(WIN_CORE);
    expect(thrown.cause).toContain(`d${WIN_CORE.slice(1)}`);
    expect(thrown.cause).toContain('8500 B');
    expect(thrown.fix).toStartWith('gh issue create --repo developerz-ai/ultimate --title ');
    expect(warned).toEqual([]);
  });

  test('a second copy of an @ultimat3 package is the framework’s dedupe failing', async () => {
    const { inputs, io } = twoCopies('@ultimat3/core');
    const { thrown } = await outcome(inputs, io);
    if (!(thrown instanceof UltimateError)) return expect.unreachable('the build is refused');
    expect(thrown.cause).toContain('@ultimat3/core@1.0.0');
  });

  test('a scope that merely starts the same is a third party', () => {
    const one = { output: 'o', spellings: [], wastedBytes: 1, sameFile: false };
    expect(isFrameworkDuplicate({ ...one, packageName: '@ultimat3x/core' })).toBe(false);
    expect(isFrameworkDuplicate({ ...one, packageName: '@ultimat3/core' })).toBe(true);
  });
});

describe('unit · a third-party package installed twice warns and builds', () => {
  test('one line naming the island, the package, the bytes, opening its fix with bun why', async () => {
    const { inputs, io } = twoCopies('lib');
    const { thrown, warned } = await outcome(inputs, io);
    expect(thrown).toBeUndefined();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(ISLAND);
    expect(warned[0]).toContain('lib@1.0.0');
    expect(warned[0]).toContain('5 B shipped twice');
    expect(warned[0]).toContain('fix: bun why lib,');
  });

  test('a chunk with every module once neither refuses nor warns', async () => {
    const { thrown, warned } = await outcome(meta({ '/a.ts': 1, '/b.ts': 1 }), stubIo('linux'));
    expect(thrown).toBeUndefined();
    expect(warned).toEqual([]);
  });
});
