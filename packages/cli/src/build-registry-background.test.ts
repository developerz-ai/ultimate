// The prebuilt registry's background half: `worker` and `scheduler` boot from a list decided at
// build time, and it is the list their scan would import — the API index, the jobs, the modules
// that reach no document — never a page or a barrel over a component. A registry whose modules
// changed since the build is not trusted. Each boot runs in a child: registries are per process.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no API for a temporary directory, a directory listing, a recursive delete or a
// symlink.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { scannedModulePaths } from './app-load';
import { readPrebuiltRegistry, registryDir, writePrebuiltRegistry } from './build-registry';
import { backgroundModules } from './build-registry-background';

let root = '';

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
});

const FILES: Readonly<Record<string, string>> = {
  'apps/web/api/index.ts': `import { defineApi } from '@ultimat3/action';
import * as jobs from '../app/ping/jobs';
export const api = defineApi({ jobs: [jobs] });
`,
  'apps/web/app/ping/jobs.ts': `import { job } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
export const ping = job({
  input: t.object({ id: t.string }),
  tenant: 'none',
  idempotencyKey: ({ id }) => \`ping:\${id}\`,
  retry: { attempts: 3, backoff: 'exponential' },
  async run() {},
});
`,
  // Registers on import and is imported by nothing: only a load that lists it reaches it.
  'apps/web/app/ping/service.ts': `import { defineService } from '@ultimat3/core';
export const clock = defineService('backgroundClock', () => ({ now: () => 1 }));
`,
  'apps/web/app/hello/page.tsx': `import { defineRoute } from '@ultimat3/render';
export const config = defineRoute({ render: 'ssr', hydrate: 'visible', offline: 'runtime', budget: { js: '60kb' }, meta: () => ({ title: 'Hello', description: 'x' }) });
export default function Page() { return <main>hello</main>; }
`,
  'apps/web/shared/ui/card.tsx': 'export const Card = () => null;\n',
  // A barrel over a component: a `.ts` module, and exactly what a worker must not import.
  'apps/web/shared/ui/index.ts': "export { Card } from './card.tsx';\n",
  'x.manifest.json': JSON.stringify({ jobs: [{ name: 'ping' }], tasks: [] }),
};

async function fixtureApp(extra: Readonly<Record<string, string>> = {}): Promise<string> {
  root = mkdtempSync(join(tmpdir(), 'x-registry-background-'));
  // A real `node_modules` linking each of the CLI's entries, never a link to the CLI's own: the
  // registry is written under `node_modules/.cache`, which would land in this package's tree.
  const linked = join(import.meta.dir, '..', 'node_modules');
  mkdirSync(join(root, 'node_modules'));
  for (const entry of readdirSync(linked).filter((one) => !one.startsWith('.'))) {
    symlinkSync(join(linked, entry), join(root, 'node_modules', entry));
  }
  for (const [path, source] of Object.entries({ ...FILES, ...extra })) {
    await Bun.write(join(root, path), source);
  }
  return root;
}

const write = async (dir: string) => writePrebuiltRegistry(dir, await scannedModulePaths(dir));

interface Boot {
  readonly prebuilt: boolean;
  readonly files: readonly string[];
  readonly jobs: readonly string[];
  readonly services: readonly string[];
  readonly documents: readonly string[];
  readonly logged: readonly string[];
}

