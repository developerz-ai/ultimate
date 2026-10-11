// The bus as one boot holds it. What is proven here is the per-role contract: a role that only
// publishes boots with NATS down and reports the bus `degraded`; a role that serves sockets
// refuses, fast and coded. Until 2026-10 every role awaited the dial, so a web pod that restarted
// during a NATS outage never served a page.

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  isUltimateError,
  logger,
  markReady,
  type Role,
  readinessCheckCount,
  readyzPayload,
  resetLifecycle,
} from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { channel, clearChannels } from '@ultimat3/realtime';
import type { SelectTransportOptions } from '@ultimat3/realtime/server';
import {
  BUS_CONNECT_WAIT_MS,
  FakeNatsBroker,
  fakeNatsConnect,
  publishChannelEvent,
} from '@ultimat3/realtime/server';
import { busLabel, busUseFor, DEV_BUS_WAIT_MS, selectBus } from './runtime-bus';

const ENV = { NATS_URL: 'nats://bus.test:4222' } as const;
const NATS = { enabled: true, transport: 'nats', urlEnv: 'NATS_URL' } as const;
const MEMORY = { enabled: true, transport: 'memory', urlEnv: undefined } as const;

const codeOf = (value: unknown): string =>
  isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;

const caught = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

const waitFor = async (done: () => boolean, polls = 500): Promise<void> => {
  for (let poll = 0; poll < polls && !done(); poll += 1) await Bun.sleep(2);
};

const fake = (broker: FakeNatsBroker): SelectTransportOptions => ({
  connect: fakeNatsConnect(broker),
  backoff: { baseMs: 2, maxMs: 2, factor: 1, jitter: 'none' },
  onError: () => undefined,
});

beforeEach(() => resetLifecycle());
afterEach(() => {
  resetLifecycle();
  clearChannels();
});

describe('busUseFor', () => {
  test('a sync node serves sockets, a replicator feeds them, every other role only publishes', () => {
    expect(busUseFor(['sync'], NATS)).toBe('sockets');
    expect(busUseFor(['web', 'sync', 'worker', 'scheduler'], NATS)).toBe('sockets');
    expect(busUseFor(['replicator'], NATS)).toBe('feed');
    expect(busUseFor(['web'], NATS)).toBe('publish');
    expect(busUseFor(['worker'], NATS)).toBe('publish');
    expect(busUseFor(['scheduler'], NATS)).toBe('publish');
    expect(busUseFor([], NATS)).toBe('publish');
  });

  test('realtime.enabled: false starts no realtime role, so no role waits for the bus', () => {
    const off = { ...NATS, enabled: false };
    expect(busUseFor(['sync'], off)).toBe('publish');
    expect(busUseFor(['web', 'sync', 'replicator'], off)).toBe('publish');
  });

  test('a boot that names no roles is held to the strictest reading', () => {
    expect(busUseFor(undefined, NATS)).toBe('sockets');
  });
});

