// The deployable artifact, as a real process. `x build --target docker` produces an image whose
// ENTRYPOINT is `bun apps/web/server.ts`, so the only test that can say the image runs is one that
// runs that file — spawned, on a port a platform chose, and asked the questions a platform asks:
// is it bound where I routed traffic, does /readyz answer, does SIGTERM drain rather than kill.
//
// The `server.ts` under test is the scaffold's own template, byte for byte. A hand-written copy
// here would prove that some server boots, which is not the claim.

import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { frameworkVersion, METRICS_PATH } from '@ultimat3/core';
// The package specifier, because `cli -> testing` is now a DECLARED sideways edge
// (scripts/lib/tiers.ts). It used to be `../../testing/src/sealed-network` with a comment saying
// the checker refused the real one — but a relative path is the same import wearing a costume, and
// package.json has listed `@ultimat3/testing` as a dependency of the CLI all along.
import { allowHost, bindFreePorts } from '@ultimat3/testing';
import { planNewApp } from './cmd-new';
import { processRoot } from './process-root-fixture';

/** Embedded Postgres, the queue, the transport and an HTTP role is seconds of real work. */
const BOOT_TIMEOUT_MS = 90_000;

const ROOT = processRoot(join(import.meta.dir, '..', '.serve-fixture'));

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

/** Who is waiting for the child's next chunk: woken by the pump, never by a poll interval. */
let waiting: (() => void)[] = [];
const nextChunk = (): Promise<void> =>
  new Promise((resolve) => {
    waiting.push(resolve);
  });
const wake = (): void => {
  const woken = waiting;
  waiting = [];
  for (const resolve of woken) resolve();
};

/** One pump per stream; reading a stream twice abandons the first reader forever. */
function pump(stream: ReadableStream<Uint8Array>): (() => string) & { ended: Promise<void> } {
  const decoder = new TextDecoder();
  let seen = '';
  const ended = (async () => {
    for await (const chunk of stream) {
      seen += decoder.decode(chunk, { stream: true });
      wake();
    }
    wake();
  })();
  return Object.assign(() => seen, { ended });
}

/**
 * The child's output once it holds `marker` — re-read on each chunk the child writes, the event
 * itself. A child that exits without it leaves this pending, and the test's own timeout says so.
 */
async function waitFor(seen: () => string, marker: string): Promise<string> {
  for (;;) {
    if (seen().includes(marker)) return seen();
    await nextChunk();
  }
}

/** A booted web role: the process, its two streams, and the two ports it bound. */
interface Served {
  readonly child: ReturnType<typeof Bun.spawn>;
  readonly out: () => string;
  readonly err: () => string;
  readonly port: number;
  readonly metricsPort: number;
}

/**
 * `apps/web/server.ts` as a platform starts it: `PORT` and `METRICS_PORT` named, so the process
 * binds both itself. Resolved once it logs `ultimate started`; a process that exits first meeting
 * a port another one took after it was handed out is booted again on fresh ones (`bindFreePorts`),
 * and any other exit is the test's failure with the process's own output.
 */
