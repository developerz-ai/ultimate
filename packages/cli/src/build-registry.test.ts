// The prebuilt registry: what `x build --target prebuilt` writes is what a serving role imports
// instead of scanning, and it registers exactly what the scan registers. A registry that is not
// the app on disk is never imported. Each boot runs in a child: registries are per process.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no API for a temporary directory, a directory listing, a recursive delete or a
// symlink.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { scannedModulePaths } from './app-load';
import { BATCH_SIZE } from './app-load-batch';
import {
  prebuildRegistry,
  readPrebuiltRegistry,
  registryDir,
  writePrebuiltRegistry,
} from './build-registry';

let root = '';

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
});

const log = (file: string): string =>
  `((globalThis as { __order?: string[] }).__order ??= []).push(${JSON.stringify(file)});\n`;

const FILES: Readonly<Record<string, string>> = {
  'apps/web/app/a/page.tsx': `import { defineRoute } from '@ultimat3/render';
import { rows } from '../../shared/rows';
${log('apps/web/app/a/page.tsx')}void rows;
export const config = defineRoute({ render: 'ssr', offline: 'runtime', meta: () => ({ title: 'A', description: 'x' }) });
export function Page() { return <main>A</main>; }
`,
  'apps/web/app/b/actions.ts': `import { action, t } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';
${log('apps/web/app/b/actions.ts')}export const registryPing = action({
  input: t.object({}),
  output: t.object({}),
  policy: allow(),
  async handle() { return {}; },
});
`,
  'apps/web/shared/rows.ts': `import { entity, uuid } from '@ultimat3/entity';
${log('apps/web/shared/rows.ts')}export const rows = entity('registry_rows', { columns: { id: uuid().primaryKey() } });
`,
  // Reads, at its top level, what the modules before it registered: the scan's guarantee.
  'packages/domain/src/other.ts': `import { entity, uuid } from '@ultimat3/entity';
import { listActions } from '@ultimat3/action';
import { routeEntries } from '@ultimat3/render';
${log('packages/domain/src/other.ts')}((globalThis as { __order?: string[] }).__order ??= []).push(\`saw \${String(routeEntries().length)} route(s), \${String(listActions().length)} action(s)\`);
export const other = entity('registry_other', { columns: { id: uuid().primaryKey() } });
`,
  // Never imported by the scan, so never listed: a test and an island.
  'apps/web/app/a/page.test.ts': 'throw new TypeError("a test is not an app module");\n',
  'apps/web/app/a/card.island.tsx': 'throw new TypeError("an island is a client entry");\n',
};

async function fixtureApp(extra: Readonly<Record<string, string>> = {}): Promise<string> {
  root = mkdtempSync(join(tmpdir(), 'x-build-registry-'));
  // A real `node_modules` linking each of the CLI's entries, never a link to the CLI's own: the
  // registry is written under `node_modules/.cache`, which would land in this package's tree.
  const linked = join(import.meta.dir, '..', 'node_modules');
  mkdirSync(join(root, 'node_modules'));
  // Never a dot entry: a `.cache` there is the CLI's own, and the registry is written into it.
  for (const entry of readdirSync(linked).filter((one) => !one.startsWith('.'))) {
    symlinkSync(join(linked, entry), join(root, 'node_modules', entry));
  }
  for (const [path, source] of Object.entries({ ...FILES, ...extra })) {
    await Bun.write(join(root, path), source);
  }
  return root;
}

interface Boot {
  /** `registry` when the prebuilt registry was imported, `scan` when the boot had to scan. */
  readonly source: 'registry' | 'scan';
  readonly order: readonly string[];
  readonly routes: readonly string[];
  readonly actions: readonly string[];
  readonly entities: readonly string[];
  readonly files: readonly string[];
  readonly logged: readonly string[];
}

