// `x dev` as a real, supervised process: a new page — a route the boot never mounted — is served by a
// fresh child, and the restart line says why: what the save added to the mounted surface, never
// "a module that defines a primitive" (the only line a restart had until FX5). A `live` test for the
// reason `cmd-dev.live.test.ts` gives: it spawns `x dev` and boots an embedded Postgres, twice.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no recursive remove nor a bare mkdir, only a per-file write and delete.
import { mkdir, rm } from 'node:fs/promises';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { allowHost } from '@ultimat3/testing';
import { descendantsOf, leftovers, pump, reap, reapIn, waitFor } from './dev-live-fixture';
import { processRoot } from './process-root-fixture';

/** Two boots of embedded Postgres, the queue and the HTTP role — explicit, and generous. */
const TIMEOUT_MS = 120_000;
const ROOT = processRoot(join(import.meta.dir, '..', '.dev-remount-fixture'));
const BIN = join(import.meta.dir, 'bin.ts');
const PAGE = 'apps/web/app/fresh/page.tsx';

const page = (title: string): string => `import { defineRoute } from '@ultimat3/render';
export const config = defineRoute({
  render: 'ssr',
  hydrate: 'never',
  offline: 'runtime',
  budget: { js: '0kb' },
  meta: () => ({ title: '${title}', description: 'A page the boot never mounted' }),
});
export function Page() {
  return <main><p>${title}</p></main>;
}
`;

const FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'dev-remount-fixture', version: '1.0.0' }),
  // Its own repository, so the watcher's ignore walk stops here (see `cmd-dev-fixture.ts`).
  '.git/HEAD': 'ref: refs/heads/main\n',
  'app.config.ts': `import { defineConfig } from '@ultimat3/core';
export const config = defineConfig({ name: 'dev-remount-fixture' });
`,
  'apps/web/app/hello/page.tsx': page('hello'),
};

/** The response, or `undefined` while the port is between two children. */
const get = async (url: string): Promise<Response | undefined> => {
  try {
    return await fetch(url);
  } catch {
    return undefined;
  }
};

// A timed-out test never reaches its `finally`; this is what still reaps its children.
afterEach(async () => {
  await reapIn(ROOT);
});

describe('x dev restarts on a save that changes what it mounted', () => {
  test(
    'a new page is served by a fresh child, and the restart line names the route it added',
    async () => {
      await rm(ROOT, { recursive: true, force: true });
      for (const [path, contents] of Object.entries(FILES)) {
        await Bun.write(join(ROOT, path), contents);
      }
      // The page's directory exists at boot, so the watcher's tick names the page, not a new dir.
      await mkdir(join(ROOT, PAGE, '..'), { recursive: true });
      // `--port 0` and `METRICS_PORT=0`, for the reasons `cmd-dev-restart.live.test.ts` gives.
      const child = Bun.spawn(['bun', BIN, 'dev', '--port', '0', '--json'], {
        cwd: ROOT,
        env: { ...Bun.env, METRICS_PORT: '0' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = pump(child.stdout);
      const logs = pump(child.stderr);
      let port: number | undefined;
      const started = new Set<number>();
      try {
        const first = await waitFor(output, '"command":"dev"');
        const url = /"url":"([^"]+)"/.exec(first)?.[1];
        if (url === undefined) return expect.unreachable(`no url in ${first}`);
        port = Number(new URL(url).port);
        for (const pid of descendantsOf(child.pid)) started.add(pid);
        allowHost(new URL(url).host);
        expect((await get(`${url}/fresh`))?.status).toBe(404);

        await Bun.write(join(ROOT, PAGE), page('fresh'));
        let served = '';
        while (!served.includes('<p>fresh</p>')) {
          // real-clock: the restarted child boots an embedded Postgres on its own time
          await Bun.sleep(100);
          const response = await get(`${url}/fresh`);
          served = response?.status === 200 ? await response.text() : '';
        }
        expect(logs.seen()).toContain(
          `restarting: ${PAGE} changed what x dev mounts (route /fresh (ssr, app) added) — the route table is built once, at boot`,
        );
        expect(logs.seen()).not.toContain('defines a primitive');
        for (const pid of descendantsOf(child.pid)) started.add(pid);
        expect(child.exitCode).toBeNull();
        child.kill('SIGINT');
        expect(await child.exited).toBe(0);
      } finally {
        await reap([child.pid, ...started, ...descendantsOf(child.pid)]);
        await rm(ROOT, { recursive: true, force: true });
        expect(await leftovers(ROOT, port)).toEqual({ pids: [], port: false });
      }
    },
    TIMEOUT_MS,
  );
});
