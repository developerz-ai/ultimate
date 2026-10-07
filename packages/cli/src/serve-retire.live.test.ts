// The worker retire, end to end in a real process (issue #669): `ROLE=worker` booted through
// `runRole`, a job mid-run, then SIGUSR2 — the job finishes (nothing is aborted), the worker logs
// its retire, and the process exits 0 on its own, which is what a `preStop` waiting on PID 1 sees.
// `live` because it boots an embedded Postgres in a child process.

import { afterAll, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.write and Bun.spawn take one already joined.
import { join } from 'node:path';
import { pump, reap, waitFor } from './dev-live-fixture';
import { processRoot } from './process-root-fixture';

const ROOT = processRoot(join(import.meta.dir, '..', '.serve-retire-fixture'));
const ENTRY = join(import.meta.dir, 'serve-entry.ts');

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

/** A worker entry with one slow job, enqueued as soon as the queue answers. */
const SERVER = `import { job, t } from '@ultimat3/jobs';
import { runRole } from ${JSON.stringify(ENTRY)};
const slow = job({
  name: 'retire-probe',
  input: t.object({}),
  tenant: 'none',
  idempotencyKey: () => 'retire-probe',
  retry: { attempts: 1 },
  run: async () => {
    console.log('JOB_STARTED');
    await Bun.sleep(1500);
    console.log('JOB_DONE');
  },
});
const enqueue = setInterval(() => {
  slow.enqueue({}).then(() => clearInterval(enqueue), () => undefined);
}, 100);
await runRole({ root: import.meta.dir, env: Bun.env });
`;

test('SIGUSR2 lets the running job finish, logs the retire and exits 0', async () => {
  if (process.platform === 'win32') return;
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(
    join(ROOT, 'package.json'),
    JSON.stringify({ name: 'serve-retire-fixture', version: '1.0.0' }),
  );
  await Bun.write(
    join(ROOT, 'app.config.ts'),
    "import { defineConfig } from '@ultimat3/core';\n" +
      "export const config = defineConfig({ name: 'serve-retire-fixture', realtime: { enabled: false } });\n",
  );
  await Bun.write(join(ROOT, 'server.ts'), SERVER);
  const child = Bun.spawn(['bun', join(ROOT, 'server.ts')], {
    cwd: ROOT,
    env: {
      ...Bun.env,
      ROLE: 'worker',
      NODE_ENV: 'test',
      METRICS_PORT: '0',
      ULTIMATE_STATE_DIR: join(ROOT, '.x'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = pump(child.stdout);
  const errors = pump(child.stderr);
  try {
    await waitFor(output, 'JOB_STARTED');
    child.kill('SIGUSR2');
    expect(await child.exited).toBe(0);
    const seen = output.seen() + errors.seen();
    expect(seen).toContain('jobs.worker.retiring');
    expect(seen).toContain('JOB_DONE');
    expect(seen.indexOf('JOB_DONE')).toBeLessThan(seen.indexOf('jobs.worker.retired'));
    expect(seen).not.toContain('X_DRAINING');
  } finally {
    await reap([child.pid]);
  }
}, 120_000);
