// Two nodes on one bus: a device held by one is addressed from the other, a newer socket on the
// other closes the first's, and no request is left pending after a timeout or a stop.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { DeviceBus } from './device-bus';
import { deviceActor, fakeWs, manualScheduler, ORG_A, ORG_B, testClock } from './device-fixture';
import { DeviceHost } from './device-host';
import { TransportUnavailableError } from './errors';
import { InProcessTransport, type TransportHandler, type TransportSubscription } from './fanout';
import { PrincipalSockets } from './principal-sockets';

const PATH = '/link';

const flush = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not coded';
  }
  return expect.unreachable('the request resolved');
};

async function fleet() {
  const clock = testClock();
  const timers = manualScheduler(clock);
  const transport = new InProcessTransport({ clock });
  let ids = 0;
  const newId = () => `id${ids++}`;
  const nodeOf = async (nodeId: string, serves: boolean) => {
    const bus = new DeviceBus({
      transport,
      path: PATH,
      nodeId,
      schedule: timers.schedule,
      clock,
      newId,
    });
    const host = serves
      ? new DeviceHost({
          path: PATH,
          heartbeatMs: 10_000,
          onFrame: () => undefined,
          bus,
          principals: new PrincipalSockets(4),
          clock,
          rng: () => 0.5,
          schedule: timers.schedule,
        })
      : null;
    await bus.start(host);
    return { bus, host };
  };
  return { timers, nodeOf, transport };
}

const data = (socketId: string, orgId: string = ORG_A) => ({
  socketId,
  grant: { actor: deviceActor('owner', orgId), deviceId: 'dev-1' },
  tenant: orgId,
});

describe('unit · addressing a device across nodes', () => {
  test('a worker with no sockets reaches a device held by a web node', async () => {
    const { nodeOf } = await fleet();
    const web = await nodeOf('web1', true);
    const worker = await nodeOf('worker1', false);
    const ws = fakeWs(data('s1'));
    web.host?.open(ws);
    await flush();
    const answer = worker.bus.request(ORG_A, 'dev-1', { cmd: 'ping' }, 5_000);
    await flush();
    const asked = ws.sent.find((frame) => (frame as { type?: string }).type === 'request') as {
      id: string;
    };
    web.host?.message(ws, JSON.stringify({ type: 'response', id: asked.id, frame: 'pong' }));
    expect(await answer).toBe('pong');
    expect(worker.bus.pendingCount).toBe(0);
  });

  test('the same device id under another tenant is not found, and nothing is sent', async () => {
    const { nodeOf, transport } = await fleet();
    const web = await nodeOf('web1', true);
    const worker = await nodeOf('worker1', false);
    const published: string[] = [];
    const publish = transport.publish.bind(transport);
    transport.publish = (subject, payload) => {
      published.push(payload);
      return publish(subject, payload);
    };
    web.host?.open(fakeWs(data('s1', ORG_A)));
    await flush();
    expect(await codeOf(worker.bus.request(ORG_B, 'dev-1', {}, 5_000))).toBe('X_DEVICE_OFFLINE');
    // Refused at the lookup: the holder is never even asked about another tenant's device.
    expect(published.filter((payload) => payload.includes('"kind":"request"'))).toEqual([]);
  });

  test('a holder asked for a device under another tenant answers offline and sends nothing', async () => {
    const { nodeOf } = await fleet();
    const web = await nodeOf('web1', true);
    const worker = await nodeOf('worker1', false);
    const ws = fakeWs(data('s1', ORG_A));
    web.host?.open(ws);
    await flush();
    const sent = ws.sent.length;
    // A forged request reaching the holder directly, past the lookup the bus does first.
    const answer = worker.bus.request(ORG_A, 'dev-1', {}, 5_000);
    await flush();
    web.host?.onRequest({
      kind: 'request',
      id: 'forged1',
      from: 'worker1',
      tenant: ORG_B,
      deviceId: 'dev-1',
      deadlineMs: 5_000,
      frame: { cmd: 'wipe' },
    });
    await flush();
    const frames = ws.sent.slice(sent) as { frame?: unknown }[];
    expect(frames.map((frame) => frame.frame)).toEqual([{}]);
    void answer.catch(() => undefined);
  });

  test('a newer socket on another node closes the older one', async () => {
    const { nodeOf } = await fleet();
    const one = await nodeOf('web1', true);
    const two = await nodeOf('web2', true);
    const older = fakeWs(data('s1'));
    one.host?.open(older);
    await flush();
    const newer = fakeWs(data('s2'));
    two.host?.open(newer);
    await flush();
    expect(older.closed).toEqual({ code: 1008, reason: 'replaced' });
    expect(newer.closed).toBeNull();
  });

  test('a timed-out request and a stopped bus leave nothing pending', async () => {
    const { nodeOf, timers } = await fleet();
    const web = await nodeOf('web1', true);
    const worker = await nodeOf('worker1', false);
    web.host?.open(fakeWs(data('s1')));
    await flush();
    const timedOut = codeOf(worker.bus.request(ORG_A, 'dev-1', {}, 1_000));
    await flush();
    timers.advance(1_000);
    expect(await timedOut).toBe('X_DEVICE_REQUEST_TIMEOUT');
    const stopped = codeOf(worker.bus.request(ORG_A, 'dev-1', {}, 60_000));
    await flush();
    expect(worker.bus.pendingCount).toBe(1);
    worker.bus.stop();
    expect(await stopped).toBe('X_DEVICE_OFFLINE');
    expect(worker.bus.pendingCount).toBe(0);
    expect(timers.pending).toBe(0);
  });

  test("a closed socket's registration is gone: the next request is offline", async () => {
    const { nodeOf } = await fleet();
    const web = await nodeOf('web1', true);
    const worker = await nodeOf('worker1', false);
    const ws = fakeWs(data('s1'), (closed) => web.host?.close(closed));
    web.host?.open(ws);
    await flush();
    ws.close(1000, 'bye');
    await flush();
    expect(await codeOf(worker.bus.request(ORG_A, 'dev-1', {}, 5_000))).toBe('X_DEVICE_OFFLINE');
  });
});

/** A bus that takes the node subscription and then refuses the claim one, counting what it holds. */
class ClaimRefusingTransport extends InProcessTransport {
  held = 0;
  override async subscribe(
    subject: string,
    handler: TransportHandler,
  ): Promise<TransportSubscription> {
    if (subject.endsWith('.claim')) {
      throw new TransportUnavailableError({ transport: 'test', reason: 'the claim subscribe' });
    }
    const taken = await super.subscribe(subject, handler);
    this.held += 1;
    return {
      subject,
      unsubscribe: () => {
        this.held -= 1;
        taken.unsubscribe();
      },
    };
  }
}

describe('unit · DeviceBus.start refused half-way', () => {
  test('a claim subscribe that throws releases the node subscription it already took', async () => {
    const clock = testClock();
    const transport = new ClaimRefusingTransport({ clock });
    const bus = new DeviceBus({
      transport,
      path: PATH,
      nodeId: 'node-a',
      schedule: manualScheduler(clock).schedule,
      clock,
      newId: () => 'id0',
    });
    const handlers = { onRequest: () => undefined, onClaim: () => undefined };
    expect(await codeOf(bus.start(handlers))).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(transport.held).toBe(0);
  });
});
