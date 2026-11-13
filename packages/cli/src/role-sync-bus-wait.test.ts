// The `sync` role with its bus away. A container refuses the boot — coded, as before. `x dev`
// (`busTolerated`) keeps the node mounted and not ready, sheds every upgrade with a retry delay,
// and starts the node when the bus answers: the same process went on serving pages meanwhile.

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { isUltimateError, logger, resetLifecycle } from '@ultimat3/core';
import { configureAuthenticator, resetAuthenticator } from '@ultimat3/http';
import { clearChannels } from '@ultimat3/realtime';
import { FakeNatsBroker, fakeNatsConnect } from '@ultimat3/realtime/server';
import type { StartRolesOptions } from './role-start';
import { prepareSync } from './role-sync';
import { selectBus } from './runtime-bus';
import type { RunningServices } from './runtime-services';

const ENV = { NATS_URL: 'nats://bus.test:4222' } as const;
const REALTIME = { enabled: true } as const;
const takes = { upgrade: () => true, requestIP: () => null };

/**
 * The dial loop's backoff, armed by hand (`SelectTransportOptions.scheduler`): a re-dial happens
 * when the test fires it, never when a loaded runner's clock gets round to it. A cancel removes
 * the entry, so a stopped transport's wait is gone from the queue as it would be from the timers.
 */
let pending: { readonly fn: () => void }[] = [];
const scheduler = (fn: () => void): (() => void) => {
  const entry = { fn };
  pending.push(entry);
  return () => {
    pending = pending.filter((armed) => armed !== entry);
  };
};

/** One macrotask turn: every promise a fired dial chained has settled. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Fire every armed backoff, then let the dials it started run: `rounds` times over. */
async function redial(rounds: number, done: () => boolean = () => false): Promise<void> {
  for (let left = rounds; left > 0 && !done(); left -= 1) {
    for (const armed of pending.splice(0)) armed.fn();
    for (let turns = 0; turns < 10; turns += 1) await turn();
  }
}

const stops: (() => Promise<void>)[] = [];
beforeEach(() => {
  pending = [];
  resetLifecycle();
});
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  resetLifecycle();
  clearChannels();
  resetAuthenticator();
});

/** The bus as `x dev` (or a container) boots it with NATS down, and the sync role over it. */
async function boot(broker: FakeNatsBroker, dev: boolean) {
  const bus = selectBus({
    env: ENV,
    realtime: REALTIME,
    roles: ['web', 'sync', 'worker', 'scheduler'],
    dev,
    select: {
      connect: fakeNatsConnect(broker),
      backoff: { base: 2, max: 2, factor: 1, jitter: 'none' },
      scheduler,
      onError: () => undefined,
      connectWithinMs: 30,
    },
  });
  const running = await bus.start();
  stops.push(() => running.stop());
  const runtime = {
    transport: running.transport,
    presenceTtlMs: bus.presenceTtlMs,
    busTolerated: bus.tolerant,
  };
  // The app's own resolver, answering nobody: an admitted upgrade is then refused 401, not shed.
  configureAuthenticator(async () => null);
  return prepareSync({
    roles: ['sync'],
    port: 0,
    buildId: 'build-1',
    runtime: runtime as unknown as RunningServices,
    routes: [],
    env: {},
  } as StartRolesOptions);
}

describe('the sync role with the bus away', () => {
  test('x dev: the node is mounted and NOT ready, an upgrade is shed 503 with a retry delay, and it starts when the bus answers', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
    const info = spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      const broker = new FakeNatsBroker();
      broker.offline = true;
      const prepared = await boot(broker, true);
      stops.push(() => prepared.stop());

      expect(prepared.node.ready).toBe(false);
      const dial = () =>
        prepared.node.fetch(
          new Request('http://localhost:3000/_x/sync', {
            headers: { origin: 'http://localhost:3000' },
          }),
          takes,
        );
      const shed = await dial();
      expect(shed?.status).toBe(503);
      expect(shed?.headers.get('retry-after-ms')).not.toBeNull();
      // Said once each: the boot's line, and the role's.
      const waiting = warn.mock.calls.filter(([message]) =>
        String(message).startsWith('sync node is waiting for the bus'),
      );
      expect(waiting).toHaveLength(1);
      expect(waiting[0]?.[1]?.['code']).toBe('X_TRANSPORT_UNAVAILABLE');

      broker.offline = false;
      await redial(50, () => prepared.node.ready);
      expect(prepared.node.ready).toBe(true);
      // Past readiness now: the authenticator (which answers null) is what refuses this dial.
      expect((await dial())?.status).toBe(401);
      expect(
        info.mock.calls.filter(([message]) => message === 'sync node started: the bus answered'),
      ).toHaveLength(1);
      expect(
        warn.mock.calls.filter(([message]) =>
          String(message).startsWith('sync node is waiting for the bus'),
        ),
      ).toHaveLength(1);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  test('x dev: stopping while it still waits starts nothing afterwards', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const broker = new FakeNatsBroker();
      broker.offline = true;
      const prepared = await boot(broker, true);
      await prepared.stop();
      broker.offline = false;
      // Every backoff still armed, fired, and the dials it would start given their turns.
      await redial(10);
      expect(prepared.node.ready).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  // The stop `listen()` returns is the one `x dev` keeps, and it never cancelled the wait: the
  // bus's reconnect subscription outlived the node and started it after the role had stopped.
  test('x dev: a LISTENING node stopped while it still waits starts nothing afterwards', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
    const info = spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      const broker = new FakeNatsBroker();
      broker.offline = true;
      const prepared = await boot(broker, true);
      const running = await prepared.listen(null);
      await running.stop();
      broker.offline = false;
      // More rounds than the bus took to start the node in the first test.
      await redial(10, () => prepared.node.ready);
      expect(prepared.node.ready).toBe(false);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  test('a container keeps the hard refusal: the boot fails, coded, inside its wait', async () => {
    const broker = new FakeNatsBroker();
    broker.offline = true;
    const startedAt = performance.now();
    const refused = await boot(broker, false).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(isUltimateError(refused) ? refused.code : refused).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(isUltimateError(refused) ? refused.cause : '').toContain('within 30ms');
  });
});
