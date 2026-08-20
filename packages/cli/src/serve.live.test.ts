// The deployable artifact, as a real process. `x build --target docker` produces an image whose
// ENTRYPOINT is `bun apps/web/server.ts`, so the only test that can say the image runs is one that
// runs that file — spawned, on a port a platform chose, and asked the questions a platform asks:
// is it bound where I routed traffic, does /readyz answer, does SIGTERM drain rather than kill.
//
// The `server.ts` under test is the scaffold's own template, byte for byte. A hand-written copy
// here would prove that some server boots, which is not the claim.

import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { METRICS_PATH } from '@ultimat3/core';
// The package specifier, because `cli -> testing` is now a DECLARED sideways edge
// (scripts/lib/tiers.ts). It used to be `../../testing/src/sealed-network` with a comment saying
// the checker refused the real one — but a relative path is the same import wearing a costume, and
// package.json has listed `@ultimat3/testing` as a dependency of the CLI all along.
import { allowHost } from '@ultimat3/testing';
import { planNewApp } from './cmd-new';

/** Embedded Postgres, the queue, the transport and an HTTP role is seconds of real work. */
const BOOT_TIMEOUT_MS = 90_000;

const ROOT = join(import.meta.dir, '..', '.serve-fixture');

/** The template `x new` writes, taken from the plan rather than retyped. */
function scaffolded(path: string): string {
  const file = planNewApp({ name: 'serve-fixture', example: false }).find(
    (candidate) => candidate.path === path,
  );
  if (file === undefined) return expect.unreachable(`x new writes no ${path}`);
  // `x new` DOES emit one byte-carrying file — the PNG icon — so this narrowing is load-bearing
  // here in a way it is not for `x g`: the fixture writes text files only.
  return typeof file.contents === 'string'
    ? file.contents
    : expect.unreachable(`${path} is bytes, not text`);
}

/** One pump per stream; reading a stream twice abandons the first reader forever. */
function pump(stream: ReadableStream<Uint8Array>): () => string {
  const decoder = new TextDecoder();
  let seen = '';
  void (async () => {
    for await (const chunk of stream) seen += decoder.decode(chunk, { stream: true });
  })();
  return () => seen;
}

async function waitFor(seen: () => string, marker: string): Promise<string> {
  for (;;) {
    if (seen().includes(marker)) return seen();
    await Bun.sleep(25);
  }
}

