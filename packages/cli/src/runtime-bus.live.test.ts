// A web role and a real nats-server that is not there. The unit suite proves the contract against
// an in-memory bus; only a real client shows what the library does while it cannot reach a server
// — it retries a first dial for minutes and QUEUES publishes made during a reconnect — which is
// exactly what made NATS a boot dependency of a role that only publishes to it.
//
// The server is shared and not this file's to stop, so "down" is a TCP relay that is not
// listening: the url the runtime dials is the relay's port, and the subscriber standing in for a
// `sync` node dials the server directly.
//
// Skips unless a server is configured. Locally:
//
//   docker run -d --name x-nats -p 4222:4222 nats:2.11-alpine -js
//   TEST_NATS_URL=nats://localhost:4222 bun test packages/cli/src/runtime-bus.live.test.ts

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import type { HealthReport } from '@ultimat3/core';
import { isUltimateError, resetLifecycle } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { channel, clearChannels } from '@ultimat3/realtime';
import type { TransportSelection } from '@ultimat3/realtime/server';
import { publishChannelEvent, selectTransport } from '@ultimat3/realtime/server';
import { advanceClock } from '@ultimat3/testing';
import type { RunningRoles } from './role-start';
import { startRoles } from './role-start';
import { resolveServices } from './runtime-bindings';
import { busLabel } from './runtime-bus';
import type { RunningServices } from './runtime-services';
import { startServices } from './runtime-services';

const url = Bun.env['TEST_NATS_URL'];
const NATS = { enabled: true, transport: 'nats', urlEnv: 'NATS_URL' } as const;

/** A boot, a first dial's backoff and a reconnect's: seconds each, and the curve is jittered. */
const TIMEOUT_MS = 120_000;

interface Leg {
  peer: { write(bytes: Uint8Array): number; end(): void } | undefined;
  readonly early: Uint8Array[];
}

interface Relay {
  readonly port: number;
  /** Stop listening and end every relayed connection: the server is gone. */
  down(): void;
  /** Listen again on the same port: the server is back. */
  up(): void;
}

/** A TCP relay to the real server on one fixed port, which a test can take down and bring back. */
function relayTo(host: string, port: number): Relay {
  const clients = new Set<{ end(): void }>();
  const listen = (on: number) =>
    Bun.listen<Leg>({
      hostname: '127.0.0.1',
      port: on,
      socket: {
        open(client) {
          client.data = { peer: undefined, early: [] };
          clients.add(client);
          // Not awaited: `open` is synchronous, and the server speaks first (INFO) once this lands.
          void Bun.connect<Leg>({
            hostname: host,
            port,
            socket: {
              open(upstream) {
                upstream.data = { peer: client, early: [] };
                client.data.peer = upstream;
                for (const bytes of client.data.early.splice(0)) upstream.write(bytes);
              },
              data(_upstream, bytes) {
                client.write(bytes);
              },
              close() {
                client.end();
              },
              error() {
                client.end();
              },
            },
          }).catch(() => client.end());
        },
        data(client, bytes) {
          // Copied: the runtime reuses the chunk's buffer once this handler returns.
          if (client.data.peer === undefined) client.data.early.push(Uint8Array.from(bytes));
          else client.data.peer.write(bytes);
        },
        close(client) {
          clients.delete(client);
          client.data.peer?.end();
        },
      },
    });
  // The port is chosen by listening once, then held by number: "down" is nobody listening on it.
  let listener: ReturnType<typeof listen> | undefined = listen(0);
  const fixed = listener.port;
  return {
    port: fixed,
    down() {
      listener?.stop(true);
      listener = undefined;
      for (const client of [...clients]) client.end();
    },
    up() {
      listener ??= listen(fixed);
    },
  };
}

let running: RunningRoles | undefined;
let runtime: RunningServices | undefined;
let root: string | undefined;
let relay: Relay | undefined;
let syncSide: TransportSelection | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  await runtime?.stop().catch(() => undefined);
  runtime = undefined;
  await syncSide?.transport.close();
  syncSide = undefined;
  relay?.down();
  relay = undefined;
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
  clearChannels();
  resetLifecycle();
}, TIMEOUT_MS);

const codeOf = (value: unknown): string =>
  isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;

/**
 * Poll in real time, and move the frozen clock with it. The library redials a server once
 * `lastConnect + wait <= Date.now()`, and the test preload freezes `Date.now()` — so without the
 * second half no positive backoff is ever reached, and this boot's backoff is the production one.
 */
const until = async (done: () => boolean | Promise<boolean>, seconds: number): Promise<void> => {
  const deadline = Bun.nanoseconds() + seconds * 1_000_000_000;
  while (!(await done()) && Bun.nanoseconds() < deadline) {
    await Bun.sleep(50);
    advanceClock(50);
  }
};

interface Readyz {
  readonly status: number;
  readonly body: HealthReport;
}

const readyz = async (base: string, query = ''): Promise<Readyz> => {
  const response = await fetch(`${base}/readyz${query}`);
  return { status: response.status, body: (await response.json()) as HealthReport };
};

