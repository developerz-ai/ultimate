// `onOpen`/`onClose` and `disconnect()` across nodes on one bus: the hooks run beside the socket and
// never break it, a disconnect from any node closes the socket where it lives, and a node that dies
// holding a socket still yields exactly one close, from the node that leads the next beat.

import { afterEach, describe, expect, test } from 'bun:test';
import { type Actor, InternalError, memoryErrorReporter } from '@ultimat3/core';
import { installErrorReporter } from '@ultimat3/core/adapter';
import { DeviceBus } from './device-bus';
import { deviceActor, fakeWs, manualScheduler, ORG_A, ORG_B, testClock } from './device-fixture';
import { type DeviceCloseHandler, DeviceHooks, type DeviceOpenHandler } from './device-hooks';
import { DeviceHost } from './device-host';
import { DeviceLedger } from './device-ledger';
import { InProcessTransport } from './fanout';
import { PrincipalSockets } from './principal-sockets';

const PATH = '/link';
const BEAT = 10_000;
const RECORDS = `device.open.${JSON.stringify(PATH)}`;

const flush = async (): Promise<void> => {
  for (let index = 0; index < 200; index += 1) await Promise.resolve();
};

const reporters: (() => void)[] = [];
afterEach(() => {
  for (const uninstall of reporters.splice(0)) uninstall();
});

interface Seen {
  readonly event: 'open' | 'close';
  readonly deviceId: string;
  readonly socketId: string;
  readonly tenant: string;
  readonly actor: Actor;
  readonly reason?: string;
}

async function fleet() {
  const clock = testClock();
  const timers = manualScheduler(clock);
  const transport = new InProcessTransport({ clock });
  const seen: Seen[] = [];
  let ids = 0;
  const newId = () => `id${ids++}`;
  const record: { onOpen: DeviceOpenHandler; onClose: DeviceCloseHandler } = {
    onOpen: ({ device, ctx }) => {
      seen.push({ event: 'open', ...device, actor: ctx.actor });
    },
    onClose: ({ device, ctx, reason }) => {
      seen.push({ event: 'close', ...device, actor: ctx.actor, reason });
    },
  };
  const nodeOf = async (
    nodeId: string,
    options: {
      serves?: boolean;
      onOpen?: DeviceOpenHandler;
      onClose?: DeviceCloseHandler | undefined;
    } = {},
  ) => {
    const bus = new DeviceBus({
      transport,
      path: PATH,
      nodeId,
      schedule: timers.schedule,
      clock,
      newId,
    });
    const onClose = 'onClose' in options ? options.onClose : record.onClose;
    const ledger =
      onClose === undefined
        ? null
        : new DeviceLedger({ transport, path: PATH, nodeId, heartbeatMs: BEAT });
    const hooks = new DeviceHooks({ onOpen: options.onOpen ?? record.onOpen, onClose, ledger });
    const host =
      options.serves === false
        ? null
        : new DeviceHost({
            path: PATH,
            heartbeatMs: BEAT,
            onFrame: ({ frame }) => frame,
            bus,
            principals: new PrincipalSockets(4),
            clock,
            rng: () => 0.5,
            schedule: timers.schedule,
            hooks,
          });
    await ledger?.join();
    await bus.start(host);
    return { bus, host, hooks };
  };
  /** One beat of time, then a sweep on each live node. */
  const beat = async (...hosts: (DeviceHost | null)[]): Promise<void> => {
    timers.advance(BEAT);
    for (const host of hosts) host?.sweep();
    await flush();
  };
  return { nodeOf, beat, seen, transport, timers };
}

const data = (socketId: string, orgId: string = ORG_A, deviceId = 'dev-1') => ({
  socketId,
  grant: { actor: deviceActor('owner', orgId), deviceId },
  tenant: orgId,
});

const closes = (seen: readonly Seen[]) => seen.filter((entry) => entry.event === 'close');

describe('unit · device socket open and close hooks', () => {
  test('a socket yields onOpen then onClose, with its device, actor and reason', async () => {
    const { nodeOf, seen } = await fleet();
    const a = await nodeOf('a');
    const ws = fakeWs(data('s1'), (closed) => a.host?.close(closed));
    a.host?.open(ws);
    await flush();
    ws.close(1000, 'bye');
    await flush();
    expect(
      seen.map((entry) => [entry.event, entry.deviceId, entry.socketId, entry.tenant]),
    ).toEqual([
      ['open', 'dev-1', 's1', ORG_A],
      ['close', 'dev-1', 's1', ORG_A],
    ]);
    expect(seen[0]?.actor.id).toBe('owner');
    expect(seen[1]?.reason).toBe('disconnected');
    expect(a.hooks.pending).toBe(0);
  });

  test("the node's own reason is the one onClose reads", async () => {
    const { nodeOf, seen } = await fleet();
    const a = await nodeOf('a');
    const first = fakeWs(data('s1'), (closed) => a.host?.close(closed));
    a.host?.open(first);
    a.host?.open(fakeWs(data('s2'), (closed) => a.host?.close(closed)));
    await flush();
    expect(first.closed).toEqual({ code: 1008, reason: 'replaced' });
    expect(closes(seen).map((entry) => [entry.socketId, entry.reason])).toEqual([
      ['s1', 'replaced'],
    ]);
  });

  test('onClose waits for a slow onOpen of the same socket', async () => {
    let release: () => void = () => undefined;
    const order: string[] = [];
    const { nodeOf } = await fleet();
    const a = await nodeOf('a', {
      onOpen: () =>
        new Promise<void>((resolve) => {
          release = () => {
            order.push('open');
            resolve();
          };
        }),
      onClose: () => {
        order.push('close');
      },
    });
    const ws = fakeWs(data('s1'), (closed) => a.host?.close(closed));
    a.host?.open(ws);
    ws.close(1000, 'bye');
    await flush();
    expect(order).toEqual([]);
    release();
    await flush();
    expect(order).toEqual(['open', 'close']);
  });

  test('a hook that throws is reported and never takes the socket path down', async () => {
    const reports = memoryErrorReporter();
    reporters.push(installErrorReporter(reports));
    const { nodeOf } = await fleet();
    const a = await nodeOf('a', {
      onOpen: () => {
        throw new InternalError({ cause: 'open hook broke', fix: 'bun run x -- doctor' });
      },
      onClose: async () => {
        throw new InternalError({ cause: 'close hook broke', fix: 'bun run x -- doctor' });
      },
    });
    const ws = fakeWs(data('s1'), (closed) => a.host?.close(closed));
    a.host?.open(ws);
    await flush();
    expect(ws.closed).toBeNull();
    expect(ws.sent[0]).toMatchObject({ type: 'hello' });
    a.host?.message(ws, JSON.stringify({ type: 'frame', frame: { n: 1 } }));
    await flush();
    expect(ws.sent.at(-1)).toEqual({ type: 'frame', frame: { n: 1 } });
    ws.close(1000, 'bye');
    await flush();
    expect(reports.events.map((event) => event.scope.operation)).toEqual([
      'device.on_open',
      'device.on_close',
    ]);
    expect(a.hooks.pending).toBe(0);
  });

  test('no onClose declared: nothing is written to the bus for it', async () => {
    const { nodeOf, transport } = await fleet();
    const a = await nodeOf('a', { onClose: undefined });
    a.host?.open(fakeWs(data('s1')));
    a.host?.sweep();
    await flush();
    expect(await transport.shared.entries(RECORDS)).toEqual([]);
  });
});