describe('selectBus().start(), for a role that only publishes', () => {
  test('boots with NATS down: degraded on /readyz?deep=1, ready on /readyz, publish refused typed', async () => {
    const broker = new FakeNatsBroker();
    broker.offline = true;
    const bus = selectBus({ env: ENV, realtime: NATS, roles: ['web'], select: fake(broker) });

    const running = await bus.start();
    markReady();
    try {
      expect(bus.use).toBe('publish');
      expect(busLabel(running.transport)).toBe('nats(connecting)');
      const shallow = readyzPayload();
      expect(shallow.status).toBe(200);
      expect(shallow.body.checks).toEqual({ transport: 'degraded' });
      expect(readyzPayload({ deep: true }).status).toBe(503);

      // The app's own publish: the typed refusal its `catch` already handles, and at once.
      const feed = channel('bus-feed', {
        params: ['orgId'],
        catchUp: { name: 'busFeedRead' },
        events: true,
        policy: allow('public'),
      });
      const refused = await caught(publishChannelEvent(feed, { orgId: 'o1' }, { kind: 'changed' }));
      expect(codeOf(refused)).toBe('X_TRANSPORT_UNAVAILABLE');

      // The bus comes back: no restart, and the same publish is delivered.
      const heard: string[] = [];
      broker.client().subscribe('x.channel.>', (message) => heard.push(message.subject));
      broker.offline = false;
      await waitFor(() => busLabel(running.transport) === 'nats(up)');
      expect(busLabel(running.transport)).toBe('nats(up)');
      expect(readyzPayload().body.checks).toEqual({ transport: 'ok' });
      expect(readyzPayload({ deep: true }).status).toBe(200);
      await publishChannelEvent(feed, { orgId: 'o1' }, { kind: 'changed' });
      expect(heard).toEqual(['x.channel.bus-feed.o1']);
    } finally {
      await running.stop();
    }
    expect(readinessCheckCount()).toBe(0);
    expect(broker.clients).toHaveLength(1); // the test's own listener; the boot's is closed
  });

  // Claimed in the changelog and the wiki: the other half of a boot line that said `connecting`.
  test('logs `ultimate bus` with bus=nats(up) when the dial lands, and again after every recovery', async () => {
    const lines: { message: string; fields: Record<string, unknown> | undefined }[] = [];
    const info = logger.info;
    logger.info = (message: string, fields?: Record<string, unknown>): void => {
      lines.push({ message, fields });
    };
    const broker = new FakeNatsBroker();
    broker.offline = true;
    const bus = selectBus({ env: ENV, realtime: NATS, roles: ['web'], select: fake(broker) });
    const running = await bus.start();
    const said = (): unknown[] =>
      lines.filter((line) => line.message === 'ultimate bus').map((line) => line.fields);
    try {
      await Bun.sleep(10);
      expect(said()).toEqual([]);

      broker.offline = false;
      await waitFor(() => said().length === 1);
      expect(said()).toEqual([{ bus: 'nats(up)', use: 'publish' }]);

      broker.drop();
      expect(busLabel(running.transport)).toBe('nats(connecting)');
      broker.restore();
      expect(said()).toEqual([
        { bus: 'nats(up)', use: 'publish' },
        { bus: 'nats(up)', use: 'publish' },
      ]);
    } finally {
      await running.stop();
      logger.info = info;
    }
    // Released with the boot: a later recovery of a transport nobody holds says nothing.
    expect(said()).toHaveLength(2);
  });

  test('a server with no JetStream costs a publisher nothing', async () => {
    const broker = new FakeNatsBroker();
    broker.fail('$JS.API', 1_000);
    const bus = selectBus({ env: ENV, realtime: NATS, roles: ['worker'], select: fake(broker) });
    const running = await bus.start();
    try {
      await waitFor(() => busLabel(running.transport) === 'nats(up)');
      expect(busLabel(running.transport)).toBe('nats(up)');
      expect(broker.streams).toEqual([]);
    } finally {
      await running.stop();
    }
  });

  test('realtime.enabled: false never waits for the bus, whatever role was asked for', async () => {
    const broker = new FakeNatsBroker();
    broker.offline = true;
    const bus = selectBus({
      env: ENV,
      realtime: { ...NATS, enabled: false },
      roles: ['web', 'sync'],
      select: fake(broker),
    });
    const running = await bus.start();
    expect(busLabel(running.transport)).toBe('nats(connecting)');
    await running.stop();
  });
});

describe('selectBus().start(), for a role that serves sockets', () => {
  test('refuses the boot inside its wait, coded, and leaves nothing registered', async () => {
    const hung = Promise.withResolvers<never>();
    const bus = selectBus({
      env: ENV,
      realtime: NATS,
      roles: ['sync'],
      select: { connect: () => hung.promise, connectWithinMs: 30 },
    });

    const startedAt = performance.now();
    const refused = await caught(bus.start());

    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(codeOf(refused)).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(isUltimateError(refused) ? refused.cause : '').toContain('within 30ms');
    expect(isUltimateError(refused) ? refused.fix : '').toContain('NATS_URL');
    expect(readinessCheckCount()).toBe(0);
  });

  test('once up, a lost bus FAILS readiness: a sync node cannot serve without it', async () => {
    const broker = new FakeNatsBroker();
    const bus = selectBus({ env: ENV, realtime: NATS, roles: ['sync'], select: fake(broker) });
    const running = await bus.start();
    markReady();
    try {
      expect(busLabel(running.transport)).toBe('nats(up)');
      // The node serves presence, so its dial is what creates the bucket.
      expect(broker.streams).toEqual(['KV_x_presence']);
      broker.drop();
      expect(readyzPayload().body.checks).toEqual({ transport: 'failing' });
      expect(readyzPayload().status).toBe(503);
    } finally {
      await running.stop();
    }
  });
});

