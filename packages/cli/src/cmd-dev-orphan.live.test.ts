// A supervised `x dev` child never outlives what it serves. Two ways it did (2026-09-29): its
// supervisor SIGKILLed — a signal no process can forward — left the child reparented to init,
// serving forever; and its app root deleted under it left it polling a database with no directory
// at 100% CPU. Two such children ran six hours on a laptop, one at 7 GB. `live` for the reason
// `cmd-dev.live.test.ts` gives: it spawns `x dev` and boots an embedded Postgres.

import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { alive, descendantsOf, leftovers, pump, reap, reapIn, waitFor } from './dev-live-fixture';

const TIMEOUT_MS = 90_000;
const BIN = join(import.meta.dir, 'bin.ts');
/** "Within a few seconds": the child asks once a second, and its drain takes about one more. */
const GONE_WITHIN_MS = 8_000;

const FILES = (name: string): Readonly<Record<string, string>> => ({
  'package.json': JSON.stringify({ name, version: '1.0.0' }),
  // Its own repository, so the watcher's ignore walk stops here (see `cmd-dev-fixture.ts`).
  '.git/HEAD': 'ref: refs/heads/main\n',
  'app.config.ts': `import { defineConfig } from '@ultimat3/core';
export const config = defineConfig({ name: '${name}' });
`,
});

const freePort = (): number => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port ?? 0;
  probe.stop(true);
  return port;
};

/** Resolves once `pid` is gone, or rejects naming how long it outlived the deadline. */
async function goneWithin(pid: number, ms: number): Promise<number> {
  const started = performance.now();
  while (alive(pid)) {
    if (performance.now() - started > ms)
      return expect.unreachable(`pid ${pid} still alive after ${ms}ms`);
    await Bun.sleep(50);
  }
  return performance.now() - started;
}

/**
 * Boots a supervised `x dev` in `root` and hands `body` the supervisor, its worker's pid and the
 * port; then, however `body` ended, reaps every process it started and asserts none is left in
 * `root` or on the port.
 */
async function withDev(
  name: string,
  body: (dev: {
    readonly supervisor: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
    readonly worker: number;
    readonly logs: { seen: () => string };
  }) => Promise<void>,
): Promise<void> {
  const root = join(import.meta.dir, '..', `.${name}`);
  await rm(root, { recursive: true, force: true });
  for (const [path, contents] of Object.entries(FILES(name)))
    await Bun.write(join(root, path), contents);
  const supervisor = Bun.spawn(['bun', BIN, 'dev', '--port', '0', '--json'], {
    cwd: root,
    env: { ...Bun.env, METRICS_PORT: String(freePort()) },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = pump(supervisor.stdout);
  const logs = pump(supervisor.stderr);
  let port: number | undefined;
  let started: readonly number[] = [];
  try {
    const ready = await waitFor(output, '"command":"dev"');
    port = Number(/"url":"http:\/\/localhost:(\d+)"/.exec(ready)?.[1]);
    started = descendantsOf(supervisor.pid);
    const worker = started[0];
    if (worker === undefined)
      return expect.unreachable(`the supervisor started no child: ${ready}`);
    await body({ supervisor, worker, logs });
  } finally {
    // Asked again: a restart may have replaced the child the body was handed.
    await reap([supervisor.pid, ...started, ...descendantsOf(supervisor.pid)]);
    await rm(root, { recursive: true, force: true });
    expect(await leftovers(root, port)).toEqual({ pids: [], port: false });
  }
}

const ROOTS = ['dev-orphan-fixture', 'dev-root-gone-fixture'].map((name) =>
  join(import.meta.dir, '..', `.${name}`),
);

afterEach(async () => {
  for (const root of ROOTS) await reapIn(root);
});

describe('a supervised x dev child stops when what it serves is gone', () => {
  test(
    'its supervisor SIGKILLed: the child notices it was orphaned and exits within seconds',
    async () => {
      await withDev('dev-orphan-fixture', async ({ supervisor, worker, logs }) => {
        supervisor.kill('SIGKILL');
        await supervisor.exited;
        await goneWithin(worker, GONE_WITHIN_MS);
        expect(logs.seen()).toContain('dev.supervisor.gone');
      });
    },
    TIMEOUT_MS,
  );

  test(
    'its app root deleted: the child exits X_DEV_ROOT_GONE and the supervisor stops, never respawns',
    async () => {
      await withDev('dev-root-gone-fixture', async ({ supervisor, worker, logs }) => {
        await rm(join(import.meta.dir, '..', '.dev-root-gone-fixture'), {
          recursive: true,
          force: true,
        });
        await goneWithin(worker, GONE_WITHIN_MS);
        expect(await supervisor.exited).toBe(1);
        expect(logs.seen()).toContain('X_DEV_ROOT_GONE');
      });
    },
    TIMEOUT_MS,
  );
});
