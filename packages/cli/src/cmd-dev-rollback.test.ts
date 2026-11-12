// Row m: a throw after `startServices` left embedded Postgres, telemetry and the statement observer
// installed in a process whose caller had already given up — the retry met a `.x/pgdata` the
// failed boot still held. The failure here is an app `runtime.ts` that will not import.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { resetLifecycle, subscribed } from '@ultimat3/core';
import { startDev } from './cmd-dev';
import { resetRegistries } from './cmd-dev-fixture';

const BOOT_TIMEOUT_MS = 60_000;
let root = '';

afterAll(async () => {
  resetRegistries();
  resetLifecycle();
  if (root !== '') await rm(root, { recursive: true, force: true });
});

describe('unit · a failed x dev boot gives back what it acquired', () => {
  test(
    'the statement subscriber is removed and the data directory is free for the retry',
    async () => {
      root = await mkdtemp(join(tmpdir(), 'x-dev-rollback-'));
      await Bun.write(join(root, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
      await Bun.write(join(root, 'package.json'), '{"name":"rollback","version":"1.0.0"}');
      await Bun.write(join(root, 'apps/web/runtime.ts'), 'throw new TypeError("boot refused");\n');
      const options = { root, port: 0, env: {}, roles: ['web'] as const };

      const failed = await startDev({ ...options, roles: [...options.roles] }).then(
        () => 'booted',
        () => 'refused',
      );
      expect(failed).toBe('refused');
      expect(subscribed('db.statement')).toBe(false);
      // The request timings' other two events: nothing else in this file subscribes them.
      expect(subscribed('render.page')).toBe(false);

      // Removed rather than rewritten: a module whose evaluation threw stays thrown in this process.
      await rm(join(root, 'apps/web/runtime.ts'));
      const retried = await startDev({ ...options, roles: [...options.roles] });
      await retried.stop();
      // A boot that came up gives its subscribers back on stop, as the refused one did.
      expect(subscribed('db.statement')).toBe(false);
      expect(subscribed('render.page')).toBe(false);
    },
    BOOT_TIMEOUT_MS,
  );
});
