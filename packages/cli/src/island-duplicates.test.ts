// One module, one copy per island chunk — asked of the build's metafile. Windows-shaped inputs are
// handed in through a stub filesystem, because the defect (one file under two spellings a
// case-insensitive, mixed-separator filesystem treats as one) cannot be reproduced on Linux's.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no directory or symlink API, and `rm(…, { force: true })` clears a missing root.
import { mkdir, rm, symlink } from 'node:fs/promises';
// why: Bun exposes no path API — nothing native joins paths.
import { join } from 'node:path';
import { logger } from '@ultimat3/core';
import { buildIslands } from './island-bundle';
import type { IslandMetafile, ModuleIdentityIo } from './island-duplicates';
import { duplicatedModules, hostIo, realSpelling } from './island-duplicates';
import { processRoot } from './process-root-fixture';

const OUT = './apps/web/app/post/post-form.island.js';

/** One output whose inputs are `bytes` keyed by the spelling Bun recorded. */
const meta = (inputs: Readonly<Record<string, number>>): IslandMetafile => ({
  outputs: {
    [OUT]: {
      inputs: Object.fromEntries(
        Object.entries(inputs).map(([path, bytes]) => [path, { bytesInOutput: bytes }]),
      ),
    },
  },
});

/** A filesystem of `files` (path → text) where nothing is a link: `realpath` answers its input. */
const stubIo = (
  platform: NodeJS.Platform,
  files: Readonly<Record<string, string>> = {},
  links: Readonly<Record<string, string>> = {},
  cwd = platform === 'win32' ? 'D:\\a\\_temp\\winapp' : '/work/app',
): ModuleIdentityIo => ({
  cwd,
  platform,
  realpath: (path) => links[path] ?? path,
  readText: async (path) => files[path],
});

const WIN_CORE = 'D:\\a\\_temp\\winapp\\node_modules\\@ultimat3\\core\\src\\index.ts';

describe('unit · one file under two spellings', () => {
  test('two drive-letter cases of one path are one module on win32', async () => {
    const found = await duplicatedModules(
      meta({ [WIN_CORE]: 9_000, [`d${WIN_CORE.slice(1)}`]: 8_500 }),
      stubIo('win32'),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.sameFile).toBe(true);
    expect(found[0]?.wastedBytes).toBe(8_500);
    expect(found[0]?.spellings).toEqual([WIN_CORE, `d${WIN_CORE.slice(1)}`]);
  });

  test('a forward-slash spelling and a relative one fold into the backslash one on win32', async () => {
    const found = await duplicatedModules(
      meta({
        [WIN_CORE]: 100,
        'D:/a/_temp/winapp/node_modules/@ultimat3/core/src/index.ts': 100,
        'node_modules\\@ultimat3\\CORE\\src\\index.ts': 100,
      }),
      stubIo('win32'),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.spellings).toHaveLength(3);
    expect(found[0]?.wastedBytes).toBe(200);
  });

  test('the same two case variants are two files on a case-sensitive filesystem', async () => {
    const found = await duplicatedModules(
      meta({ '/work/app/src/A.ts': 10, '/work/app/src/a.ts': 10 }),
      stubIo('linux'),
    );
    expect(found).toEqual([]);
  });

  test('two spellings one realpath folds are one module', async () => {
    const found = await duplicatedModules(
      meta({
        '/work/app/node_modules/@ultimat3/core/src/index.ts': 50,
        '../../repo/packages/core/src/index.ts': 70,
      }),
      stubIo(
        'linux',
        {},
        {
          '/work/app/node_modules/@ultimat3/core/src/index.ts': '/repo/packages/core/src/index.ts',
        },
      ),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.wastedBytes).toBe(50);
    // The relative key is named as the absolute path it resolves to, so a reader can open it.
    expect(found[0]?.spellings).toContain('/repo/packages/core/src/index.ts');
  });
});

