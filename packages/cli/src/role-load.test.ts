// A role imports what it runs. The worker and the scheduler must end with every job the manifest
// names and with no component or stylesheet in the process; the web role must end with the pages.
// Each load runs in a child process: a scan registers into registries every other test file reads.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no API for a temporary directory, a recursive delete or a symlink.
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { ROLES } from '@ultimat3/core';
import {
  ROLE_LOADS,
  RoleLoadIncompleteError,
  roleLoadFor,
  unregisteredFromManifest,
} from './role-load';

let root = '';

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
});

const JOBS = `import { job } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
export const ping = job({
  input: t.object({ id: t.string }),
  tenant: 'none',
  idempotencyKey: ({ id }) => \`ping:\${id}\`,
  retry: { attempts: 3, backoff: 'exponential' },
  async run() {},
});
`;

const INDEX = `import { defineApi } from '@ultimat3/action';
import * as jobs from '../app/ping/jobs';
export const api = defineApi({ jobs: [jobs] });
`;

/** Registers on import and is imported by nothing: only the scan reaches it. */
const SERVICE = `import { defineService } from '@ultimat3/core';
export const clock = defineService('fixtureClock', () => ({ now: () => 1 }));
`;

const PAGE = `import { defineRoute } from '@ultimat3/render';
export const config = defineRoute({ render: 'ssr', hydrate: 'visible', offline: 'runtime', budget: { js: '60kb' }, meta: () => ({ title: 'Hello', description: 'x' }) });
export default function Page() { return <main><Suspense>hello</Suspense></main>; }
`;

const manifest = (jobs: readonly string[]): string =>
  JSON.stringify({ jobs: jobs.map((name) => ({ name })), tasks: [] });

/** A fixture app that resolves `@ultimat3/*` through the CLI's own workspace links. */
async function fixtureApp(manifestText: string | undefined): Promise<string> {
  root = mkdtempSync(join(tmpdir(), 'x-role-load-'));
  symlinkSync(join(import.meta.dir, '..', 'node_modules'), join(root, 'node_modules'));
  const files: Readonly<Record<string, string>> = {
    'apps/web/api/index.ts': INDEX,
    'apps/web/app/ping/jobs.ts': JOBS,
    'apps/web/app/ping/service.ts': SERVICE,
    'apps/web/app/hello/page.tsx': PAGE,
    'apps/web/shared/ui/card.tsx': 'export const Card = () => null;\n',
    // A barrel over a component: a `.ts` module, and exactly what a worker must not import.
    'apps/web/shared/ui/index.ts': "export { Card } from './card.tsx';\n",
    ...(manifestText === undefined ? {} : { 'x.manifest.json': manifestText }),
  };
  for (const [path, source] of Object.entries(files)) await Bun.write(join(root, path), source);
  return root;
}

interface Probe {
  readonly files: readonly string[];
  readonly findings: readonly string[];
  readonly jobs: readonly string[];
  readonly services: readonly string[];
  readonly routes: readonly { readonly file: string; readonly suspense: number }[];
  /** App-relative document modules this process evaluated. */
  readonly documents: readonly string[];
  /** Every `X_*` code and `msg` the boot logged. */
  readonly logged: readonly string[];
}