/** A port the kernel just handed out and immediately gave back — what a platform would inject. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = probe.port;
  probe.stop(true);
  // `Server.port` is `number | undefined` — a unix-socket server has none. `port: 0` always opens
  // a TCP one, so an absent port is a broken assumption rather than a number to default.
  return port ?? expect.unreachable('Bun.serve({ port: 0 }) opened no TCP port');
}

async function writeFixture(): Promise<void> {
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(
    join(ROOT, 'package.json'),
    JSON.stringify({ name: 'serve-fixture', version: '1.0.0' }),
  );
  await Bun.write(
    join(ROOT, 'app.config.ts'),
    "import { defineConfig } from '@ultimat3/core';\n" +
      "export const config = defineConfig({ name: 'serve-fixture' });\n",
  );
  await Bun.write(join(ROOT, 'apps/web/server.ts'), scaffolded('apps/web/server.ts'));
}

describe('the scaffolded production entry is a runnable artifact', () => {
  test(
    'binds $PORT on every interface, answers both health paths, and drains on SIGTERM',
    async () => {
      await writeFixture();
      const port = freePort();
      const metricsPort = freePort();
      const child = Bun.spawn(['bun', join(ROOT, 'apps/web/server.ts')], {
        cwd: ROOT,
        // Exactly what a PaaS supplies: the port it routes to, and the role it wants. METRICS_PORT
        // is the operator's, not the platform's — the scrape lives off the routed port on purpose.
        env: {
          ...process.env,
          PORT: String(port),
          ROLE: 'web',
          METRICS_PORT: String(metricsPort),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const out = pump(child.stdout);
      const err = pump(child.stderr);
      try {
        await waitFor(() => out() + err(), 'ultimate started');
        // The seal exempts sockets THIS process opened; the artifact under test is a child, and
        // reaching it over a real socket is the whole assertion. Named per port, never unsealed.
        allowHost(`127.0.0.1:${port}`);

        // 127.0.0.1, not the reported origin: a process bound to 0.0.0.0 must be reachable on the
        // loopback address a platform's health probe and a Docker port mapping both use.
        const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
        expect(ready.status).toBe(200);
        expect(((await ready.json()) as { role?: string }).role).toBe('web');
        expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);

        // The scrape a Kubernetes metric adapter takes, from a real deployed process — and NOT
        // from the port the ingress fronts: `/metrics` on the routed port would publish route
        // patterns, request volumes and error rates to the internet.
        expect((await fetch(`http://127.0.0.1:${port}${METRICS_PATH}`)).status).toBe(404);
        allowHost(`127.0.0.1:${metricsPort}`);
        const scrape = await fetch(`http://127.0.0.1:${metricsPort}${METRICS_PATH}`);
        expect(scrape.status).toBe(200);
        const body = await scrape.text();
        // The two probes above are already requests this process served, so the counter the `rps`
        // adapter differentiates has to be non-zero — an endpoint that renders an empty registry
        // would pass a "does /metrics answer" test and still leave every HPA at `<unknown>`.
        expect(body).toContain('# TYPE http_requests_total counter');
        expect(body).toContain('http_requests_total{method="GET",route="unmatched",status="4xx"}');

        child.kill('SIGTERM');
        expect(await child.exited).toBe(0);
        // The three-phase drain, not a kill: "stopped" is core's last line and only a drain
        // prints it. Without it the socket closes on whatever request was in flight.
        expect(await waitFor(() => out() + err(), '"msg":"stopped"')).toContain('draining');
      } finally {
        child.kill('SIGKILL');
        await child.exited;
        await rm(ROOT, { recursive: true, force: true });
      }
    },
    BOOT_TIMEOUT_MS,
  );

  test(
    'ROLE=migrate applies the ledger and exits, which is what a release phase runs',
    async () => {
      await writeFixture();
      const child = Bun.spawn(['bun', join(ROOT, 'apps/web/server.ts')], {
        cwd: ROOT,
        env: { ...process.env, ROLE: 'migrate' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const out = pump(child.stdout);
      const err = pump(child.stderr);
      try {
        // Exits on its own — no signal. A migrate role that kept running would hold a release
        // phase open forever, and every platform in `docker/README.md` waits on this exit code.
        expect(await child.exited).toBe(0);
        expect(out() + err()).toContain('ultimate migrate applied');
      } finally {
        child.kill('SIGKILL');
        await child.exited;
        await rm(ROOT, { recursive: true, force: true });
      }
    },
    BOOT_TIMEOUT_MS,
  );

  test(
    'ROLE=migrate exits NON-zero when the schema it just applied does not match the ledger',
    async () => {
      await writeFixture();
      // A migration that records a table it never creates. Applied cleanly, then the post-migrate
      // check finds the table missing — the one condition a release phase must not roll past.
      await Bun.write(
        join(ROOT, 'packages/db/migrations/0001_lies.sql'),
        '-- applies nothing, and claims a table\n',
      );
      await Bun.write(
        join(ROOT, 'packages/db/migrations/0001_lies.snapshot.json'),
        JSON.stringify({
          tables: [
            {
              schema: 'public',
              name: 'never_created',
              columns: [
                { name: 'id', dataType: 'uuid', nullable: false, default: null, position: 1 },
              ],
              primaryKey: ['id'],
              indexes: [],
              foreignKeys: [],
            },
          ],
        }),
      );
      const child = Bun.spawn(['bun', join(ROOT, 'apps/web/server.ts')], {
        cwd: ROOT,
        env: { ...process.env, ROLE: 'migrate' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const out = pump(child.stdout);
      const err = pump(child.stderr);
      try {
        // The exit code is the only channel a release phase has. Logging the drift and exiting 0
        // let the deploy continue over a schema nobody can reconstruct.
        expect(await child.exited).not.toBe(0);
        expect(out() + err()).toContain('X_DB_DRIFT');
      } finally {
        child.kill('SIGKILL');
        await child.exited;
        await rm(ROOT, { recursive: true, force: true });
      }
    },
    BOOT_TIMEOUT_MS,
  );
});