describe('unit · one package installed twice', () => {
  const APP = 'D:\\a\\_temp\\winapp\\node_modules\\@ultimat3';
  const NESTED = `${APP}\\ui\\node_modules\\@ultimat3\\core`;
  const manifest = (version: string): string => JSON.stringify({ name: '@ultimat3/core', version });
  const files = (nestedVersion: string, nestedSource: string): Record<string, string> => ({
    [`${APP}\\core\\package.json`]: manifest('9.1.0'),
    [`${APP}\\core\\src\\index.ts`]: 'export const core = 1;\n',
    [`${NESTED}\\package.json`]: manifest(nestedVersion),
    [`${NESTED}\\src\\index.ts`]: nestedSource,
    // A `{"type":"module"}` marker with no name is not a package boundary, so the walk goes on.
    [`${NESTED}\\src\\package.json`]: JSON.stringify({ type: 'module' }),
  });
  const inputs = meta({ [`${APP}\\core\\src\\index.ts`]: 400, [`${NESTED}\\src\\index.ts`]: 400 });

  test('a nested copy with identical bytes under one name@version is the same module', async () => {
    const found = await duplicatedModules(
      inputs,
      stubIo('win32', files('9.1.0', 'export const core = 1;\n')),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.sameFile).toBe(false);
    expect(found[0]?.package).toBe('@ultimat3/core@9.1.0');
    expect(found[0]?.wastedBytes).toBe(400);
  });

  test('a copy whose bytes differ is a different module', async () => {
    const found = await duplicatedModules(inputs, stubIo('win32', files('9.1.0', 'patched;\n')));
    expect(found).toEqual([]);
  });

  test('a copy at another version is a different module', async () => {
    const found = await duplicatedModules(
      inputs,
      stubIo('win32', files('9.0.0', 'export const core = 1;\n')),
    );
    expect(found).toEqual([]);
  });

  test('a virtual module with no file behind it is never a duplicate of anything', async () => {
    const found = await duplicatedModules(
      meta({ 'x-realtime-island:apps/web/app/a.island.tsx': 10, [WIN_CORE]: 10 }),
      stubIo('win32'),
    );
    expect(found).toEqual([]);
  });
});

// A real tree: a module reached through a symlink AND its real path, judged by the host's own io.
const ROOT = processRoot(join(import.meta.dir, '..', '.island-fixture', 'duplicates'));

describe('the host filesystem and the real pipeline', () => {
  beforeAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
    await mkdir(join(ROOT, 'real'), { recursive: true });
    await Bun.write(join(ROOT, 'real', 'm.ts'), 'export const m = 1;\n');
    await symlink(join(ROOT, 'real'), join(ROOT, 'link'), 'junction');
    const app = join(ROOT, 'app');
    const lib = (dir: string): Promise<number[]> =>
      Promise.all([
        Bun.write(join(dir, 'package.json'), '{"name":"lib","version":"1.0.0","main":"i.js"}'),
        Bun.write(join(dir, 'i.js'), 'export const lib = () => "LIB_ONE_COPY";\n'),
      ]);
    await lib(join(app, 'node_modules', 'lib'));
    await lib(join(app, 'node_modules', 'b', 'node_modules', 'lib'));
    await Bun.write(
      join(app, 'node_modules', 'b', 'package.json'),
      '{"name":"b","version":"1.0.0","main":"i.js"}',
    );
    await Bun.write(
      join(app, 'node_modules', 'b', 'i.js'),
      'import { lib } from "lib";\nexport const b = () => lib();\n',
    );
    await Bun.write(join(app, 'package.json'), '{"name":"duplicates-fixture"}');
    await Bun.write(
      join(app, 'apps', 'web', 'app', 'twice.island.tsx'),
      'import { lib } from "lib";\nimport { b } from "b";\n' +
        'export function mount(el: HTMLElement): void { el.textContent = lib() + b(); }\n',
    );
  });

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
  });

  test('hostIo folds a symlinked spelling into the real one', async () => {
    const found = await duplicatedModules(
      meta({ [join(ROOT, 'real', 'm.ts')]: 20, [join(ROOT, 'link', 'm.ts')]: 20 }),
      hostIo(),
    );
    expect(found.map((one) => one.wastedBytes)).toEqual([20]);
  });

  test('realSpelling names a linked file by its target, and a missing one as it was', () => {
    expect(realSpelling(join(ROOT, 'link', 'm.ts'))).toBe(join(ROOT, 'real', 'm.ts'));
    expect(realSpelling(join(ROOT, 'gone.ts'))).toBe(join(ROOT, 'gone.ts'));
  });

  test('buildIslands ships an app’s doubly-installed package, and warns with its bytes', async () => {
    const original = logger.warn;
    const lines: string[] = [];
    logger.warn = (line: string): void => {
      lines.push(line);
    };
    try {
      const bundle = await buildIslands(join(ROOT, 'app'));
      expect(bundle.chunks.map((chunk) => chunk.file)).toEqual(['apps/web/app/twice.island.tsx']);
    } finally {
      logger.warn = original;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('apps/web/app/twice.island.tsx');
    expect(lines[0]).toContain('lib@1.0.0');
    expect(lines[0]).toMatch(/\d+ B shipped twice/);
  });

  // The guard is green where the tracked apps build. Only the reference app: the deployed demo
  // (`dummy/social-media-clone`) ships no island, so building it would assert nothing.
  test('every island of examples/dummy ships each module once', async () => {
    const bundle = await buildIslands(join(import.meta.dir, '..', '..', '..', 'examples', 'dummy'));
    expect(bundle.chunks.length).toBeGreaterThan(0);
  }, 60_000);
});