// `x dev` runs every role in one process. Until 2026-10-10 its `sync` role's refusal ended the whole
// boot 15 s in — no page served — and a bus lost under a running one failed plain `/readyz`.
describe('selectBus().start(), under x dev with a role that serves sockets', () => {
  const ALL: readonly Role[] = ['web', 'sync', 'worker', 'scheduler'];

  test('boots with NATS down: the coded refusal is logged ONCE at warn, the dial goes on, and it lands with no restart', async () => {
    const warned: { message: string; fields: Record<string, unknown> | undefined }[] = [];
    const warn = spyOn(logger, 'warn').mockImplementation((message, fields) => {
      warned.push({ message, fields });
    });
    const broker = new FakeNatsBroker();
    broker.offline = true;
    const bus = selectBus({
      env: ENV,
      realtime: NATS,
      roles: ALL,
      dev: true,
      select: { ...fake(broker), connectWithinMs: 30 },
    });
    expect(bus.use).toBe('sockets');
    expect(bus.tolerant).toBe(true);

    const startedAt = performance.now();
    const running = await bus.start();
    markReady();
    try {
      expect(performance.now() - startedAt).toBeLessThan(2_000);
      expect(busLabel(running.transport)).toBe('nats(connecting)');
      const said = warned.filter((line) => line.message.startsWith('ultimate bus is away'));
      expect(said).toHaveLength(1);
      expect(said[0]?.fields?.['code']).toBe('X_TRANSPORT_UNAVAILABLE');
      expect(String(said[0]?.fields?.['cause'])).toContain('within 30ms');
      // The pages are served from this process: the bus is a degradation, never a 503.
      expect(readyzPayload().status).toBe(200);
      expect(readyzPayload().body.checks).toEqual({ transport: 'degraded' });

      broker.offline = false;
      await waitFor(() => busLabel(running.transport) === 'nats(up)');
      expect(busLabel(running.transport)).toBe('nats(up)');
      expect(readyzPayload().body.checks).toEqual({ transport: 'ok' });
      // Still one line: the retries in between said nothing here.
      expect(warned.filter((line) => line.message.startsWith('ultimate bus is away'))).toHaveLength(
        1,
      );
    } finally {
      warn.mockRestore();
      await running.stop();
    }
    expect(readinessCheckCount()).toBe(0);
  });

  test('a bus lost under a running x dev leaves plain /readyz at 200', async () => {
    const broker = new FakeNatsBroker();
    const bus = selectBus({
      env: ENV,
      realtime: NATS,
      roles: ALL,
      dev: true,
      select: fake(broker),
    });
    const running = await bus.start();
    markReady();
    try {
      broker.drop();
      expect(readyzPayload().status).toBe(200);
      expect(readyzPayload().body.checks).toEqual({ transport: 'degraded' });
      expect(readyzPayload({ deep: true }).status).toBe(503);
    } finally {
      await running.stop();
    }
  });

  test('waits 3 s for the bus by default, never the container’s 15', () => {
    expect(DEV_BUS_WAIT_MS).toBe(3_000);
    expect(DEV_BUS_WAIT_MS).toBeLessThan(BUS_CONNECT_WAIT_MS);
  });

  test('a container is NOT tolerant, whatever its roles — and x dev is not for a publisher', () => {
    const broker = new FakeNatsBroker();
    const select = fake(broker);
    expect(selectBus({ env: ENV, realtime: NATS, roles: ['sync'], select }).tolerant).toBe(false);
    expect(selectBus({ env: ENV, realtime: NATS, roles: ALL, select }).tolerant).toBe(false);
    expect(
      selectBus({ env: ENV, realtime: NATS, roles: ['web'], dev: true, select }).tolerant,
    ).toBe(false);
  });
});

describe('selectBus(), the cases that are not NATS', () => {
  test('the in-process bus has no state to report and registers no check', async () => {
    const bus = selectBus({ env: {}, realtime: MEMORY, roles: ['web'] });
    const running = await bus.start();
    expect(busLabel(running.transport)).toBe('in-process');
    expect(readinessCheckCount()).toBe(0);
    await running.stop();
  });

  test('a transport the host supplied is used as it is, and never closed by the boot', async () => {
    const broker = new FakeNatsBroker();
    const own = selectBus({ env: ENV, realtime: NATS, roles: ['sync'], select: fake(broker) });
    const supplied = (await own.start()).transport;
    resetLifecycle();
    let closed = 0;
    const close = supplied.close.bind(supplied);
    supplied.close = async (): Promise<void> => {
      closed += 1;
      await close();
    };

    const bus = selectBus({ env: {}, realtime: MEMORY, roles: ['web'], override: supplied });
    const running = await bus.start();
    expect(running.transport).toBe(supplied);
    expect(running.detail).toBe('runtime override');
    await running.stop();
    expect(closed).toBe(0);
    await close();
  });
});
