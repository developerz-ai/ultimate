// The scan imports an app's modules in batches, and what a batch registers must be what the serial
// scan registered — module for module, in the same order. Each load runs in a child: a scan
// registers into registries every other test file reads, and a module is evaluated once a process.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no API for a temporary directory, a recursive delete or a symlink.
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';

let root = '';

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
});

/** Every module says when it was evaluated: the order IS the registration order of `entity()`. */
const log = (file: string): string =>
  `((globalThis as { __order?: string[] }).__order ??= []).push(${JSON.stringify(file)});\n`;

const entityModule = (file: string, table: string, extra = ''): string =>
  `import { entity, uuid } from '@ultimat3/entity';\n${extra}${log(file)}export const ${table} = entity('${table}', { columns: { id: uuid().primaryKey() } });\n`;

const page = (file: string, title: string, extra = ''): string =>
  `import { defineRoute } from '@ultimat3/render';\n${extra}${log(file)}export const config = defineRoute({ render: 'ssr', offline: 'runtime', meta: () => ({ title: '${title}', description: 'x' }) });\nexport function Page() { return <main>${title}</main>; }\n`;

const JOBS = `import { job } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
${log('apps/web/app/c/jobs.ts')}const shape = {
  input: t.object({ id: t.string }),
  tenant: 'none',
  idempotencyKey: ({ id }: { id: string }) => id,
  retry: { attempts: 3, backoff: 'exponential' },
  async run() {},
} as const;
export const zeta = job(shape);
export const alpha = job(shape);
`;

/** The API index names the jobs, and is evaluated first: what it imports runs before the rest. */
const INDEX = `import { defineApi } from '@ultimat3/action';
import * as jobs from '../app/c/jobs';
${log('apps/web/api/index.ts')}export const api = defineApi({ jobs: [jobs] });
`;

const ACTIONS = `import { action, t } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';
import { shared_rows } from '../../shared/rows';
${log('apps/web/app/d/actions.ts')}export const orderPing = action({
  input: t.object({}),
  output: t.object({ table: t.string }),
  policy: allow(),
  async handle() { return { table: typeof shared_rows }; },
});
`;

/** Shared deps, a module imported by a module sorted after it, routes, jobs and an action. */
const FILES: Readonly<Record<string, string>> = {
  'apps/web/api/index.ts': INDEX,
  'apps/web/app/a/page.tsx': page(
    'apps/web/app/a/page.tsx',
    'A',
    "import { shared_rows } from '../../shared/rows';\nvoid shared_rows;\n",
  ),
  'apps/web/app/b/entity.ts': entityModule('apps/web/app/b/entity.ts', 'b_rows'),
  'apps/web/app/c/jobs.ts': JOBS,
  'apps/web/app/d/actions.ts': ACTIONS,
  'apps/web/app/e/page.tsx': page(
    'apps/web/app/e/page.tsx',
    'E',
    "import { domain_rows } from '../../../../packages/domain/src/rows';\nvoid domain_rows;\n",
  ),
  'apps/web/shared/rows.ts': entityModule('apps/web/shared/rows.ts', 'shared_rows'),
  'packages/domain/src/rows.ts': entityModule('packages/domain/src/rows.ts', 'domain_rows'),
  'packages/domain/src/zz.ts': entityModule('packages/domain/src/zz.ts', 'zz_rows'),
};

/** A module whose evaluation throws, sorted between two that register. */
const THROWS = `${log('apps/web/app/c/throws.ts')}throw new TypeError('fixture: evaluation fails');\n`;

/** A module that cannot link: its import resolves to nothing. */
const UNRESOLVED = `export { nope } from './does-not-exist';\n`;

async function fixtureApp(extra: Readonly<Record<string, string>> = {}): Promise<string> {
  root = mkdtempSync(join(tmpdir(), 'x-app-load-order-'));
  symlinkSync(join(import.meta.dir, '..', 'node_modules'), join(root, 'node_modules'));
  for (const [path, source] of Object.entries({ ...FILES, ...extra })) {
    await Bun.write(join(root, path), source);
  }
  return root;
}

interface Snapshot {
  readonly order: readonly string[];
  readonly entities: readonly string[];
  readonly jobs: readonly string[];
  readonly routes: readonly string[];
  readonly actions: readonly string[];
  readonly files: readonly string[];
  readonly findings: readonly string[];
  /** How many routes were registered when `packages/domain/src/zz.ts` was evaluated. */
  readonly routesSeenByLast: number;
}