describe.skipIf(url === undefined)('a web role and a NATS that is not there', () => {
  test(
    'boots and serves with the bus down, refuses publishes typed, and resumes on its own — twice',
    async () => {
      const target = new URL(url ?? '');
      relay = relayTo(target.hostname, Number(target.port === '' ? 4222 : target.port));
      relay.down();
      root = mkdtempSync(join(tmpdir(), 'x-bus-down-'));
      writeFileSync(
        join(root, 'app.config.ts'),
        "export const config = { name: 'bus-down', realtime: { enabled: true, transport: 'nats', urlEnv: 'NATS_URL' } };\n",
      );
      const env = { ULTIMATE_ENV: 'development', NATS_URL: `nats://127.0.0.1:${relay.port}` };
      const feed = channel('bus-live-feed', {
        params: ['orgId'],
        catchUp: { name: 'busLiveFeedRead' },
        events: true,
        policy: allow('public'),
      });
      const publish = (): Promise<unknown> =>
        publishChannelEvent(feed, { orgId: 'o1' }, { kind: 'changed' }).then(
          () => undefined,
          (error: unknown) => error,
        );

      // NATS DOWN, and the web role boots anyway. Before this landed the line below sat in the
      // library's first-dial budget — ten attempts on a 30 s backoff — and then rejected.
      const bootedAt = performance.now();
      runtime = await startServices(resolveServices(root, env), env, undefined, 'apply', ['web']);
      running = await startRoles({
        roles: ['web'],
        port: 0,
        metricsPort: 0,
        buildId: 'build-1',
        runtime,
        routes: [],
        env: {},
      });
      expect(performance.now() - bootedAt).toBeLessThan(30_000);
      const base = running.url ?? expect.unreachable('the web role reported no url');
      expect(runtime.busUse).toBe('publish');
      expect(busLabel(runtime.transport)).toBe('nats(connecting)');

      // It serves: ready for the probe, `degraded` by name, and a 503 only for the deep reading.
      const shallow = await readyz(base);
      expect(shallow.status).toBe(200);
      expect(shallow.body.checks['transport']).toBe('degraded');
      expect(shallow.body.checks['database']).toBe('ok');
      expect((await readyz(base, '?deep=1')).status).toBe(503);

      // A publish is the typed refusal an app's `catch` already handles, and it is immediate.
      const refusedAt = performance.now();
      expect(codeOf(await publish())).toBe('X_TRANSPORT_UNAVAILABLE');
      expect(performance.now() - refusedAt).toBeLessThan(1_000);

      // The subscriber a `sync` node is: on the real server, with the presence bucket it needs.
      syncSide = selectTransport({ NATS_URL: url }, NATS, { use: 'sockets' });
      await syncSide.connect();
      const heard: string[] = [];
      await syncSide.transport.subscribe('x.channel.bus-live-feed.>', (payload) => {
        heard.push(payload);
      });

      // NATS UP: no restart, and inside the dial's backoff a publish reaches the sync side.
      relay.up();
      const serving = runtime;
      await until(() => busLabel(serving.transport) === 'nats(up)', 90);
      expect(busLabel(serving.transport)).toBe('nats(up)');
      expect(await publish()).toBeUndefined();
      await until(() => heard.length === 1, 10);
      expect(heard).toHaveLength(1);
      expect((await readyz(base, '?deep=1')).status).toBe(200);

      // NATS DIES MID-FLIGHT. The process stays up and ready, and a publish is refused at once
      // rather than queued in the client for whenever the server returns.
      relay.down();
      await until(() => busLabel(serving.transport) === 'nats(connecting)', 30);
      expect(busLabel(serving.transport)).toBe('nats(connecting)');
      const droppedAt = performance.now();
      expect(codeOf(await publish())).toBe('X_TRANSPORT_UNAVAILABLE');
      expect(performance.now() - droppedAt).toBeLessThan(1_000);
      const during = await readyz(base);
      expect(during.status).toBe(200);
      expect(during.body.checks['transport']).toBe('degraded');

      // AND COMES BACK: publishing resumes, and what was refused in the gap is not replayed.
      relay.up();
      await until(() => busLabel(serving.transport) === 'nats(up)', 90);
      expect(busLabel(serving.transport)).toBe('nats(up)');
      expect(await publish()).toBeUndefined();
      await until(() => heard.length === 2, 10);
      await Bun.sleep(200);
      expect(heard).toHaveLength(2);
    },
    TIMEOUT_MS,
  );

  test(
    'a sync role with the bus down refuses its boot, coded, inside the bounded wait',
    async () => {
      relay = relayTo('127.0.0.1', 1);
      relay.down();
      root = mkdtempSync(join(tmpdir(), 'x-bus-down-'));
      writeFileSync(
        join(root, 'app.config.ts'),
        "export const config = { name: 'bus-down', realtime: { enabled: true, transport: 'nats', urlEnv: 'NATS_URL' } };\n",
      );
      const env = { ULTIMATE_ENV: 'development', NATS_URL: `nats://127.0.0.1:${relay.port}` };

      const startedAt = performance.now();
      const refused = await startServices(resolveServices(root, env), env, undefined, 'apply', [
        'sync',
      ]).then(
        (started) => {
          runtime = started;
          return undefined;
        },
        (error: unknown) => error,
      );

      expect(codeOf(refused)).toBe('X_TRANSPORT_UNAVAILABLE');
      const said = isUltimateError(refused) ? `${refused.cause} | ${refused.fix}` : '';
      expect(said).toContain(`127.0.0.1:${relay.port}`);
      expect(said).toContain('NATS_URL');
      expect(said).toContain('serves sockets');
      // The wait is 15 s, plus the embedded database's boot; never the library's minutes.
      expect(performance.now() - startedAt).toBeLessThan(45_000);
    },
    TIMEOUT_MS,
  );
});
