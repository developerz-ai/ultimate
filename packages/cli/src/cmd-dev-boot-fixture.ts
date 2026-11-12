// TEST-ONLY. One booted `x dev` over `cmd-dev-fixture.ts`'s app, per test file that calls it: the
// boot before the file, the teardown that gives every process-wide registry back after it, and the
// two ways a test reaches the running app. Shared so the suites split by concern boot one way.

import { afterAll, beforeAll, expect } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { isolateDeclaredTags } from '@ultimat3/cache';
import { NotImplementedError, resetLifecycle } from '@ultimat3/core';
import type { DevServer } from './cmd-dev';
import { startDev } from './cmd-dev';
import { DEV_FIXTURE_FILES as FILES, resetRegistries } from './cmd-dev-fixture';
import { processRoot } from './process-root-fixture';

/**
 * Booting embedded Postgres, the queue and the HTTP role is seconds of real work, and bun's
 * default hook budget is 5s — close enough to this boot that a loaded machine decided whether the
 * file passed. Every timeout is explicit and generous for that reason: a hang should be reported
 * as a hang, never as a boot that was 300ms slower than the runner's default.
 */
export const BOOT_TIMEOUT_MS = 60_000;

export interface BootedDev {
  /** The running `x dev` — read inside a test, never at module scope (it boots in `beforeAll`). */
  readonly server: DevServer;
  /** The app's root on disk, this process's own. */
  readonly root: string;
  /** The `METRICS_PORT` this boot was handed. */
  readonly metricsPort: number;
  fetchDev(path: string, init?: RequestInit): Promise<Response>;
  /** A statement for `/_x/db`: POSTed in the body — a GET naming `sql` is refused (a cross-site `<img>`). */
  runSql(sql: string): Promise<Response>;
}

/** Bound and released: `METRICS_PORT` is read as a NAMED port, so it can be neither 0 nor 9090. */
const freePort = (): number => {
  const probe = Bun.serve({ port: 0, hostname: 'localhost', fetch: () => new Response('') });
  const port = Number(new URL(probe.url).port);
  probe.stop(true);
  return port;
};

/**
 * Boot the fixture app under `packages/cli/<base>/run-<pid>` — under `packages/cli/` so its
 * `@ultimat3/*` imports resolve through the framework's own tsconfig paths; a dot-prefixed `base`
 * keeps it out of every workspace glob. Each file passes its own `base`.
 */
export function bootDevFixture(base: string): BootedDev {
  const root = processRoot(join(import.meta.dir, '..', base));
  const metricsPort = freePort();
  let server: DevServer | undefined;

  beforeAll(async () => {
    await rm(root, { recursive: true, force: true });
    for (const [path, contents] of Object.entries(FILES))
      await Bun.write(join(root, path), contents);
    resetRegistries();
    // Port 0 never collides with a running `x dev`; `x dev` ignoring either env value is under test.
    server = await startDev({
      root,
      port: 0,
      env: { METRICS_PORT: String(metricsPort), BUILD_ID: 'stamped-7' },
      roles: ['web', 'sync', 'worker', 'scheduler'],
    });
  }, BOOT_TIMEOUT_MS);

  // `declareTags` is additive and process-wide, so a `devfixture` tag a file declares turned on
  // tag validation for every later file — `packages/query`'s read-cache suite then failed
  // X_CACHE_TAG_UNKNOWN on `post`. A reset would drop a neighbour's too; this puts back what it found.
  const restoreTags = isolateDeclaredTags();

  // The restores go in the `finally`: a rejected `stop()` or `rm()` would otherwise skip them and
  // hand every later file in this process a registry this file filled — the exact leak above.
  afterAll(async () => {
    try {
      await server?.stop();
      await rm(root, { recursive: true, force: true });
    } finally {
      resetRegistries();
      restoreTags();
      resetLifecycle(); // `stop()` drained it: a later file's request would answer 503 X_DRAINING
    }
  }, BOOT_TIMEOUT_MS);

  const booted = (): DevServer =>
    server ?? expect.unreachable('dev.server was read before beforeAll booted it');

  const fetchDev = (path: string, init?: RequestInit): Promise<Response> => {
    const handle = booted().running.server;
    // Never a bare Error, tests included: a throw without a code and a fix is not an instruction.
    if (handle === null) {
      throw new NotImplementedError({
        cause: 'no web role in this x dev',
        fix: 'x dev --role web',
      });
    }
    // `localhost`: `/_x` refuses any Host that is not this machine (`X_DEV_HOST_REFUSED`, 421).
    return handle.fetch(new Request(`http://localhost${path}`, init));
  };

  return {
    get server() {
      return booted();
    },
    root,
    metricsPort,
    fetchDev,
    runSql: (sql) =>
      fetchDev('/_x/db?json=1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql }),
      }),
  };
}