/** Loads `dir` as `role` in a child and answers what the process then holds. */
async function probe(
  dir: string,
  role: string,
  env: Readonly<Record<string, string>> = {},
): Promise<Probe> {
  const here = JSON.stringify(import.meta.dir);
  const script = `const { loadAppForRole } = await import(${here} + '/role-load.ts');
const { registeredJobs } = await import('@ultimat3/jobs');
const { registeredServiceNames } = await import('@ultimat3/core');
const { routeEntries } = await import('@ultimat3/render');
const dir = ${JSON.stringify(dir)};
const scan = await loadAppForRole(dir, ${JSON.stringify(role)});
console.log(JSON.stringify({ probe: {
  files: scan.files, findings: scan.findings.map((f) => f.code),
  jobs: registeredJobs().map((j) => j.name).sort(),
  services: [...registeredServiceNames()].sort(),
  routes: routeEntries().map((r) => ({ file: r.file, suspense: r.suspenseBoundaries })),
  documents: Object.keys(require.cache).filter((p) => p.startsWith(dir + '/apps/') && /\\.(tsx|scss)$/.test(p)).map((p) => p.slice(dir.length + 1)).sort(),
} }));`;
  const child = Bun.spawn(['bun', '-e', script], {
    cwd: import.meta.dir,
    env: { ...process.env, LOG_LEVEL: 'info', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // Both streams: the logger writes `error` lines to stderr and everything else to stdout.
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(await child.exited).toBe(0);
  const lines = `${out}\n${err}`
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const answered = lines.find((line) => line['probe'] !== undefined)?.['probe'] as Omit<
    Probe,
    'logged'
  >;
  const logged = lines.flatMap((line) =>
    typeof line['msg'] === 'string' ? [String(line['code'] ?? line['msg'])] : [],
  );
  return { ...answered, logged };
}

describe('unit · what each role imports', () => {
  test('every role has a decision, and only the two that run jobs leave documents out', () => {
    expect([...ROLE_LOADS.keys()].sort()).toEqual([...ROLES].sort());
    expect(ROLES.filter((role) => roleLoadFor(role) === 'background')).toEqual([
      'worker',
      'scheduler',
    ]);
    // An untyped caller's value reads no `Object.prototype` member: it is given the whole app.
    expect(roleLoadFor('constructor' as never)).toBe('everything');
  });

  test('a worker imports the job, the side-effect module and no document', async () => {
    const dir = await fixtureApp(manifest(['ping']));
    const loaded = await probe(dir, 'worker');
    expect(loaded.jobs).toEqual(['ping']);
    // Imported by nothing, registered by the scan: a module that brings no document still loads.
    expect(loaded.services).toEqual(['fixtureClock']);
    expect(loaded.files).toEqual([
      'apps/web/api/index.ts',
      'apps/web/app/ping/jobs.ts',
      'apps/web/app/ping/service.ts',
    ]);
    expect(loaded.documents).toEqual([]);
    expect(loaded.routes).toEqual([]);
    expect(loaded.logged).toEqual([]);
  }, 30_000);

  test('the scheduler takes the same load', async () => {
    const dir = await fixtureApp(manifest(['ping']));
    const loaded = await probe(dir, 'scheduler');
    expect([loaded.jobs, loaded.documents, loaded.logged]).toEqual([['ping'], [], []]);
  }, 30_000);

  test('the web role imports every module and registers the page from its own source', async () => {
    const dir = await fixtureApp(manifest(['ping']));
    const loaded = await probe(dir, 'web');
    expect(loaded.findings).toEqual([]);
    expect(loaded.documents).toEqual([
      'apps/web/app/hello/page.tsx',
      'apps/web/shared/ui/card.tsx',
    ]);
    // An untracked scan reads a route module's text AFTER the import: the boundary count is there.
    expect(loaded.routes).toEqual([{ file: 'apps/web/app/hello/page.tsx', suspense: 1 }]);
    expect(loaded.jobs).toEqual(['ping']);
  }, 30_000);

  test('a job the manifest names and the load did not register imports everything, loudly', async () => {
    const dir = await fixtureApp(manifest(['ping', 'ghost']));
    const loaded = await probe(dir, 'worker');
    expect(loaded.logged).toEqual(['X_ROLE_LOAD_INCOMPLETE']);
    expect(loaded.documents).toEqual([
      'apps/web/app/hello/page.tsx',
      'apps/web/shared/ui/card.tsx',
    ]);
    expect(loaded.jobs).toEqual(['ping']);
  }, 30_000);

  test('no manifest to check against imports everything and names the command', async () => {
    const dir = await fixtureApp(undefined);
    const loaded = await probe(dir, 'worker');
    expect(loaded.logged).toEqual(['ultimate role load unverified']);
    expect(loaded.documents.length).toBe(2);
  }, 30_000);
});

describe('unit · the manifest check', () => {
  test('answers undefined without a readable manifest, never "nothing missing"', async () => {
    root = mkdtempSync(join(tmpdir(), 'x-role-load-'));
    expect(await unregisteredFromManifest(root)).toBeUndefined();
    await Bun.write(join(root, 'x.manifest.json'), '[1, 2]');
    expect(await unregisteredFromManifest(root)).toBeUndefined();
    await Bun.write(join(root, 'x.manifest.json'), '{ not json');
    expect(await unregisteredFromManifest(root)).toBeUndefined();
  });

  test('names every job and task this process has not registered, sorted', async () => {
    root = mkdtempSync(join(tmpdir(), 'x-role-load-'));
    await Bun.write(
      join(root, 'x.manifest.json'),
      JSON.stringify({
        jobs: [{ name: 'x-role-load-zeta' }, { name: 'x-role-load-alpha' }, { nope: 1 }, 7],
        tasks: [{ name: 'x-role-load-task' }],
      }),
    );
    expect(await unregisteredFromManifest(root)).toEqual([
      'x-role-load-alpha',
      'x-role-load-task',
      'x-role-load-zeta',
    ]);
    // A manifest with neither list names nothing: an app with no job is complete.
    await Bun.write(join(root, 'x.manifest.json'), '{}');
    expect(await unregisteredFromManifest(root)).toEqual([]);
  });

  test('the error names the role, every missing name and the file to edit', () => {
    const error = new RoleLoadIncompleteError({ role: 'worker', missing: ['a', 'b'] });
    expect(error.code).toBe('X_ROLE_LOAD_INCOMPLETE');
    expect(error.cause).toContain('the worker role');
    expect(error.cause).toContain('(a, b)');
    expect(error.fix).toContain('apps/web/api/index.ts');
    expect(error.fix).toContain('x manifest');
  });
});

describe('unit · the reference app as a worker', () => {
  // The app every primitive is written in once, idiomatically: its worker must need no document.
  test('examples/dummy registers every job of its manifest without one component or stylesheet', async () => {
    const dir = join(import.meta.dir, '..', '..', '..', 'examples', 'dummy');
    const loaded = await probe(dir, 'worker', {
      NODE_ENV: 'production',
      APP_URL: 'http://localhost:3000',
      DATABASE_URL: 'postgres://role-load:role-load@localhost:1/never-dialled',
      SESSION_SECRET: 'role-load-test-session-secret-0123456789',
    });
    expect(loaded.findings).toEqual([]);
    expect(
      loaded.logged.filter((line) => line.startsWith('X_') || line.includes('role load')),
    ).toEqual([]);
    expect(loaded.documents).toEqual([]);
    expect(loaded.jobs.length).toBeGreaterThan(3);
  }, 30_000);
});