/**
 * Scans `dir` in a child and answers what the registries then hold. `serial` passes an `include`,
 * which the scan asks before each import, one module at a time — the serial scan, by contract.
 */
async function snapshot(dir: string, mode: 'serial' | 'batched'): Promise<Snapshot> {
  const here = JSON.stringify(import.meta.dir);
  const options = mode === 'serial' ? '{ track: false, include: () => true }' : '{ track: false }';
  const script = `const { scanAppModules } = await import(${here} + '/app-load.ts');
const { registeredEntities } = await import('@ultimat3/entity');
const { registeredJobs } = await import('@ultimat3/jobs');
const { routeEntries } = await import('@ultimat3/render');
const { listActions } = await import('@ultimat3/action');
const scan = await scanAppModules(${JSON.stringify(dir)}, ${options});
const g = globalThis;
console.log(JSON.stringify({ snapshot: {
  order: g.__order ?? [],
  entities: registeredEntities().map((e) => e.name),
  jobs: registeredJobs().map((j) => j.name),
  routes: routeEntries().map((r) => r.file),
  actions: listActions().map((a) => a.name),
  files: scan.files,
  findings: scan.findings.map((f) => f.code + ' ' + f.at),
  routesSeenByLast: g.__routesSeenByLast ?? -1,
} }));`;
  const child = Bun.spawn(['bun', '-e', script], {
    cwd: import.meta.dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect([await child.exited, err.includes('error:') ? err : '']).toEqual([0, '']);
  const line = out.split('\n').find((one) => one.startsWith('{"snapshot"'));
  return (JSON.parse(line ?? '{}') as { snapshot: Snapshot }).snapshot;
}

describe('unit · a batched scan registers what the serial scan registers', () => {
  test('the same modules evaluate in the same order and every registry holds the same rows', async () => {
    const dir = await fixtureApp();
    const [serial, batched] = await Promise.all([
      snapshot(dir, 'serial'),
      snapshot(dir, 'batched'),
    ]);
    // Non-vacuity: a fixture that loaded nothing would compare equal to itself.
    expect(serial.order.length).toBe(Object.keys(FILES).length);
    expect(serial.entities.length).toBe(4);
    expect(serial.jobs).toEqual(['alpha', 'zeta']);
    expect(serial.routes.length).toBe(2);
    expect(serial.actions).toEqual(['orderPing']);
    // `shared/rows.ts` is evaluated for `a/page.tsx`, long before its own sorted turn.
    expect(serial.order).toContain('apps/web/shared/rows.ts');
    expect(serial.order).toContain('apps/web/app/b/entity.ts');
    expect(serial.order.indexOf('apps/web/shared/rows.ts')).toBeLessThan(
      serial.order.indexOf('apps/web/app/b/entity.ts'),
    );
    const { routesSeenByLast: _serial, ...serialRows } = serial;
    const { routesSeenByLast: _batched, ...batchedRows } = batched;
    expect(batchedRows).toEqual(serialRows);
  }, 60_000);

  test('a module that throws, and one that cannot link, are the same findings in either scan', async () => {
    const dir = await fixtureApp({
      'apps/web/app/c/throws.ts': THROWS,
      'apps/web/app/d/unresolved.ts': UNRESOLVED,
    });
    const [serial, batched] = await Promise.all([
      snapshot(dir, 'serial'),
      snapshot(dir, 'batched'),
    ]);
    expect(serial.findings.map((finding) => finding.split(' ')[1])).toEqual([
      'apps/web/app/c/throws.ts',
      'apps/web/app/d/unresolved.ts',
    ]);
    expect(serial.files).toContain('packages/domain/src/zz.ts');
    const { routesSeenByLast: _serial, ...serialRows } = serial;
    const { routesSeenByLast: _batched, ...batchedRows } = batched;
    expect(batchedRows).toEqual(serialRows);
  }, 60_000);

  // What the serial scan guaranteed and a later module may lean on: every module before it in scan
  // order is REGISTERED when it evaluates — an `apps/<app>/mcp.ts` projecting `include: 'exposed'`
  // reads the action registry at its top level. A batch that evaluated all, then registered all,
  // answered 0 here and booted every MCP endpoint into `X_MCP_INCLUDE_EARLY`.
  test('a module sees every module before it registered, as the serial scan left them', async () => {
    const last = `import { routeEntries } from '@ultimat3/render';
(globalThis as { __routesSeenByLast?: number }).__routesSeenByLast = routeEntries().length;
${entityModule('packages/domain/src/zz.ts', 'zz_rows')}`;
    const dir = await fixtureApp({ 'packages/domain/src/zz.ts': last });
    const [serial, batched] = await Promise.all([
      snapshot(dir, 'serial'),
      snapshot(dir, 'batched'),
    ]);
    expect(serial.routesSeenByLast).toBe(2);
    expect(batched.routesSeenByLast).toBe(2);
  }, 60_000);

  // A module that awaits at its top level SUSPENDS, and in one entry module its later siblings
  // evaluate meanwhile: `a:start, b, c, a:end` where the serial scan gave `a:start, a:end, b, c`.
  // Everything such a module registers after its await would land out of order.
  const SLOW = `${log('apps/web/app/b/entity.ts:start')}await new Promise((done) => setTimeout(done, 20));
${log('apps/web/app/b/entity.ts:end')}`;

  test('a module with top-level await is evaluated whole before the next one starts', async () => {
    const dir = await fixtureApp({
      'apps/web/app/b/entity.ts': `import { entity, uuid } from '@ultimat3/entity';\n${SLOW}export const b_rows = entity('b_rows', { columns: { id: uuid().primaryKey() } });\n`,
    });
    const [serial, batched] = await Promise.all([
      snapshot(dir, 'serial'),
      snapshot(dir, 'batched'),
    ]);
    const end = serial.order.indexOf('apps/web/app/b/entity.ts:end');
    expect(serial.order[end - 1]).toBe('apps/web/app/b/entity.ts:start');
    const { routesSeenByLast: _serial, ...serialRows } = serial;
    const { routesSeenByLast: _batched, ...batchedRows } = batched;
    expect(batchedRows).toEqual(serialRows);
  }, 60_000);

  // Suspending, then a sibling that throws: serially the await ends before anything after it runs,
  // and the throw costs only its own module — `a:start, a:end, b, c, d`, never `a:start, b, c, a:end`.
  test('a suspended module, then one that throws, keep the serial order and findings', async () => {
    const dir = await fixtureApp({
      'apps/web/app/b/entity.ts': `import { entity, uuid } from '@ultimat3/entity';\n${SLOW}export const b_rows = entity('b_rows', { columns: { id: uuid().primaryKey() } });\n`,
      'apps/web/app/c/throws.ts': THROWS,
    });
    const [serial, batched] = await Promise.all([
      snapshot(dir, 'serial'),
      snapshot(dir, 'batched'),
    ]);
    expect(serial.order).toContain('apps/web/app/b/entity.ts:start');
    const start = serial.order.indexOf('apps/web/app/b/entity.ts:start');
    expect(serial.order.slice(start, start + 3)).toEqual([
      'apps/web/app/b/entity.ts:start',
      'apps/web/app/b/entity.ts:end',
      'apps/web/app/c/throws.ts',
    ]);
    expect(serial.findings.map((finding) => finding.split(' ')[1])).toEqual([
      'apps/web/app/c/throws.ts',
    ]);
    const { routesSeenByLast: _serial, ...serialRows } = serial;
    const { routesSeenByLast: _batched, ...batchedRows } = batched;
    expect(batchedRows).toEqual(serialRows);
  }, 60_000);

  // The await need not be the module's own: one it imports from outside the scan's globs makes
  // it just as asynchronous, and just as able to let a sibling run first.
  test('so is a module that imports one, from anywhere in the app', async () => {
    const dir = await fixtureApp({
      'apps/web/lib/slow.ts': `${SLOW}export const slow = 1;\n`,
      'apps/web/app/b/entity.ts': `import { entity, uuid } from '@ultimat3/entity';\nimport { slow } from '../../lib/slow';\nvoid slow;\n${log('apps/web/app/b/entity.ts')}export const b_rows = entity('b_rows', { columns: { id: uuid().primaryKey() } });\n`,
    });
    const [serial, batched] = await Promise.all([
      snapshot(dir, 'serial'),
      snapshot(dir, 'batched'),
    ]);
    expect(serial.order).toContain('apps/web/app/b/entity.ts:end');
    const { routesSeenByLast: _serial, ...serialRows } = serial;
    const { routesSeenByLast: _batched, ...batchedRows } = batched;
    expect(batchedRows).toEqual(serialRows);
  }, 60_000);
});