describe('unit · disconnect from any node', () => {
  test('a disconnect from another node closes the socket where it lives, with the reason', async () => {
    const { nodeOf, seen } = await fleet();
    const a = await nodeOf('a');
    const worker = await nodeOf('w', { serves: false });
    const ws = fakeWs(data('s1'), (closed) => a.host?.close(closed));
    a.host?.open(ws);
    await flush();
    // No timer moves: the answer is the holder's, never a deadline's.
    expect(await worker.bus.disconnect(ORG_A, 'dev-1', 'revoked', 2_000)).toBe(true);
    expect(ws.closed).toEqual({ code: 1008, reason: 'revoked' });
    await flush();
    expect(closes(seen).map((entry) => entry.reason)).toEqual(['revoked']);
    expect(worker.bus.pendingCount).toBe(0);
  });

  test("another tenant's device, or an unknown one, is offline: false, and nothing closes", async () => {
    const { nodeOf } = await fleet();
    const a = await nodeOf('a');
    const worker = await nodeOf('w', { serves: false });
    const foreign = fakeWs(data('s9', ORG_B), (closed) => a.host?.close(closed));
    a.host?.open(foreign);
    await flush();
    expect(await worker.bus.disconnect(ORG_A, 'dev-1', 'revoked', 2_000)).toBe(false);
    expect(await worker.bus.disconnect(ORG_A, 'nope', 'revoked', 2_000)).toBe(false);
    expect(foreign.closed).toBeNull();
    expect(worker.bus.pendingCount).toBe(0);
  });
});

describe('unit · a node that dies holding sockets', () => {
  test('its socket still yields one close, from the surviving node', async () => {
    const { nodeOf, beat, seen } = await fleet();
    const a = await nodeOf('a');
    const b = await nodeOf('b');
    a.host?.open(fakeWs(data('s1', ORG_A, 'dev-1')));
    await flush();
    await beat(a.host, b.host);
    expect(closes(seen)).toEqual([]);
    // The crash: no close callback, no unregister, no more beats — only silence.
    a.bus.stop();
    for (let index = 0; index < 6; index += 1) await beat(b.host);
    const [lost, ...rest] = closes(seen);
    expect(rest).toEqual([]);
    expect(lost).toMatchObject({ deviceId: 'dev-1', socketId: 's1', tenant: ORG_A });
    expect(lost?.reason).toBe('node lost');
    expect(lost?.actor).toMatchObject({ kind: 'user', id: 'owner', orgId: ORG_A, roles: [] });
  });

  test('a node that only lost its record writes it again, with a second onOpen', async () => {
    const { nodeOf, beat, seen, transport } = await fleet();
    const a = await nodeOf('a');
    const b = await nodeOf('b');
    a.host?.open(fakeWs(data('s1')));
    await flush();
    await transport.shared.drop(RECORDS, 's1');
    for (let index = 0; index < 4; index += 1) await beat(a.host, b.host);
    expect(seen.map((entry) => entry.event)).toEqual(['open', 'open']);
    expect((await transport.shared.entries(RECORDS)).map((entry) => entry.member)).toEqual(['s1']);
  });

  test('a disconnect to a holder that died is X_DEVICE_REQUEST_TIMEOUT at its deadline', async () => {
    const { nodeOf, timers } = await fleet();
    const a = await nodeOf('a');
    const worker = await nodeOf('w', { serves: false });
    a.host?.open(fakeWs(data('s1')));
    await flush();
    a.bus.stop();
    let code = 'pending';
    void worker.bus.disconnect(ORG_A, 'dev-1', 'revoked', 2_000).then(
      () => {
        code = 'resolved';
      },
      (error: { code?: string }) => {
        code = error.code ?? 'not coded';
      },
    );
    await flush();
    timers.advance(1_999);
    await flush();
    expect(code).toBe('pending');
    timers.advance(1);
    await flush();
    expect(code).toBe('X_DEVICE_REQUEST_TIMEOUT');
    expect(worker.bus.pendingCount).toBe(0);
  });
});
