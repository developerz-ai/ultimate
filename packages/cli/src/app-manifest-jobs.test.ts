// `x manifest` and `x verify`'s `manifest` step must record ONE job list for one app. Each runs in
// a process of its own here, because the defect this guards was a module-graph one: a framework
// job registered by an import's side effect was in the list only where the CLI's graph reached it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete; `rm` tears the fixture tree down between runs.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path-join primitive; Bun.file and Bun.spawn take one already joined.
import { join } from 'node:path';

// Under `packages/cli/` so the fixture's `@ultimat3/*` imports resolve the way the framework's own
// sources do; a dot-prefixed name keeps it out of every workspace glob.
const ROOT = join(import.meta.dir, '..', '.app-manifest-jobs-fixture');

const FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'jobs-fixture-app', version: '1.0.0' }),

  'apps/web/app/digest/jobs.ts': `import { job, t } from '@ultimat3/jobs';
export const digest = job({
  name: 'digest',
  input: t.object({ day: t.string }),
  idempotencyKey: (input) => input.day,
  tenant: 'none',
  retry: { attempts: 1, backoff: 'fixed' },
  run: () => undefined,
});
`,

  // A batch action past a declared threshold: `defineAdmin` declares `admin.batch` for it.
  'apps/admin/app/admin/admin.ts': `import { allowed, defineAdmin } from '@ultimat3/admin';
import { database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
const items = entity('jobs_fixture_items', {
  columns: { id: uuid().primaryKey(), title: text({ max: 80 }) },
});
const db = database({ items }, { driver: memoryDriver() });
export const admin = defineAdmin({
  basePath: '/admin',
  entities: [items],
  db,
  actions: [
    {
      name: 'item.archive',
      permission: 'jobs_fixture_items:write',
      entity: 'jobs_fixture_items',
      batch: { threshold: 2, chunk: 2 },
      handle: async () => {},
    },
  ],
  auth: { authz: { decide: ({ permission }) => allowed(permission, 'fixture') } },
});
`,
};

/** A child that imports `preload` first — the module graph of one CLI path — then describes. */
const jobsAfter = async (preload: string): Promise<readonly string[]> => {
  const script = `await import(${JSON.stringify(join(import.meta.dir, preload))});
const { appManifest } = await import(${JSON.stringify(join(import.meta.dir, 'app-manifest.ts'))});
const { manifest, findings } = await appManifest(${JSON.stringify(ROOT)});
if (findings.length > 0) throw findings[0];
process.stdout.write('jobs:' + JSON.stringify(manifest.jobs.map((one) => one.name)) + '\\n');
`;
  const child = Bun.spawn(['bun', '-e', script], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout.split('\n').find((one) => one.startsWith('jobs:'));
  if (code !== 0 || line === undefined) expect.unreachable(`child failed (${code}): ${stderr}`);
  return JSON.parse(line.slice('jobs:'.length)) as readonly string[];
};

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  for (const [path, body] of Object.entries(FILES)) await Bun.write(join(ROOT, path), body);
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('integration · one app, one job list, whichever command computes it', () => {
  test('`x manifest` and the `manifest` verify step record the same jobs', async () => {
    const [command, step] = await Promise.all([
      jobsAfter('cmd-manifest.ts'),
      jobsAfter('verify-checks.ts'),
    ]);
    expect(command).toEqual(step);
    // The app's own job, the one `defineAdmin` declared, and the one every role's runtime does.
    expect(command).toEqual(['admin.batch', 'digest', 'mail.send']);
  }, 60_000);
});