const served = (env: (ports: { port: number; metricsPort: number }) => Record<string, string>) =>
  bindFreePorts(
    async ([port = 0, metricsPort = 0]): Promise<Served> => {
      const child = Bun.spawn(['bun', join(ROOT, 'apps/web/server.ts')], {
        cwd: ROOT,
        env: { ...process.env, ...env({ port, metricsPort }) },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const out = pump(child.stdout);
      const err = pump(child.stderr);
      const outcome = await Promise.race([
        waitFor(() => out() + err(), 'ultimate started').then(() => 'started' as const),
        child.exited.then(() => 'exited' as const),
      ]);
      if (outcome === 'exited' && !(out() + err()).includes('ultimate started')) {
        await Promise.all([out.ended, err.ended]);
        return expect.unreachable(`the web role exited before it started: ${out() + err()}`);
      }
      return { child, out, err, port, metricsPort };
    },
    { count: 2 },
  );

/**
 * Port 1 (tcpmux): privileged, so no test process can listen there — a dial to it is refused
 * every time, which is what a dead NATS is, with no probed port another process could take.
 */
const REFUSED_PORT = 1;

/** `realtime` is the section's source text; unset is the scaffold's own (the in-process bus). */
async function writeFixture(realtime?: string): Promise<void> {
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(
    join(ROOT, 'package.json'),
    JSON.stringify({ name: 'serve-fixture', version: '1.0.0' }),
  );
  await Bun.write(
    join(ROOT, 'app.config.ts'),
    "import { defineConfig } from '@ultimat3/core';\n" +
      `export const config = defineConfig({ name: 'serve-fixture'${
        realtime === undefined ? '' : `, realtime: ${realtime}`
      } });\n`,
  );
  await Bun.write(join(ROOT, 'apps/web/server.ts'), scaffolded('apps/web/server.ts'));
  // The app's own MCP endpoint, in the contract `app-mcp.ts` reads: `apps/<app>/mcp.ts` exports
  // `mcp`. `resolveToken` answering `null` is "no bearer token is valid", which is enough to prove
  // the ROUTE is mounted — the route answers 401 by its own hand where a missing mount is 404.
  await Bun.write(
    join(ROOT, 'apps/web/mcp.ts'),
    "import { defineAppMcp } from '@ultimat3/mcp';\n" +
      "export const mcp = defineAppMcp({ include: 'exposed', resolveToken: () => null });\n",
  );
}

describe('the scaffolded production entry is a runnable artifact', () => {
  test(
    'binds $PORT on every interface, answers both health paths, and drains on SIGTERM',
    async () => {
      await writeFixture();
      // Exactly what a PaaS supplies: the port it routes to, and the role it wants. METRICS_PORT
      // is the operator's, not the platform's — the scrape lives off the routed port on purpose.
      const { child, out, err, port, metricsPort } = await served((ports) => ({
        PORT: String(ports.port),
        ROLE: 'web',
        METRICS_PORT: String(ports.metricsPort),
      }));
      try {
        // The seal exempts sockets THIS process opened; the artifact under test is a child, and
        // reaching it over a real socket is the whole assertion. Named per port, never unsealed.
        allowHost(`127.0.0.1:${port}`);

        // 127.0.0.1, not the reported origin: a process bound to 0.0.0.0 must be reachable on the
        // loopback address a platform's health probe and a Docker port mapping both use.
        const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
        expect(ready.status).toBe(200);
        expect(((await ready.json()) as { role?: string }).role).toBe('web');
        expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
        // The app's MCP endpoint is MOUNTED by this boot: 401 is the route's own verdict on a
        // request with no bearer token; a 404 here is the defect every scaffolded app shipped.
        const mcp = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });
        expect(mcp.status).not.toBe(404);
        expect(out() + err()).toContain('app mcp mounted');

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

  // Reachable on loopback and reported there. Inside a container that is unreachable through `-p`
  // (docker-proxy connects to the container's bridge address, never its loopback) and reachable only
  // where the container shares the host's network namespace — `--network host`, or a sidecar and
  // `ssh -L` inside it — which is exactly what an app that admits one implicit actor wants.
  test(
    'HOST=127.0.0.1 binds loopback, so an app that refuses a public interface can still boot',
    async () => {
      await writeFixture();
      // Named, as above: the scrape port is not this test's subject, and a fixed 9090 is whatever
      // the box already has bound there.
      const { child, out, err, port } = await served((ports) => ({
        PORT: String(ports.port),
        ROLE: 'web',
        HOST: '127.0.0.1',
        METRICS_PORT: String(ports.metricsPort),
      }));
      try {
        const started = await waitFor(() => out() + err(), 'ultimate started');
        // The address in the log IS the assertion: `0.0.0.0` here is a public bind reported as
        // if it were the one the operator asked for.
        expect(started).toContain(`"url":"http://127.0.0.1:${port}"`);
        expect(started).not.toContain('0.0.0.0');
        // Where the bus is, on the same line: `nats(connecting)` here is a served pod with NATS down.
        expect(started).toContain('"bus":"in-process"');
        // Which framework release booted, on the line an operator greps first.
        expect(started).toContain(`"frameworkVersion":"${frameworkVersion()}"`);
        allowHost(`127.0.0.1:${port}`);
        expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
        child.kill('SIGTERM');
        expect(await child.exited).toBe(0);
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

// The boot line's `bus` field on a real client, in both states a role that only publishes can
// boot in. A unit test can assert the label; only a booted process shows the LINE an operator
// reads — and that the web role reaches it at all with nothing listening where NATS should be.
describe('the boot line says where the bus is', () => {
  const NATS = '{ enabled: true }';
  const natsUrl = Bun.env['TEST_NATS_URL'];

  async function bootWeb(
    url: string,
  ): Promise<{ started: string; logs: () => string; port: number; stop(): Promise<void> }> {
    await writeFixture(NATS);
    const { child, out, err, port } = await served((ports) => ({
      PORT: String(ports.port),
      ROLE: 'web',
      HOST: '127.0.0.1',
      METRICS_PORT: String(ports.metricsPort),
      NATS_URL: url,
    }));
    const logs = (): string => out() + err();
    const stop = async (): Promise<void> => {
      child.kill('SIGKILL');
      await child.exited;
      await rm(ROOT, { recursive: true, force: true });
    };
    try {
      return { started: await waitFor(logs, 'ultimate started'), logs, port, stop };
    } catch (error) {
      await stop();
      throw error;
    }
  }

  const lineWith = (logs: string, message: string): string =>
    logs.split('\n').find((line) => line.includes(`"msg":"${message}"`)) ?? '';

  test(
    'nats(connecting): a web role boots and serves with nothing listening where NATS should be',
    async () => {
      const app = await bootWeb(`nats://127.0.0.1:${String(REFUSED_PORT)}`);
      try {
        expect(lineWith(app.started, 'ultimate started')).toContain('"bus":"nats(connecting)"');
        allowHost(`127.0.0.1:${app.port}`);
        expect((await fetch(`http://127.0.0.1:${app.port}/readyz`)).status).toBe(200);
        expect((await fetch(`http://127.0.0.1:${app.port}/readyz?deep=1`)).status).toBe(503);
        expect(app.logs()).not.toContain('"msg":"ultimate bus"');
      } finally {
        await app.stop();
      }
    },
    BOOT_TIMEOUT_MS,
  );

  test.skipIf(natsUrl === undefined)(
    'nats(up): with a server there, the dial lands and is announced',
    async () => {
      const app = await bootWeb(natsUrl ?? '');
      try {
        // A web role dials in the background (`runtime-bus.ts`), so the boot line may beat the
        // dial on a loaded machine: it says one of the two, and `ultimate bus` says it landed.
        expect(lineWith(app.started, 'ultimate started')).toMatch(
          /"bus":"nats\((?:up|connecting)\)"/,
        );
        const announced = lineWith(await waitFor(app.logs, '"msg":"ultimate bus"'), 'ultimate bus');
        expect(announced).toContain('"bus":"nats(up)"');
        expect(announced).toContain('"use":"publish"');
        allowHost(`127.0.0.1:${app.port}`);
        expect((await fetch(`http://127.0.0.1:${app.port}/readyz?deep=1`)).status).toBe(200);
      } finally {
        await app.stop();
      }
    },
    BOOT_TIMEOUT_MS,
  );
});