/** Boots `dir` the way `serve-boot.ts` does for a role that imports everything. */
async function boot(dir: string, prebuilt: boolean): Promise<Boot> {
  const here = JSON.stringify(import.meta.dir);
  const script = `const { loadPrebuiltApp } = await import(${here} + '/app-load-prebuilt.ts');
const { scanAppModules } = await import(${here} + '/app-load.ts');
const { registeredEntities } = await import('@ultimat3/entity');
const { routeEntries } = await import('@ultimat3/render');
const { listActions } = await import('@ultimat3/action');
const dir = ${JSON.stringify(dir)};
const fromRegistry = ${String(prebuilt)} ? await loadPrebuiltApp(dir) : undefined;
const scan = fromRegistry ?? (await scanAppModules(dir, { track: false, include: () => true }));
console.log(JSON.stringify({ boot: {
  source: fromRegistry === undefined ? 'scan' : 'registry',
  order: globalThis.__order ?? [],
  routes: routeEntries().map((r) => r.file),
  actions: listActions().map((a) => a.name),
  entities: registeredEntities().map((e) => e.name),
  files: scan.files,
} }));`;
  const child = Bun.spawn(['bun', '-e', script], {
    cwd: import.meta.dir,
    env: { ...process.env, LOG_LEVEL: 'info' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(await child.exited).toBe(0);
  const lines = `${out}\n${err}`
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const answered = lines.find((line) => line['boot'] !== undefined)?.['boot'] as Omit<
    Boot,
    'logged'
  >;
  const logged = lines.flatMap((line) => (typeof line['code'] === 'string' ? [line['code']] : []));
  return { ...answered, logged };
}

/** A chunk's file name, without the directory of the write that made it. */
const chunkName = (chunk: string): string => chunk.split('/').at(-1) ?? '';

const write = async (dir: string) => writePrebuiltRegistry(dir, await scannedModulePaths(dir));

describe('unit · the prebuilt module registry', () => {
  test('lists every module the scan imports, in scan order, and nothing the scan skips', async () => {
    const dir = await fixtureApp();
    const registry = await write(dir);
    expect(registry.files).toEqual([
      'apps/web/app/a/page.tsx',
      'apps/web/app/b/actions.ts',
      'apps/web/shared/rows.ts',
      'packages/domain/src/other.ts',
    ]);
    expect(registry.chunks.map(chunkName)).toEqual(['chunk-0.ts']);
    expect(await readPrebuiltRegistry(dir)).toEqual(registry);
    // Relative: the image is the same tree at whatever path it is mounted.
    const [own] = (registry.chunks[0] ?? '').split('/');
    const chunk = await Bun.file(join(registryDir(dir), registry.chunks[0] ?? '')).text();
    expect(chunk.split('\n')[0]).toBe('import "./m0.ts";');
    const hook = await Bun.file(join(registryDir(dir), own ?? '', 'm0.ts')).text();
    expect(hook).toContain('from "../../../../../apps/web/app/a/page.tsx"');
    expect(`${chunk}${hook}`).not.toContain(dir);
  });

  test('a boot from it registers what a scan registers, in the same order', async () => {
    const dir = await fixtureApp();
    await write(dir);
    const [prebuilt, scanned] = await Promise.all([boot(dir, true), boot(dir, false)]);
    expect(prebuilt.source).toBe('registry');
    expect(scanned.source).toBe('scan');
    expect(scanned.routes).toEqual(['apps/web/app/a/page.tsx']);
    expect(scanned.entities.length).toBe(2);
    // Serially, the last module evaluates after the route and the action registered.
    expect(scanned.order).toContain('saw 1 route(s), 1 action(s)');
    const { source: _p, logged: _pl, ...fromRegistry } = prebuilt;
    const { source: _s, logged: _sl, ...fromScan } = scanned;
    expect(fromRegistry).toEqual(fromScan);
  }, 60_000);

  // A module that awaits at its top level is a chunk of its own: in a shared one, the modules after
  // it would evaluate while it is suspended — out of the order the scan evaluates them in.
  test('a module with top-level await keeps the scan order through the registry', async () => {
    const dir = await fixtureApp({
      'apps/web/app/b/actions.ts': `${log('apps/web/app/b/actions.ts:start')}await new Promise((done) => setTimeout(done, 20));
${log('apps/web/app/b/actions.ts:end')}export {};
`,
    });
    const registry = await write(dir);
    expect(registry.chunks.map(chunkName)).toEqual(['chunk-0.ts', 'chunk-1.ts', 'chunk-2.ts']);
    const [prebuilt, scanned] = await Promise.all([boot(dir, true), boot(dir, false)]);
    expect(prebuilt.source).toBe('registry');
    const end = scanned.order.indexOf('apps/web/app/b/actions.ts:end');
    expect(scanned.order[end - 1]).toBe('apps/web/app/b/actions.ts:start');
    const { source: _p, logged: _pl, ...fromRegistry } = prebuilt;
    const { source: _s, logged: _sl, ...fromScan } = scanned;
    expect(fromRegistry).toEqual(fromScan);
  }, 60_000);

  test('a module added after the build is served: the boot scans, and says why', async () => {
    const dir = await fixtureApp();
    await write(dir);
    await Bun.write(
      join(dir, 'apps/web/app/c/page.tsx'),
      `import { defineRoute } from '@ultimat3/render';
export const config = defineRoute({ render: 'ssr', offline: 'runtime', meta: () => ({ title: 'C', description: 'x' }) });
export function Page() { return <main>C</main>; }
`,
    );
    const booted = await boot(dir, true);
    expect(booted.source).toBe('scan');
    expect(booted.routes).toContain('apps/web/app/c/page.tsx');
    expect(booted.logged).toContain('X_PREBUILT_REGISTRY_STALE');
  }, 60_000);

  test('no registry, or one another Bun wrote, is not read', async () => {
    const dir = await fixtureApp();
    expect(await readPrebuiltRegistry(dir)).toBeUndefined();
    const registry = await write(dir);
    const index = join(registryDir(dir), 'registry.json');
    await Bun.write(index, JSON.stringify({ ...registry, bun: '0.0.1' }));
    expect(await readPrebuiltRegistry(dir)).toBeUndefined();
    await Bun.write(index, JSON.stringify({ ...registry, chunks: [] }));
    expect(await readPrebuiltRegistry(dir)).toBeUndefined();
  });

  // …and never writes where it did: Bun caches a module by its path for the life of the process,
  // so a second write at the first one's paths would boot the first write's hooks.
  test('a rewrite removes every chunk of the registry before it, and writes under new paths', async () => {
    const dir = await fixtureApp();
    const many = Array.from({ length: BATCH_SIZE + 1 }, (_unused, index) =>
      join(dir, `packages/domain/src/m${String(index)}.ts`),
    );
    const before = (await writePrebuiltRegistry(dir, many)).chunks;
    expect(before.map(chunkName)).toEqual(['chunk-0.ts', 'chunk-1.ts']);
    const after = (await write(dir)).chunks;
    expect(await Bun.file(join(registryDir(dir), before[1] ?? '')).exists()).toBe(false);
    expect(after.map(chunkName)).toEqual(['chunk-0.ts']);
    expect(before).not.toContain(after[0]);
  });

  test('the image build writes none over a load with a finding, and removes the last one', async () => {
    const dir = await fixtureApp();
    await write(dir);
    const failed = {
      files: [],
      findings: [{ code: 'X_APP_IMPORT_UNRESOLVED', cause: 'c', fix: 'f' }],
    };
    expect(await prebuildRegistry(dir, failed)).toBeUndefined();
    expect(await readPrebuiltRegistry(dir)).toBeUndefined();
    const written = await prebuildRegistry(dir, { files: [], findings: [] });
    expect(written?.files.length).toBe(4);
  });
});