/** Boots `dir` as `role` through `loadAppForRole`, in a child, and answers what it then holds. */
async function boot(dir: string, role: string): Promise<Boot> {
  const here = JSON.stringify(import.meta.dir);
  const script = `const { loadAppForRole } = await import(${here} + '/role-load.ts');
const { registeredJobs } = await import('@ultimat3/jobs');
const { registeredServiceNames } = await import('@ultimat3/core');
const dir = ${JSON.stringify(dir)};
const scan = await loadAppForRole(dir, ${JSON.stringify(role)});
const cached = Object.keys(require.cache);
console.log(JSON.stringify({ boot: {
  prebuilt: cached.some((p) => p.startsWith(${JSON.stringify(registryDir(dir))})),
  files: scan.files,
  jobs: registeredJobs().map((j) => j.name).sort(),
  services: [...registeredServiceNames()].sort(),
  documents: cached.filter((p) => p.startsWith(dir + '/apps/') && /\\.tsx$/.test(p)).map((p) => p.slice(dir.length + 1)).sort(),
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

describe('unit · the background list', () => {
  test('is the index, what it imports and every module reaching no document, in scan order', async () => {
    const dir = await fixtureApp();
    const modules = await scannedModulePaths(dir);
    const picked = (await backgroundModules(dir, modules)).map((path) => path.slice(dir.length));
    expect(picked).toEqual([
      '/apps/web/api/index.ts',
      '/apps/web/app/ping/jobs.ts',
      '/apps/web/app/ping/service.ts',
    ]);
  });

  test('a module the index already evaluated is listed, whatever it reaches', async () => {
    const dir = await fixtureApp({
      'apps/web/api/index.ts': `${FILES['apps/web/api/index.ts']}import '../shared/ui/index';\n`,
    });
    const picked = await backgroundModules(dir, await scannedModulePaths(dir));
    expect(picked.map((path) => path.slice(dir.length))).toContain('/apps/web/shared/ui/index.ts');
    expect(picked.map((path) => path.slice(dir.length))).toContain('/apps/web/shared/ui/card.tsx');
    expect(picked.map((path) => path.slice(dir.length))).not.toContain(
      '/apps/web/app/hello/page.tsx',
    );
  });

  test('is written beside the full set, and a registry without it is not read', async () => {
    const dir = await fixtureApp();
    const registry = await write(dir);
    expect(registry.files.length).toBe(6);
    expect(registry.background.files).toEqual([
      'apps/web/api/index.ts',
      'apps/web/app/ping/jobs.ts',
      'apps/web/app/ping/service.ts',
    ]);
    expect(registry.background.chunks[0]).toMatch(/\/background\/chunk-0\.ts$/);
    expect(await readPrebuiltRegistry(dir)).toEqual(registry);
    const index = join(registryDir(dir), 'registry.json');
    const { background: _dropped, ...format2 } = registry;
    await Bun.write(index, JSON.stringify({ ...format2, format: 2 }));
    expect(await readPrebuiltRegistry(dir)).toBeUndefined();
    await Bun.write(index, JSON.stringify(format2));
    expect(await readPrebuiltRegistry(dir)).toBeUndefined();
  });
});

describe('unit · a background boot from the registry', () => {
  test('a worker imports the list: the job and the service, no document, no scan', async () => {
    const dir = await fixtureApp();
    await write(dir);
    const [prebuilt, scheduler] = await Promise.all([boot(dir, 'worker'), boot(dir, 'scheduler')]);
    expect(prebuilt.prebuilt).toBe(true);
    expect(scheduler).toEqual(prebuilt);
    expect(prebuilt.jobs).toEqual(['ping']);
    expect(prebuilt.services).toEqual(['backgroundClock']);
    expect(prebuilt.documents).toEqual([]);
    expect(prebuilt.logged).toEqual([]);
  }, 60_000);

  test('the same as the scan it replaces', async () => {
    const dir = await fixtureApp();
    const scanned = await boot(dir, 'worker');
    await write(dir);
    const prebuilt = await boot(dir, 'worker');
    expect([scanned.prebuilt, prebuilt.prebuilt]).toEqual([false, true]);
    expect({ ...prebuilt, prebuilt: false }).toEqual(scanned);
  }, 60_000);

  // An image build that rewrites timestamps (BuildKit `rewrite-timestamp`, a later stage copying
  // the app again) changes every mtime and no byte: the list is still the app's.
  test('a module whose modification time moved and whose bytes did not is still trusted', async () => {
    const dir = await fixtureApp();
    await write(dir);
    const epoch = new Date('2001-01-01T00:00:00Z');
    for (const file of Object.keys(FILES)) utimesSync(join(dir, file), epoch, epoch);
    const booted = await boot(dir, 'worker');
    expect([booted.prebuilt, booted.logged]).toEqual([true, []]);
    expect(booted.services).toEqual(['backgroundClock']);
  }, 60_000);

  test('a module rewritten since the build is not trusted: the boot scans, and says why', async () => {
    const dir = await fixtureApp();
    await write(dir);
    // Now reaches a component: a list decided before this edit would import it into a worker.
    await Bun.write(
      join(dir, 'apps/web/app/ping/service.ts'),
      `import '../../shared/ui/index';\n${FILES['apps/web/app/ping/service.ts']}// edited\n`,
    );
    const booted = await boot(dir, 'worker');
    expect(booted.prebuilt).toBe(false);
    expect(booted.logged).toContain('X_PREBUILT_REGISTRY_STALE');
    expect(booted.services).toEqual([]);
    expect(booted.documents).toEqual([]);
  }, 60_000);

  test('a job the list missed falls back to every module, from the registry', async () => {
    const dir = await fixtureApp({
      'x.manifest.json': JSON.stringify({ jobs: [{ name: 'ping' }, { name: 'ghost' }] }),
    });
    await write(dir);
    const booted = await boot(dir, 'worker');
    expect(booted.logged).toEqual(['X_ROLE_LOAD_INCOMPLETE']);
    expect(booted.prebuilt).toBe(true);
    expect(booted.documents).toEqual([
      'apps/web/app/hello/page.tsx',
      'apps/web/shared/ui/card.tsx',
    ]);
    expect(booted.jobs).toEqual(['ping']);
  }, 60_000);
});
