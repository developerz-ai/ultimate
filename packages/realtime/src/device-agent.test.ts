// A device agent against a REAL Bun server mounting a `deviceSocket()`: the bearer token rides the
// upgrade's headers, a request from "an action" reaches the device and its answer comes back, and a
// drain's `reconnect` frame sends the agent to redial on the slot it was given.

import { afterEach, describe, expect, test } from 'bun:test';
import { markListening } from '@ultimat3/core';
import { type DeviceAgent, deviceAgent } from './device-agent';
import { deviceActor, ORG_A } from './device-fixture';
import { type DeviceAttachment, type DeviceSocket, deviceSocket } from './device-socket';
import type { DeviceWsData } from './device-upgrade';
import { InProcessTransport } from './fanout';
import type { JsonValue } from './json';

let paths = 0;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function serve(onFrame: (frame: JsonValue) => JsonValue | undefined = () => undefined) {
  paths += 1;
  const link: DeviceSocket = deviceSocket({
    path: `/agent-test-${paths}`,
    resolveToken: (token) =>
      token === 'device-secret' ? { actor: deviceActor('owner', ORG_A), deviceId: 'dev-1' } : null,
    onFrame: ({ frame }) => onFrame(frame),
    heartbeatMs: 1_000,
  });
  const attachment: DeviceAttachment = await link.attach({
    transport: new InProcessTransport(),
    serve: true,
    lifecycle: false,
  });
  const server = Bun.serve<DeviceWsData>({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request, srv) => link.fetch(request, srv),
    websocket: link.websocket,
  });
  const release = markListening(server.url.origin);
  cleanups.push(() => {
    attachment.stop();
    release();
    server.stop(true);
  });
  const url = `ws://127.0.0.1:${server.port}${link.path}`;
  return { link, attachment, url, http: `http://127.0.0.1:${server.port}${link.path}` };
}

/** Resolves once `link` holds `count` sockets — asked on each agent event, never on a timer. */
function connected(link: DeviceSocket, count: number, agent: () => DeviceAgent): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (link.connected === count && agent().connected) resolve();
      else queueMicrotask(() => setImmediate(check));
    };
    check();
  });
}

const caller = { actor: deviceActor('caller', ORG_A) };

describe('e2e · a device agent over a real socket', () => {
  test('an upgrade with no token is 401 with the bearer challenge, over real HTTP', async () => {
    const { http } = await serve();
    const response = await fetch(http, {
      headers: { upgrade: 'websocket', connection: 'upgrade' },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  test('a request from the server side is answered by the agent', async () => {
    const { link, url } = await serve();
    const agent = deviceAgent({
      url,
      token: () => 'device-secret',
      onRequest: (frame) => ({ got: frame }),
    });
    cleanups.push(() => agent.close());
    await connected(link, 1, () => agent);
    expect(await link.request(caller, 'dev-1', { cmd: 'status' })).toEqual({
      got: { cmd: 'status' },
    });
  });

  test("the agent's frame reaches onFrame and the answer comes back", async () => {
    const { link, url } = await serve((frame) => ({ ack: frame }));
    const answers: JsonValue[] = [];
    let heard: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      heard = resolve;
    });
    const agent = deviceAgent({
      url,
      token: () => 'device-secret',
      onRequest: () => null,
      onFrame: (frame) => {
        answers.push(frame);
        heard();
      },
    });
    cleanups.push(() => agent.close());
    await connected(link, 1, () => agent);
    expect(agent.send({ temp: 21 })).toBe(true);
    await answered;
    expect(answers).toEqual([{ ack: { temp: 21 } }]);
  });

  test('a drain sends the agent away and it redials on its slot', async () => {
    const { link, url, attachment } = await serve();
    let dials = 0;
    const agent = deviceAgent({
      url,
      token: () => {
        dials += 1;
        return 'device-secret';
      },
      onRequest: () => null,
    });
    cleanups.push(() => agent.close());
    await connected(link, 1, () => agent);
    await attachment.drain({ graceMs: 0, spreadMs: 20 });
    // The drain stopped accepting for good on this node; a fresh attach is the "next node".
    attachment.stop();
    const next = await link.attach({
      transport: new InProcessTransport(),
      serve: true,
      lifecycle: false,
    });
    cleanups.push(() => next.stop());
    await connected(link, 1, () => agent);
    expect(dials).toBeGreaterThanOrEqual(2);
  });
});

describe('unit · a device agent closed mid-dial', () => {
  test('close() while the token is still being fetched dials nothing', async () => {
    let release: (token: string) => void = () => undefined;
    const token = new Promise<string>((resolve) => {
      release = resolve;
    });
    let dials = 0;
    const agent = deviceAgent({
      url: 'ws://device.test/link',
      token: () => token,
      onRequest: () => null,
      dial: () => {
        dials += 1;
        return { send() {}, close() {}, onopen: null, onmessage: null, onclose: null };
      },
    });
    agent.close();
    release('device-secret');
    await token;
    await Promise.resolve();
    expect(dials).toBe(0);
    expect(agent.connected).toBe(false);
  });
});
