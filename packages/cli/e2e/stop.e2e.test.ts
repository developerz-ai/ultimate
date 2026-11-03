// `x stop` keeps its one promise for real: a supervised `x dev` boots, `x stop` returns, and the
// very next `x dev` in that checkout boots at once — no X_DEV_ALREADY_RUNNING for a drain still in
// flight, which is what `kill <pid>` gave. Spawns `x dev` with an embedded database, hence e2e.
//
//   bun test packages/cli/e2e/stop.e2e.test.ts

import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { paced } from '@ultimat3/testing';
import { descendantsOf, leftovers, pump, reap, reapIn, waitFor } from '../src/dev-live-fixture';
import { exec } from '../src/exec';
import { processRoot } from '../src/process-root-fixture';

const TIMEOUT_MS = paced(120_000);
const BIN = join(import.meta.dir, '..', 'src', 'bin.ts');
const ROOT = processRoot(join(import.meta.dir, '..', '.stop-e2e-fixture'));

const FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'stop-e2e-fixture', version: '1.0.0' }),
  // Its own repository, so the watcher's ignore walk stops here (see `cmd-dev-fixture.ts`).
  '.git/HEAD': 'ref: refs/heads/main\n',
  'app.config.ts': `import { defineConfig } from '@ultimat3/core';
export const config = defineConfig({ name: 'stop-e2e-fixture' });
`,
};

/** No METRICS_PORT and no external database: `--port 0` and the embedded one, as on a laptop. */
const devEnv = (): Record<string, string | undefined> => {
  const { METRICS_PORT: _metrics, DATABASE_URL: _db, ...rest } = Bun.env;
  return rest;
};

afterEach(async () => {
  await reapIn(ROOT);
  await rm(ROOT, { recursive: true, force: true });
});

const documentOf = (stdout: string): unknown =>
  JSON.parse(stdout.trim().split('\n').at(-1) ?? 'null');

describe('e2e · x stop returns only once x dev can boot again', () => {
  test(
    'x dev, x stop, then x dev --once boots at once',
    async () => {
      for (const [path, contents] of Object.entries(FILES)) {
        await Bun.write(join(ROOT, path), contents);
      }
      const supervisor = Bun.spawn([process.execPath, BIN, 'dev', '--port', '0', '--json'], {
        cwd: ROOT,
        env: devEnv(),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = pump(supervisor.stdout);
      const logs = pump(supervisor.stderr);
      let started: readonly number[] = [];
      try {
        const ready = await waitFor(output, '"command":"dev"');
        // The supervisor's log rides in the comparison, so a refused boot says why.
        expect({ booted: ready.includes('"ok":true'), logs: '' }).toEqual({
          booted: true,
          logs: ready.includes('"ok":true') ? '' : logs.seen(),
        });
        started = descendantsOf(supervisor.pid);

        const stop = await exec([process.execPath, BIN, 'stop', '--json'], {
          cwd: ROOT,
          env: devEnv(),
        });
        const stopped = documentOf(stop.stdout);
        expect({ code: stop.code, stopped }).toMatchObject({
          code: 0,
          stopped: { ok: true, command: 'stop', data: { stopped: true, drained: true } },
        });
        // The child's exit is not EX_TEMPFAIL, so the supervisor returns with it.
        await supervisor.exited;

        const again = await exec(
          [process.execPath, BIN, 'dev', '--once', '--port', '0', '--json'],
          {
            cwd: ROOT,
            env: devEnv(),
          },
        );
        expect({ code: again.code, logs: again.stderr.includes('X_DEV_ALREADY_RUNNING') }).toEqual({
          code: 0,
          logs: false,
        });
        expect(documentOf(again.stdout)).toMatchObject({ ok: true, command: 'dev' });

        const none = await exec([process.execPath, BIN, 'stop', '--json'], {
          cwd: ROOT,
          env: devEnv(),
        });
        expect(documentOf(none.stdout)).toMatchObject({ ok: true, data: { stopped: false } });
      } finally {
        await reap([supervisor.pid, ...started, ...descendantsOf(supervisor.pid)]);
        expect((await leftovers(ROOT, undefined)).pids).toEqual([]);
      }
    },
    TIMEOUT_MS,
  );
});
